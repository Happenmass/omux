import { randomBytes } from "node:crypto";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ContextManager } from "../core/context-manager.js";
import type { MainAgent } from "../core/main-agent.js";
import type { LLMClient } from "../llm/client.js";
import type { PromptLoader } from "../llm/prompt-loader.js";
import type { MemoryStore } from "../memory/store.js";
import { loadConfig } from "../utils/config.js";
import type { SupportedLocale } from "../utils/locale.js";
import { logger } from "../utils/logger.js";
import type { ChatBroadcaster } from "./chat-broadcaster.js";
import type { CommandDescriptor, CommandRegistry } from "./command-registry.js";
import { t } from "./messages.js";
import type { UiEventStore } from "./ui-events.js";

/** Built-in command descriptors (descriptions localized at construction time). */
function buildBuiltinCommands(locale: SupportedLocale): CommandDescriptor[] {
	return [
		{ name: "stop", description: t("cmd_stop", locale), category: "builtin" },
		{ name: "clear", description: t("cmd_clear", locale), category: "builtin" },
		{ name: "reset", description: t("cmd_reset", locale), category: "builtin" },
		{ name: "compact", description: t("cmd_compact", locale), category: "builtin" },
		{ name: "context", description: t("cmd_context", locale), category: "builtin" },
		{ name: "tidy", description: t("cmd_tidy", locale), category: "builtin" },
		{ name: "autocontinue", description: t("cmd_autocontinue", locale), category: "builtin" },
	];
}

/**
 * Commands that rewrite/clear conversation history via async LLM work while the agent is idle.
 * They run under MainAgent's maintenance lock so user input arriving mid-op queues instead of
 * dispatching concurrently with the rewrite.
 */
const MAINTENANCE_COMMANDS = new Set(["clear", "reset", "compact", "tidy"]);

/** Memory files to review during /tidy */
const TIDY_TARGET_FILES = [
	{ path: "memory/core.md", category: "Architecture decisions, project conventions" },
	{ path: "memory/preferences.md", category: "User preferences, coding style" },
	{ path: "memory/people.md", category: "Team members, roles" },
	{ path: "memory/todos.md", category: "Action items, pending tasks" },
];

interface TidyResult {
	retained: string;
	archived: string;
	summary: string;
}

/**
 * Routes slash commands (/stop, /clear, /reset, /compact, /context, /tidy, /autocontinue) to the
 * appropriate handlers. Commands are dispatched from the WebSocket handler, not
 * through the LLM.
 */
export class CommandRouter {
	private mainAgent: MainAgent;
	private contextManager: ContextManager;
	private broadcaster: ChatBroadcaster;
	private uiEventStore: UiEventStore | null;
	private onReset: (() => Promise<void>) | null;
	private llmClient: LLMClient | null;
	private promptLoader: PromptLoader | null;
	private memoryStore: MemoryStore | null;
	private syncMemory: (() => Promise<void>) | null;
	private locale: SupportedLocale;

	constructor(opts: {
		mainAgent: MainAgent;
		contextManager: ContextManager;
		broadcaster: ChatBroadcaster;
		commandRegistry: CommandRegistry;
		uiEventStore?: UiEventStore;
		onReset?: () => Promise<void>;
		llmClient?: LLMClient;
		promptLoader?: PromptLoader;
		memoryStore?: MemoryStore;
		syncMemory?: () => Promise<void>;
		locale?: SupportedLocale;
	}) {
		this.mainAgent = opts.mainAgent;
		this.contextManager = opts.contextManager;
		this.broadcaster = opts.broadcaster;
		this.uiEventStore = opts.uiEventStore ?? null;
		this.onReset = opts.onReset ?? null;
		this.llmClient = opts.llmClient ?? null;
		this.promptLoader = opts.promptLoader ?? null;
		this.memoryStore = opts.memoryStore ?? null;
		this.syncMemory = opts.syncMemory ?? null;
		this.locale = opts.locale ?? "en-US";

		// Register built-in commands into the central registry
		opts.commandRegistry.registerMany(buildBuiltinCommands(this.locale));
	}

	async handle(name: string): Promise<void> {
		logger.info("command-router", `Handling command: /${name}`);

		// Maintenance commands rewrite/clear history; hold the lock so concurrent user input queues.
		if (MAINTENANCE_COMMANDS.has(name)) {
			await this.mainAgent.runMaintenance(() => Promise.resolve(this.route(name)));
			return;
		}
		await this.route(name);
	}

	private route(name: string): Promise<void> | void {
		switch (name) {
			case "stop":
				return this.handleStop();
			case "clear":
				return this.handleClear();
			case "reset":
				return this.handleReset();
			case "compact":
				return this.handleCompact();
			case "context":
				return this.handleContext();
			case "tidy":
				return this.handleTidy();
			case "autocontinue":
				return this.handleAutoContinue();
			default:
				this.broadcaster.broadcast({
					type: "system",
					message: t("unknown_command", this.locale, { name }),
				});
		}
	}

	private handleStop(): void {
		if (this.mainAgent.state !== "executing") {
			this.broadcaster.broadcast({
				type: "system",
				message: t("not_executing", this.locale),
			});
			return;
		}
		this.mainAgent.requestStop();
		// The MainAgent's executeToolLoop will check isStopRequested between rounds
	}

	private async handleAutoContinue(): Promise<void> {
		// Re-read config from disk so edits to autoContinue.maxConsecutive take effect without a
		// server restart (config is otherwise only read once at startup).
		try {
			const config = await loadConfig();
			this.mainAgent.setAutoContinueMax(config.autoContinue.maxConsecutive);
		} catch (err: any) {
			logger.warn("command-router", `/autocontinue: config reload failed, keeping current limit: ${err.message}`);
		}
		const on = this.mainAgent.setAutoContinueEnabled(!this.mainAgent.isAutoContinueEnabled());
		const max = this.mainAgent.getAutoContinueMax();
		this.broadcaster.broadcast({
			type: "system",
			message: on ? t("autocontinue_on", this.locale, { max }) : t("autocontinue_off", this.locale),
		});
	}

	private async handleClear(): Promise<void> {
		// Stop first if executing
		if (this.mainAgent.state === "executing") {
			this.mainAgent.requestStop();
			await this.mainAgent.waitForIdle();
		}

		// Pre-flight notice: clear() does a memory-flush LLM call that can take seconds
		this.broadcaster.broadcast({
			type: "system",
			message: t("clearing_conversation", this.locale),
		});

		// Clear context (runs memory flush → clears memory → clears SQLite)
		await this.contextManager.clear();
		this.uiEventStore?.clear();

		// Broadcast clear event to all clients (frontend shows the confirmation message)
		this.broadcaster.broadcast({ type: "clear" });

		logger.info("command-router", "Conversation cleared");
	}

	private async handleCompact(): Promise<void> {
		const compactRunId = randomBytes(4).toString("hex");
		const t0 = Date.now();
		logger.info(
			"command-router",
			`[compact ${compactRunId}] /compact entered (mainAgent.state=${this.mainAgent.state}, conv.length=${this.contextManager.getConversationLength()})`,
		);

		// Stop first if executing
		if (this.mainAgent.state === "executing") {
			logger.info(
				"command-router",
				`[compact ${compactRunId}] state=executing → requesting stop and waiting for idle`,
			);
			this.mainAgent.requestStop();
			await this.mainAgent.waitForIdle();
			logger.info("command-router", `[compact ${compactRunId}] reached idle (waited ${Date.now() - t0}ms)`);
		}

		if (this.contextManager.getConversationLength() === 0) {
			logger.info("command-router", `[compact ${compactRunId}] empty conversation → no-op`);
			this.broadcaster.broadcast({
				type: "system",
				message: t("compact_empty", this.locale),
			});
			return;
		}

		this.broadcaster.broadcast({
			type: "system",
			message: t("compact_extracting", this.locale),
		});

		const tFlush = Date.now();
		try {
			await this.contextManager.runMemoryFlush();
			logger.info(
				"command-router",
				`[compact ${compactRunId}] runMemoryFlush() returned in ${Date.now() - tFlush}ms`,
			);
		} catch (err: any) {
			logger.warn(
				"command-router",
				`[compact ${compactRunId}] runMemoryFlush() failed (non-fatal, proceeding to compress): ${err.message}`,
			);
		}

		this.broadcaster.broadcast({
			type: "system",
			message: t("compact_compressing", this.locale),
		});

		const tCompress = Date.now();
		await this.contextManager.compress(compactRunId);
		logger.info(
			"command-router",
			`[compact ${compactRunId}] compress() returned in ${Date.now() - tCompress}ms (total /compact ${Date.now() - t0}ms)`,
		);

		this.broadcaster.broadcast({
			type: "system",
			message: t("compact_done", this.locale),
		});

		logger.info("command-router", `[compact ${compactRunId}] /compact done`);
	}

	private async handleReset(): Promise<void> {
		// Stop first if executing
		if (this.mainAgent.state === "executing") {
			this.mainAgent.requestStop();
			await this.mainAgent.waitForIdle();
		}

		// Pre-flight notice: reset triggers reload + memory-flush LLM call
		this.broadcaster.broadcast({
			type: "system",
			message: t("resetting", this.locale),
		});

		// Reload prompts, skills, tools, and commands
		if (this.onReset) {
			try {
				await this.onReset();
			} catch (err: any) {
				logger.warn("command-router", `Reset reload failed: ${err.message}`);
			}
		}

		// Clear conversation (runs memory flush → clears messages → clears SQLite)
		await this.contextManager.clear();
		this.uiEventStore?.clear();

		// Broadcast clear + system message
		this.broadcaster.broadcast({ type: "clear" });
		this.broadcaster.broadcast({
			type: "system",
			message: t("reset_done", this.locale),
		});

		logger.info("command-router", "System reset complete");
	}

	private handleContext(): void {
		const estimate = this.contextManager.getCurrentTokenEstimate();
		const limit = this.contextManager.getContextWindowLimit();
		const usage = ((estimate / limit) * 100).toFixed(1);
		const messages = this.contextManager.getConversationLength();

		const lines = [
			t("context_title", this.locale),
			t("context_tokens", this.locale, {
				estimate: estimate.toLocaleString(),
				limit: limit.toLocaleString(),
				usage,
			}),
			t("context_messages", this.locale, { count: messages }),
		];

		this.broadcaster.broadcast({
			type: "system",
			message: lines.join("\n"),
		});
	}

	private async handleTidy(): Promise<void> {
		if (!this.llmClient || !this.promptLoader || !this.memoryStore) {
			this.broadcaster.broadcast({
				type: "system",
				message: t("tidy_unavailable", this.locale),
			});
			return;
		}

		// Stop first if executing
		if (this.mainAgent.state === "executing") {
			this.mainAgent.requestStop();
			await this.mainAgent.waitForIdle();
		}

		this.broadcaster.broadcast({
			type: "system",
			message: t("tidy_running", this.locale),
		});

		const today = new Date().toISOString().slice(0, 10);
		const archivePath = `memory/${today}.md`;
		// Backups live OUTSIDE the indexed memory tree (memory/) so a truncated or hallucinated
		// LLM response never silently destroys the only copy of a memory file.
		const backupDir = join(this.memoryStore.getStorageDir(), "memory-backups");
		const summaries: string[] = [];
		let totalArchived = 0;

		for (const target of TIDY_TARGET_FILES) {
			try {
				const absPath = join(this.memoryStore.getStorageDir(), target.path);
				let content: string;
				try {
					content = await readFile(absPath, "utf-8");
				} catch {
					continue; // File doesn't exist, skip
				}

				const originalNonEmpty = content.trim().length > 0;
				if (!originalNonEmpty) continue;

				const systemPrompt = this.promptLoader.resolve("memory-tidy", {
					file_path: target.path,
					category: target.category,
					today,
				});

				const result = await this.llmClient.completeJson<TidyResult>([{ role: "user", content }], {
					systemPrompt,
					temperature: 0,
				});

				// Guard: refuse to overwrite a non-empty file with an empty/whitespace "retained"
				// (a truncated or hallucinated response). Skip and warn instead of destroying it.
				if (result.retained.trim().length === 0) {
					logger.warn(
						"command-router",
						`Tidy ${target.path}: empty retained content against non-empty original — skipping overwrite`,
					);
					summaries.push(t("tidy_file_failed", this.locale, { path: target.path, error: "empty retained" }));
					continue;
				}

				// Back up the original before overwriting.
				try {
					await mkdir(backupDir, { recursive: true });
					const backupPath = join(backupDir, `${today}-${basename(target.path)}`);
					await copyFile(absPath, backupPath);
				} catch (err: any) {
					logger.warn("command-router", `Tidy backup failed for ${target.path}: ${err.message}`);
				}

				// Write retained content back (overwrite)
				await this.memoryStore.write({
					path: target.path,
					content: result.retained,
					mode: "overwrite",
				});

				// Append archived content to daily file
				if (result.archived.trim().length > 0) {
					const archiveHeader = `\n## Archived from ${target.path}\n\n`;
					await this.memoryStore.write({
						path: archivePath,
						content: archiveHeader + result.archived,
					});
					totalArchived++;
				}

				if (result.summary) {
					summaries.push(t("tidy_file_summary", this.locale, { path: target.path, summary: result.summary }));
				}

				logger.info("command-router", `Tidy ${target.path}: ${result.summary}`);
			} catch (err: any) {
				logger.warn("command-router", `Tidy failed for ${target.path}: ${err.message}`);
				summaries.push(t("tidy_file_failed", this.locale, { path: target.path, error: err.message }));
			}
		}

		// Trigger memory sync once after all files are processed
		if (this.syncMemory) {
			try {
				this.memoryStore.markDirty();
				await this.syncMemory();
			} catch (err: any) {
				logger.warn("command-router", `Memory sync after tidy failed: ${err.message}`);
			}
		}

		const resultMessage =
			summaries.length > 0
				? t("tidy_done", this.locale, {
						summaries:
							summaries.join("\n") +
							(totalArchived > 0 ? `\n${t("tidy_archived_file", this.locale, { path: archivePath })}` : ""),
					})
				: t("tidy_empty", this.locale);

		this.broadcaster.broadcast({
			type: "system",
			message: resultMessage,
		});

		logger.info("command-router", "Memory tidy complete");
	}
}
