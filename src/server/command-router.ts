import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ContextManager } from "../core/context-manager.js";
import type { MainAgent } from "../core/main-agent.js";
import type { SignalRouter } from "../core/signal-router.js";
import type { LLMClient } from "../llm/client.js";
import type { PromptLoader } from "../llm/prompt-loader.js";
import type { MemoryStore } from "../memory/store.js";
import { logger } from "../utils/logger.js";
import type { ChatBroadcaster } from "./chat-broadcaster.js";
import type { CommandDescriptor, CommandRegistry } from "./command-registry.js";
import type { UiEventStore } from "./ui-events.js";

/** Built-in command descriptors registered at construction time */
const BUILTIN_COMMANDS: CommandDescriptor[] = [
	{ name: "stop", description: "停止当前执行任务", category: "builtin" },
	{ name: "resume", description: "恢复上次中断的执行", category: "builtin" },
	{ name: "clear", description: "清空对话历史", category: "builtin" },
	{ name: "reset", description: "重置对话并重新加载提示词和技能", category: "builtin" },
	{ name: "compact", description: "压缩对话历史并注入系统提示词", category: "builtin" },
	{ name: "context", description: "查看上下文用量", category: "builtin" },
	{ name: "tidy", description: "整理记忆文件，归档过时条目", category: "builtin" },
];

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
 * Routes slash commands (/stop, /resume, /clear, /tidy) to the appropriate handlers.
 * Commands are dispatched from the WebSocket handler, not through the LLM.
 */
export class CommandRouter {
	private mainAgent: MainAgent;
	private signalRouter: SignalRouter;
	private contextManager: ContextManager;
	private broadcaster: ChatBroadcaster;
	private uiEventStore: UiEventStore | null;
	private onReset: (() => Promise<void>) | null;
	private llmClient: LLMClient | null;
	private promptLoader: PromptLoader | null;
	private memoryStore: MemoryStore | null;
	private syncMemory: (() => Promise<void>) | null;

	constructor(opts: {
		mainAgent: MainAgent;
		signalRouter: SignalRouter;
		contextManager: ContextManager;
		broadcaster: ChatBroadcaster;
		commandRegistry: CommandRegistry;
		uiEventStore?: UiEventStore;
		onReset?: () => Promise<void>;
		llmClient?: LLMClient;
		promptLoader?: PromptLoader;
		memoryStore?: MemoryStore;
		syncMemory?: () => Promise<void>;
	}) {
		this.mainAgent = opts.mainAgent;
		this.signalRouter = opts.signalRouter;
		this.contextManager = opts.contextManager;
		this.broadcaster = opts.broadcaster;
		this.uiEventStore = opts.uiEventStore ?? null;
		this.onReset = opts.onReset ?? null;
		this.llmClient = opts.llmClient ?? null;
		this.promptLoader = opts.promptLoader ?? null;
		this.memoryStore = opts.memoryStore ?? null;
		this.syncMemory = opts.syncMemory ?? null;

		// Register built-in commands into the central registry
		opts.commandRegistry.registerMany(BUILTIN_COMMANDS);
	}

	async handle(name: string): Promise<void> {
		logger.info("command-router", `Handling command: /${name}`);

		switch (name) {
			case "stop":
				return this.handleStop();
			case "resume":
				return this.handleResume();
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
			default:
				this.broadcaster.broadcast({
					type: "system",
					message: `未知指令: /${name}`,
				});
		}
	}

	private handleStop(): void {
		if (this.mainAgent.state !== "executing") {
			this.broadcaster.broadcast({
				type: "system",
				message: "当前未在执行任务",
			});
			return;
		}
		this.signalRouter.stop();
		// The MainAgent's executeToolLoop will check isStopRequested between rounds
	}

	private async handleResume(): Promise<void> {
		if (this.mainAgent.state === "executing") {
			this.broadcaster.broadcast({
				type: "system",
				message: "当前已在执行中",
			});
			return;
		}
		await this.mainAgent.handleResume();
	}

	private async handleClear(): Promise<void> {
		// Stop first if executing
		if (this.mainAgent.state === "executing") {
			this.signalRouter.stop();
			await this.mainAgent.waitForIdle();
		}

		// Clear context (runs memory flush → clears memory → clears SQLite)
		await this.contextManager.clear();
		this.uiEventStore?.clear();

		// Broadcast clear event to all clients (frontend shows the confirmation message)
		this.broadcaster.broadcast({ type: "clear" });

		logger.info("command-router", "Conversation cleared");
	}

	private async handleCompact(): Promise<void> {
		// Stop first if executing
		if (this.mainAgent.state === "executing") {
			this.signalRouter.stop();
			await this.mainAgent.waitForIdle();
		}

		if (this.contextManager.getConversationLength() === 0) {
			this.broadcaster.broadcast({
				type: "system",
				message: "当前没有对话内容，无需压缩",
			});
			return;
		}

		this.broadcaster.broadcast({
			type: "system",
			message: "正在压缩对话历史...",
		});

		await this.contextManager.compress();

		this.broadcaster.broadcast({
			type: "system",
			message: "对话历史已压缩并注入系统提示词",
		});

		logger.info("command-router", "Conversation compacted via /compact command");
	}

	private async handleReset(): Promise<void> {
		// Stop first if executing
		if (this.mainAgent.state === "executing") {
			this.signalRouter.stop();
			await this.mainAgent.waitForIdle();
		}

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
			message: "系统已重置：对话已清空，提示词和技能已重新加载",
		});

		logger.info("command-router", "System reset complete");
	}

	private handleContext(): void {
		const estimate = this.contextManager.getCurrentTokenEstimate();
		const limit = this.contextManager.getContextWindowLimit();
		const usage = ((estimate / limit) * 100).toFixed(1);
		const messages = this.contextManager.getConversationLength();

		const lines = [
			`📊 上下文用量`,
			`Token 估算: ${estimate.toLocaleString()} / ${limit.toLocaleString()} (${usage}%)`,
			`对话消息数: ${messages}`,
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
				message: "记忆整理不可用：缺少 LLM 或记忆存储配置",
			});
			return;
		}

		// Stop first if executing
		if (this.mainAgent.state === "executing") {
			this.signalRouter.stop();
			await this.mainAgent.waitForIdle();
		}

		this.broadcaster.broadcast({
			type: "system",
			message: "正在整理记忆文件...",
		});

		const today = new Date().toISOString().slice(0, 10);
		const archivePath = `memory/${today}.md`;
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

				if (content.trim().length === 0) continue;

				const systemPrompt = this.promptLoader.resolve("memory-tidy", {
					file_path: target.path,
					category: target.category,
					today,
				});

				const result = await this.llmClient.completeJson<TidyResult>([{ role: "user", content }], {
					systemPrompt,
					temperature: 0,
				});

				// Write retained content back (overwrite)
				if (result.retained.trim().length > 0) {
					await this.memoryStore.write({
						path: target.path,
						content: result.retained,
						mode: "overwrite",
					});
				}

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
					summaries.push(`${target.path}: ${result.summary}`);
				}

				logger.info("command-router", `Tidy ${target.path}: ${result.summary}`);
			} catch (err: any) {
				logger.warn("command-router", `Tidy failed for ${target.path}: ${err.message}`);
				summaries.push(`${target.path}: 处理失败 - ${err.message}`);
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
				? `记忆整理完成：\n${summaries.join("\n")}${totalArchived > 0 ? `\n归档文件: ${archivePath}` : ""}`
				: "记忆文件为空，无需整理";

		this.broadcaster.broadcast({
			type: "system",
			message: resultMessage,
		});

		logger.info("command-router", "Memory tidy complete");
	}
}
