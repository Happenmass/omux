import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AgentAdapter } from "../agents/adapter.js";
import type { LLMClient } from "../llm/client.js";
import type { PromptLoader } from "../llm/prompt-loader.js";
import type { MessageContent, ThinkingLevel, ToolCallContent } from "../llm/types.js";
import { isMemoryPath, type MemoryStore } from "../memory/store.js";
import type { EmbeddingProvider, HybridSearchConfig } from "../memory/types.js";
import type { AgentStore } from "../persistence/agent-store.js";
import type { ChatBroadcaster } from "../server/chat-broadcaster.js";
import { t } from "../server/messages.js";
import type { UiEvent, UiEventStore, UiEventType } from "../server/ui-events.js";
import type { SkillRegistry } from "../skills/registry.js";
import type { TmuxBridge } from "../tmux/bridge.js";
import type { StateDetector } from "../tmux/state-detector.js";
import { getLanguageInstruction, type SupportedLocale } from "../utils/locale.js";
import { logger } from "../utils/logger.js";
import { AgentMonitor } from "./agent-monitor.js";
import type { ChangeTracker } from "./change-tracker.js";
import type { ContextManager } from "./context-manager.js";
import type { LearningPipeline } from "./learning-pipeline.js";
import type { PromptTracker } from "./prompt-tracker.js";
import { buildToolHandlers, TOOL_DEFINITIONS, type ToolContext, type ToolHandler } from "./tools/index.js";
import { type AgentEvent, WorkQueue } from "./work-queue.js";

// ─── Types ──────────────────────────────────────────────

export type AgentState = "idle" | "executing";

export interface AgentEntry {
	paneTarget: string;
	workingDir: string;
	/** Resolved model the agent was launched with (e.g. "opus"). Undefined for legacy/restored entries. */
	model?: string;
	/** Adapter name this agent was launched with (e.g. "claude-code"). Undefined → resolves to the default adapter. */
	adapter?: string;
}

export interface MainAgentEvents {
	state_change: [state: AgentState];
	log: [message: string];
}

// ─── MainAgent ──────────────────────────────────────────

export class MainAgent extends EventEmitter<MainAgentEvents> {
	private contextManager: ContextManager;
	private llmClient: LLMClient;
	/** Active adapters keyed by name; an agent's launch adapter is recorded in its AgentEntry. */
	private adapters: Map<string, AgentAdapter>;
	/** Adapter used by create_agent when no `adapter` is specified. */
	private defaultAdapterName: string;
	private bridge: TmuxBridge;
	private stateDetector: StateDetector;
	private broadcaster: ChatBroadcaster;
	private uiEventStore: UiEventStore | null = null;
	private workQueue = new WorkQueue();
	private isDispatching = false;
	/**
	 * Held while an exclusive maintenance op (compaction / clear / reset / tidy) runs. The agent's
	 * `state` is "idle" during these (they only start once idle), so without this flag a user message
	 * arriving mid-op would dispatch concurrently with the history rewrite. While set, handleMessage
	 * queues instead of dispatching; the queue is drained when the lock is released.
	 */
	private maintenanceInProgress = false;
	private agents: Map<string, AgentEntry> = new Map();
	private activeAgentId: string | null = null;
	private takenOverAgents = new Set<string>();
	private memoryStore: MemoryStore | null = null;
	private syncMemory: (() => Promise<void>) | null = null;
	private embeddingProvider: EmbeddingProvider | null = null;
	private skillRegistry: SkillRegistry | null = null;
	private debug: boolean;
	private thinking: ThinkingLevel;
	private promptTracker: PromptTracker | undefined;
	private learningPipeline: LearningPipeline | undefined;
	private changeTracker: ChangeTracker | undefined;
	private firstLLMCall = true;
	private execCommandBroadcastCount = 0;
	private agentMonitor: AgentMonitor | null = null;
	private agentStore: AgentStore | null = null;
	private globalDir: string;
	private workspaceDir: string;
	private createAgentSettleMs: number;
	private promptLoader: PromptLoader | null = null;
	private locale: SupportedLocale = "en-US";
	private autoContinueEnabled = false;
	private autoContinueMax = 10;
	private autoContinueCount = 0;
	/**
	 * The most recent *real* user instruction. Set only in handleMessage (auto-continue driverText
	 * bypasses it via enqueueUserMessage), so it stays pinned to the human's original ask across an
	 * entire auto-continue streak — giving the gate the goal context to judge "is this what they
	 * asked for, and is there more of it left?" alongside the agent's final output.
	 */
	private lastUserInstruction = "";
	private searchConfig: HybridSearchConfig = {
		enabled: true,
		vectorWeight: 0.7,
		textWeight: 0.3,
		candidateMultiplier: 3,
		temporalDecay: { enabled: true, halfLifeDays: 30 },
	};

	// ─── Tool dispatch ─────────────────────────────────
	// Built-in tool handlers keyed by tool name (built once at construction). Skill-declared
	// tools are NOT in here — they fall through executeTool's default path to the registry.
	private readonly toolHandlers: Map<string, ToolHandler> = buildToolHandlers();
	// Live facade over this MainAgent handed to every handler. Reads `this.*` on each access,
	// so post-construction mutations (tests set agentMonitor/workQueue/skillRegistry directly)
	// are visible to handlers.
	private readonly toolCtx: ToolContext = this.buildToolContext();

	// ─── State Machine ─────────────────────────────────
	state: AgentState = "idle";

	// ─── Execution control (stop latch) ────────────────
	// Formerly owned by SignalRouter — the latch was that class's only live
	// responsibility, so it lives here now, next to the loop that consumes it.
	private stopRequested = false;

	/**
	 * Request stop: the EXECUTING self-loop checks this after the current tool
	 * round completes and returns to idle when set.
	 */
	requestStop(): void {
		this.stopRequested = true;
		logger.info("main-agent", "Stop requested — will pause after current tool round");
		this.emit("log", "Stop requested — will pause after current tool round");
	}

	/** Clear the stop flag and allow execution to continue. */
	clearStopRequest(): void {
		this.stopRequested = false;
	}

	/** Check whether a stop has been requested. */
	isStopRequested(): boolean {
		return this.stopRequested;
	}

	getPendingUserMessageCount(): number {
		return this.workQueue.pendingUserMessages();
	}

	constructor(opts: {
		contextManager: ContextManager;
		llmClient: LLMClient;
		/** Single adapter (back-compat). Provide this OR `adapters`. */
		adapter?: AgentAdapter;
		/** Active adapters keyed by name. Takes precedence over `adapter` when provided. */
		adapters?: Map<string, AgentAdapter>;
		/** Name of the default adapter within `adapters`. Defaults to the first entry. */
		defaultAdapter?: string;
		bridge: TmuxBridge;
		stateDetector: StateDetector;
		broadcaster: ChatBroadcaster;
		uiEventStore?: UiEventStore;
		memoryStore?: MemoryStore;
		syncMemory?: () => Promise<void>;
		embeddingProvider?: EmbeddingProvider | null;
		searchConfig?: Partial<HybridSearchConfig>;
		skillRegistry?: SkillRegistry;
		agentStore?: AgentStore;
		globalDir?: string;
		workspaceDir?: string;
		debug?: boolean;
		promptTracker?: PromptTracker;
		learningPipeline?: LearningPipeline;
		changeTracker?: ChangeTracker;
		thinking?: ThinkingLevel;
		createAgentSettleMs?: number;
		promptLoader?: PromptLoader;
		locale?: SupportedLocale;
		autoContinue?: { enabled: boolean; maxConsecutive: number };
	}) {
		super();
		this.contextManager = opts.contextManager;
		this.llmClient = opts.llmClient;
		// Resolve the active adapter set. `adapters` (map) wins; otherwise wrap the single
		// back-compat `adapter`. Exactly one of the two must be provided.
		if (opts.adapters && opts.adapters.size > 0) {
			this.adapters = opts.adapters;
			this.defaultAdapterName = opts.defaultAdapter ?? opts.adapters.keys().next().value!;
		} else if (opts.adapter) {
			this.adapters = new Map([[opts.adapter.name, opts.adapter]]);
			this.defaultAdapterName = opts.adapter.name;
		} else {
			throw new Error("MainAgent requires either `adapter` or a non-empty `adapters` map");
		}
		this.bridge = opts.bridge;
		this.stateDetector = opts.stateDetector;
		this.broadcaster = opts.broadcaster;
		this.uiEventStore = opts.uiEventStore ?? null;
		this.memoryStore = opts.memoryStore ?? null;
		this.syncMemory = opts.syncMemory ?? null;
		this.embeddingProvider = opts.embeddingProvider ?? null;
		this.skillRegistry = opts.skillRegistry ?? null;
		this.agentStore = opts.agentStore ?? null;
		this.globalDir = opts.globalDir ?? "";
		this.workspaceDir = opts.workspaceDir ?? "";
		this.debug = opts.debug ?? false;
		this.thinking = opts.thinking ?? "off";
		this.promptTracker = opts.promptTracker;
		this.learningPipeline = opts.learningPipeline;
		this.changeTracker = opts.changeTracker;
		this.createAgentSettleMs = opts.createAgentSettleMs ?? 10_000;
		this.promptLoader = opts.promptLoader ?? null;
		this.locale = opts.locale ?? "en-US";
		this.autoContinueEnabled = opts.autoContinue?.enabled ?? false;
		this.autoContinueMax = opts.autoContinue?.maxConsecutive ?? 10;
		logger.info(
			"main-agent:autocontinue",
			`Auto-continue mode ${this.autoContinueEnabled ? "enabled" : "disabled"} at startup (maxConsecutive=${this.autoContinueMax})`,
		);
		if (opts.searchConfig) {
			this.searchConfig = { ...this.searchConfig, ...opts.searchConfig };
		}
		logger.info("main-agent", `Thinking level: ${this.thinking}`);
		console.log(`[cliclaw] Thinking level: ${this.thinking}`);

		// Hand the effective LLM tuning to ContextManager so `compress()` can ride the same
		// chain (and thus the same prompt-cache prefix + L2 incremental window) as the main
		// session's regular turns. Skipping this just means compaction falls back to the legacy
		// separate-completion path — non-fatal but every compact then costs full input tokens.
		this.contextManager.setCompactTuning({
			tools: TOOL_DEFINITIONS,
			thinking: this.thinking,
		});
	}

	/** Toggle auto-continue mode at runtime (used by the /autocontinue command). Returns the new state. */
	setAutoContinueEnabled(on: boolean): boolean {
		this.autoContinueEnabled = on;
		logger.info(
			"main-agent:autocontinue",
			`Auto-continue mode ${on ? "enabled" : "disabled"} via runtime toggle (streak=${this.autoContinueCount}/${this.autoContinueMax})`,
		);
		return this.autoContinueEnabled;
	}

	isAutoContinueEnabled(): boolean {
		return this.autoContinueEnabled;
	}

	/** Current consecutive-auto-continue cap. */
	getAutoContinueMax(): number {
		return this.autoContinueMax;
	}

	/**
	 * Update the consecutive-auto-continue cap at runtime. Used by /autocontinue to pick up edits to
	 * config.autoContinue.maxConsecutive without a server restart. Invalid values (non-positive,
	 * non-integer) are ignored and the current cap is kept. Returns the effective cap.
	 */
	setAutoContinueMax(max: number): number {
		if (Number.isInteger(max) && max > 0) {
			if (max !== this.autoContinueMax) {
				logger.info("main-agent:autocontinue", `maxConsecutive updated ${this.autoContinueMax} → ${max} (runtime)`);
			}
			this.autoContinueMax = max;
		} else {
			logger.warn(
				"main-agent:autocontinue",
				`Ignored invalid maxConsecutive=${max}; keeping ${this.autoContinueMax}`,
			);
		}
		return this.autoContinueMax;
	}

	/** Replace the skill registry at runtime (used by /reset). */
	setSkillRegistry(registry: SkillRegistry): void {
		this.skillRegistry = registry;
	}

	private onAgentChange: (() => void) | null = null;

	/** Register a callback invoked whenever agents are created/exited/killed. */
	setOnAgentChange(cb: () => void): void {
		this.onAgentChange = cb;
	}

	/** Return all active agents with their current status. */
	/** Resolve the adapter an agent was launched with, falling back to the default adapter. */
	private adapterFor(entry: AgentEntry): AgentAdapter {
		const name = entry.adapter ?? this.defaultAdapterName;
		return (
			this.adapters.get(name) ?? this.adapters.get(this.defaultAdapterName) ?? this.adapters.values().next().value!
		);
	}

	getActiveAgents(): Array<{
		agentName: string;
		agentId: string;
		paneTarget: string;
		workingDir: string;
		status: string;
		takenOver: boolean;
		adapter: string;
		model: string;
	}> {
		const result: Array<{
			agentName: string;
			agentId: string;
			paneTarget: string;
			workingDir: string;
			status: string;
			takenOver: boolean;
			adapter: string;
			model: string;
		}> = [];
		for (const [id, entry] of this.agents) {
			const task = this.agentMonitor?.getTask(id);
			let status: string;
			if (task?.status === "running") {
				status = "active";
			} else if (task?.status === "waiting_input") {
				status = "waiting_input";
			} else {
				status = "idle";
			}
			const entryAdapter = this.adapterFor(entry);
			result.push({
				agentName: id,
				agentId: id,
				paneTarget: entry.paneTarget,
				workingDir: entry.workingDir,
				status,
				takenOver: this.takenOverAgents.has(id),
				adapter: entryAdapter.displayName,
				model: entry.model ?? entryAdapter.defaultModel,
			});
		}
		return result;
	}

	/** Mark or unmark an agent as human-taken-over. */
	setTakenOver(agentId: string, takenOver: boolean): void {
		if (!this.agents.has(agentId)) return;
		if (takenOver) {
			this.takenOverAgents.add(agentId);
		} else {
			this.takenOverAgents.delete(agentId);
		}
		this.agentStore?.setTakenOver(agentId, takenOver);
		this.onAgentChange?.();
	}

	/** Check if an agent is human-taken-over. */
	isTakenOver(agentId: string): boolean {
		return this.takenOverAgents.has(agentId);
	}

	/** Get the pane target for an agent (used by ws-handler for terminal input). */
	getAgentPaneTarget(agentId: string): string | undefined {
		return this.agents.get(agentId)?.paneTarget;
	}

	/**
	 * Restore a persisted agent into the in-memory agents map.
	 * Called during startup after verifying the tmux session is still alive.
	 * The most recently restored agent becomes the active agent.
	 */
	restoreAgent(agentId: string, entry: AgentEntry, takenOver = false): void {
		this.agents.set(agentId, entry);
		this.activeAgentId = agentId;
		if (takenOver) {
			this.takenOverAgents.add(agentId);
		}
		logger.info(
			"main-agent",
			`Restored agent: ${agentId}, pane: ${entry.paneTarget}, cwd: ${entry.workingDir}${takenOver ? " (taken over)" : ""}`,
		);
	}

	setupAgentMonitor(): void {
		this.agentMonitor = new AgentMonitor({
			stateDetector: this.stateDetector,
			bridge: this.bridge,
			workQueue: this.workQueue,
		});

		this.workQueue.on("item_available", () => {
			if (this.state === "idle" && !this.isDispatching && !this.maintenanceInProgress) {
				queueMicrotask(() => this.dispatchNext());
			}
		});
	}

	shutdownMonitor(): void {
		this.agentMonitor?.shutdown();
	}

	setPaneTarget(paneTarget: string, agentId = "_default"): void {
		this.agents.set(agentId, { paneTarget, workingDir: process.cwd() });
		this.activeAgentId = agentId;
	}

	getPaneTarget(): string | null {
		if (!this.activeAgentId) return null;
		return this.agents.get(this.activeAgentId)?.paneTarget ?? null;
	}

	getAgentWorkingDir(): string {
		if (!this.activeAgentId) return process.cwd();
		return this.agents.get(this.activeAgentId)?.workingDir ?? process.cwd();
	}

	/**
	 * Read the shared `tasks.txt` checklist(s) the sub-agents maintain (see the MainAgent prompt's
	 * "traceable, transferable execution" section). Feeds the auto-continue gate an explicit source
	 * of truth for "what's left" instead of letting it infer from the final message alone. Reads
	 * tasks.txt from every known agent's working dir (falling back to the active dir when no agent
	 * exists); missing files are skipped, and content is capped to keep the gate prompt lean.
	 */
	private async readTaskList(maxChars = 6000): Promise<string> {
		// Normalize working dirs before de-duping: agents share one tasks.txt per project,
		// and `resolve` collapses trailing-slash / relative / `.` variants so the same file
		// is never read (and injected) twice.
		const dirs = new Set<string>();
		for (const a of this.agents.values()) dirs.add(resolve(a.workingDir));
		if (dirs.size === 0) dirs.add(resolve(this.getAgentWorkingDir()));

		const blocks: string[] = [];
		for (const dir of dirs) {
			try {
				const path = join(dir, "tasks.txt");
				let text = (await readFile(path, "utf-8")).trim();
				if (!text) continue;
				if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n…(tasks.txt truncated)…`;
				blocks.push(dirs.size > 1 ? `# ${path}\n${text}` : text);
			} catch {
				// No tasks.txt in this working dir — skip.
			}
		}
		return blocks.length > 0
			? blocks.join("\n\n")
			: "(no tasks.txt found — the sub-agents may not be maintaining one for this task)";
	}

	private resolveAgent(agentId?: string): { entry: AgentEntry; id: string } | { error: string } {
		const id = agentId ?? this.activeAgentId;
		if (!id) {
			return { error: "No active agent. Call create_agent first." };
		}
		const entry = this.agents.get(id);
		if (!entry) {
			return {
				error: `Agent "${id}" not found. Use list_agents to see available agents.`,
			};
		}
		if (this.takenOverAgents.has(id)) {
			return {
				error: `Agent "${id}" 已被人工接管，无法自动操作。请先在 Web UI 释放该会话。`,
			};
		}
		return { entry, id };
	}

	/** Remove an agent from all registries. Caller is responsible for onAgentChange(). */
	private cleanupAgent(id: string): void {
		this.agentMonitor?.cleanup(id);
		this.workQueue.removeAgentEventsByAgentId(id);
		this.agents.delete(id);
		this.agentStore?.deleteAgent(id);
		if (this.activeAgentId === id) {
			const remaining = [...this.agents.keys()];
			this.activeAgentId = remaining.length > 0 ? remaining[remaining.length - 1] : null;
		}
	}

	async waitForIdle(): Promise<void> {
		if (this.state === "idle") return;

		await new Promise<void>((resolve) => {
			const onStateChange = (state: AgentState) => {
				if (state !== "idle") return;
				this.off("state_change", onStateChange);
				resolve();
			};
			this.on("state_change", onStateChange);
		});
	}

	/** True while an exclusive maintenance op (compaction/clear/reset/tidy) holds the agent. */
	isMaintenanceInProgress(): boolean {
		return this.maintenanceInProgress;
	}

	/**
	 * Run an exclusive maintenance task (compaction, clear, reset, memory tidy) under a lock that
	 * makes incoming user messages queue rather than dispatch. The queue is drained once the task
	 * completes. The caller is responsible for first bringing the agent to idle (stop + waitForIdle)
	 * if it was executing — typically done inside `fn`. Auto-compaction inside the executing loop is
	 * already covered by the EXECUTING state and does not need this.
	 */
	async runMaintenance<T>(fn: () => Promise<T>): Promise<T> {
		this.maintenanceInProgress = true;
		this.broadcastState();
		try {
			return await fn();
		} finally {
			this.maintenanceInProgress = false;
			this.broadcastState();
			// Drain anything that queued up while the lock was held.
			if (!this.workQueue.isEmpty() && this.state === "idle") {
				queueMicrotask(() => this.dispatchNext());
			}
		}
	}

	// ─── State Management ──────────────────────────────

	private setState(newState: AgentState): void {
		if (this.state !== newState) {
			this.state = newState;
			this.broadcastState();
			this.emit("state_change", newState);
			logger.info("main-agent", `State: ${newState}`);

			if (newState === "idle") {
				queueMicrotask(() => this.dispatchNext());
			}
		}
	}

	private broadcastState(): void {
		this.broadcaster.broadcast({
			type: "state",
			// Surface maintenance (compaction/clear/reset/tidy) as "executing" so the UI shows busy
			// while the agent queues incoming input. Internally the state stays "idle".
			state: this.maintenanceInProgress ? "executing" : this.state,
			queueSize: this.workQueue.pendingUserMessages(),
			contextUsage: this.getContextUsage(),
		});
	}

	getContextUsage(): { tokens: number; limit: number } {
		return {
			tokens: this.contextManager.getCurrentTokenEstimate(),
			limit: this.contextManager.getContextWindowLimit(),
		};
	}

	private broadcastAssistantDone(): void {
		this.broadcaster.broadcast({
			type: "assistant_done",
			contextUsage: this.getContextUsage(),
		});
	}

	// ─── handleMessage — main entry point ──────────────

	async handleMessage(content: string): Promise<void> {
		// A real user message ends any auto-continue streak.
		if (this.autoContinueCount > 0) {
			logger.info(
				"main-agent:autocontinue",
				`Streak reset (${this.autoContinueCount} → 0): real user message received`,
			);
		}
		this.autoContinueCount = 0;
		this.lastUserInstruction = content;
		this.workQueue.enqueueUserMessage(content);

		if (this.state === "executing" || this.isDispatching || this.maintenanceInProgress) {
			this.broadcaster.broadcast({
				type: "system",
				message: t("message_queued", this.locale),
			});
			this.broadcastState();
			return;
		}

		await this.dispatchNext();
	}

	// ─── Streaming LLM Call ────────────────────────────

	private async streamLLMResponse(): Promise<{
		toolCalls: ToolCallContent[];
		textContent: string;
	}> {
		// Flush-before-compress ordering
		if (this.contextManager.shouldRunMemoryFlush()) {
			await this.contextManager.runMemoryFlush();
		}
		if (this.contextManager.shouldCompress()) {
			await this.contextManager.compress();
			// Auto-compaction must NOT wipe the web-UI transcript: unlike the /clear COMMAND
			// path (command-router.ts), this fires mid-task and the user is still watching the
			// same conversation. We only compact the MODEL context; the visible chat history and
			// the model context are now intentionally decoupled on compaction. Surface a system
			// divider instead of `{type:"clear"}` so earlier turns stay on screen.
			this.broadcaster.broadcast({ type: "system", message: t("context_compacted_divider", this.locale) });
		}

		const { system, messages } = this.contextManager.prepareForLLM();

		// Log full prompt on first LLM call
		if (this.firstLLMCall) {
			this.firstLLMCall = false;
			logger.info("main-agent:prompt", "═══ First LLM Call — Full Prompt ═══");
			logger.info("main-agent:prompt", `[System Prompt]\n${system}`);
			for (const msg of messages) {
				const contentStr = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content, null, 2);
				logger.info(
					"main-agent:prompt",
					`[Message role=${msg.role}${msg.toolCallId ? ` toolCallId=${msg.toolCallId}` : ""}]\n${contentStr}`,
				);
			}
			logger.info("main-agent:prompt", "═══ End of First LLM Call Prompt ═══");
		}

		let textContent = "";
		const toolCallAccumulator = new Map<number, { id: string; name: string; args: string }>();

		// Pass conversation_id as `prompt_cache_key` for the Responses API path. Other
		// providers (chat-completions, anthropic) ignore this field, so it's safe to send
		// unconditionally. Stable across the session except at /clear & /reset, mirroring
		// Codex `state.conversation_id`.
		const promptCacheKey = this.contextManager.getConversationId();

		const stream = this.llmClient.stream(messages, {
			systemPrompt: system,
			tools: TOOL_DEFINITIONS,
			temperature: 0.2,
			thinking: this.thinking,
			promptCacheKey,
		});

		let finalResponse: any = null;

		for await (const event of stream) {
			switch (event.type) {
				case "text_delta":
					textContent += event.delta;
					this.broadcaster.broadcast({ type: "assistant_delta", delta: event.delta });
					break;

				case "tool_call_delta": {
					let acc = toolCallAccumulator.get(event.index);
					if (!acc) {
						acc = { id: event.id ?? "", name: event.name ?? "", args: "" };
						toolCallAccumulator.set(event.index, acc);
					}
					if (event.id) acc.id = event.id;
					if (event.name) acc.name = event.name;
					acc.args += event.argumentsDelta;
					break;
				}

				case "thinking_delta":
					// Ignore thinking deltas in chat mode
					break;

				case "done":
					finalResponse = event.response;
					break;
			}
		}

		// Report usage
		if (finalResponse?.usage) {
			this.contextManager.reportUsage({
				inputTokens: finalResponse.usage.inputTokens ?? 0,
				outputTokens: finalResponse.usage.outputTokens ?? 0,
			});
		}

		// Build tool calls from accumulator
		const toolCalls: ToolCallContent[] = [];
		for (const [, acc] of toolCallAccumulator) {
			let parsedArgs: Record<string, any> = {};
			try {
				parsedArgs = JSON.parse(acc.args);
			} catch {
				logger.warn("main-agent", `Failed to parse tool call args: ${acc.args}`);
			}
			toolCalls.push({
				type: "tool_call",
				id: acc.id,
				name: acc.name,
				arguments: parsedArgs,
			});
		}

		// Debug logging
		if (this.debug && finalResponse) {
			if (textContent) logger.info("main-agent:debug", `[LLM text] ${textContent}`);
			for (const tc of toolCalls) {
				logger.info("main-agent:debug", `[LLM tool_call] ${tc.name}(${JSON.stringify(tc.arguments)})`);
			}
			if (finalResponse.usage) {
				logger.info(
					"main-agent:debug",
					`[LLM usage] input=${finalResponse.usage.inputTokens} output=${finalResponse.usage.outputTokens}`,
				);
			}
		}

		return { toolCalls, textContent };
	}

	// ─── Tool Execution Loop (EXECUTING state) ─────────

	private async executeToolLoop(initialToolCalls: ToolCallContent[]): Promise<void> {
		this.execCommandBroadcastCount = 0;
		let toolCalls = initialToolCalls;

		while (true) {
			// Execute all tool calls
			for (const toolCall of toolCalls) {
				// CRITICAL: every function_call MUST get a paired tool result, even if the
				// tool throws (e.g. the model streamed malformed/truncated JSON args, so a
				// required field is undefined). If we let the throw escape, the assistant's
				// function_call stays in context with no function_call_output, and the
				// OpenAI Responses API then 400s ("No tool output found for function call …")
				// on EVERY subsequent turn — a permanent, SQLite-persisted stuck state.
				let result: { output: string; terminal: boolean };
				try {
					result = await this.executeTool(toolCall);
				} catch (err: any) {
					const message = err?.message ?? String(err);
					logger.error("main-agent", `Tool ${toolCall.name} threw: ${message}`);
					result = {
						output: `Error: tool "${toolCall.name}" failed: ${message}. Check the arguments (they may have been malformed) and retry.`,
						terminal: false,
					};
				}

				// Add tool result to conversation
				this.contextManager.addMessage({
					role: "tool",
					content: result.output,
					toolCallId: toolCall.id,
				});

				// Terminal tool → back to IDLE
				if (result.terminal) {
					this.setState("idle");
					return;
				}
			}

			// ─── Between-round checks ──────────────────

			// 1. Check stopRequested
			if (this.isStopRequested()) {
				this.clearStopRequest(); // Consume the flag
				this.setState("idle");
				this.broadcaster.broadcast({
					type: "system",
					message: t("execution_stopped", this.locale),
				});
				return;
			}

			// 2. Check context thresholds
			if (this.contextManager.shouldRunMemoryFlush()) {
				await this.contextManager.runMemoryFlush();
			}
			if (this.contextManager.shouldCompress()) {
				await this.contextManager.compress();
				// Same as the pre-turn path above: auto-compaction decouples the visible chat
				// history from the model context. Emit a divider, never `{type:"clear"}`, so the
				// user's transcript survives mid-loop compaction (only /clear wipes the UI).
				this.broadcaster.broadcast({ type: "system", message: t("context_compacted_divider", this.locale) });
			}

			// 4. Next LLM call
			const { toolCalls: nextToolCalls, textContent } = await this.streamLLMResponse();

			if (nextToolCalls.length === 0) {
				// No more tool calls — add text response and back to IDLE
				if (textContent) {
					this.contextManager.addMessage({ role: "assistant", content: textContent });
				}
				this.broadcastAssistantDone();
				await this.maybeAutoContinue(textContent);
				this.setState("idle");
				return;
			}

			// Has tool calls — add assistant message and continue loop
			const assistantBlocks = this.buildAssistantBlocks(textContent, nextToolCalls);
			this.contextManager.addMessage({ role: "assistant", content: assistantBlocks });
			this.broadcastAssistantDone();

			toolCalls = nextToolCalls;
		}
	}

	// ─── Unified Work Dispatch ────────────────────────

	private async dispatchNext(): Promise<void> {
		if (this.state !== "idle") return;
		if (this.isDispatching) return;
		if (this.maintenanceInProgress) return;
		if (this.workQueue.isEmpty()) return;

		this.isDispatching = true;
		try {
			while (!this.workQueue.isEmpty() && this.state === "idle") {
				const item = this.workQueue.dequeue()!;
				if (item.kind === "user_message") {
					this.broadcastState();
					await this.processUserMessage(item.content);
				} else {
					await this.processAgentEventItem(item.event);
				}
			}
		} catch (err: any) {
			this.recoverFromExecutionError("dispatchNext", err);
		} finally {
			this.isDispatching = false;
			// Re-schedule if items arrived while we were dispatching
			// (item_available listener was blocked by isDispatching=true)
			if (!this.workQueue.isEmpty() && this.state === "idle") {
				queueMicrotask(() => this.dispatchNext());
			}
		}
	}

	private async processUserMessage(content: string): Promise<void> {
		// A stop flag latched while we are IDLE is necessarily stale: it raced the loop's
		// return to idle (e.g. /stop arrived during the final text-only LLM stream, which
		// never runs the between-round check). Left in place it would truncate THIS fresh
		// message after exactly one tool round. A new instruction supersedes a stale stop.
		// Mid-execution stop semantics are unaffected — this path only runs from idle, and
		// a stop requested after this point is consumed by executeToolLoop between rounds.
		if (this.stopRequested) {
			logger.info("main-agent", "Clearing stale stop request — superseded by a new user message");
			this.stopRequested = false;
		}
		// Optimistic state: show "executing" immediately so the UI responds fast
		this.setState("executing");
		this.contextManager.addMessage({ role: "user", content });

		// Stream LLM response
		const { toolCalls, textContent } = await this.streamLLMResponse();

		if (toolCalls.length > 0) {
			// Add assistant message to conversation
			const assistantBlocks = this.buildAssistantBlocks(textContent, toolCalls);
			this.contextManager.addMessage({ role: "assistant", content: assistantBlocks });
			this.broadcastAssistantDone();

			// Execute tools and enter self-loop
			await this.executeToolLoop(toolCalls);
		} else {
			// Pure text response — return to IDLE
			this.contextManager.addMessage({ role: "assistant", content: textContent });
			this.broadcastAssistantDone();
			await this.maybeAutoContinue(textContent);
			this.setState("idle");
		}
	}

	private async processAgentEventItem(event: AgentEvent): Promise<void> {
		// Format event as a structured message for the LLM
		const lines = [
			`[AGENT_EVENT agent_id=${event.agentId} task_id=${event.taskId} status=${event.status} duration=${event.durationSeconds}s]`,
			`Original task: ${event.summary}`,
			`Agent status: ${event.status} (${event.detail})`,
		];
		if (event.paneContent) {
			lines.push("");
			lines.push(event.paneContent);
		}

		// Optimistic state: show "executing" immediately so the UI responds fast
		this.setState("executing");
		this.contextManager.addMessage({ role: "user", content: lines.join("\n") });

		const { toolCalls, textContent } = await this.streamLLMResponse();

		if (toolCalls.length > 0) {
			const assistantBlocks = this.buildAssistantBlocks(textContent, toolCalls);
			this.contextManager.addMessage({ role: "assistant", content: assistantBlocks });
			this.broadcastAssistantDone();

			await this.executeToolLoop(toolCalls);
		} else {
			if (textContent) {
				this.contextManager.addMessage({ role: "assistant", content: textContent });
				this.broadcastAssistantDone();
			}
			// Pure text / empty response — return to IDLE
			await this.maybeAutoContinue(textContent);
			this.setState("idle");
		}
	}

	/**
	 * Auto-continue gate. Called at natural-completion return-to-idle sites. When the mode is on
	 * and no other actor is taking over, a single separate LLM call decides whether the task is
	 * actually done. On "continue" it enqueues a synthesized driver message (re-driving the loop
	 * via dispatchNext) and returns true; otherwise returns false (caller hands back to the user).
	 * The caller calls setState("idle") regardless — a true result just means a queued message
	 * will immediately re-drive it.
	 */
	private async maybeAutoContinue(lastText: string): Promise<boolean> {
		if (!this.autoContinueEnabled) return false;

		const mod = "main-agent:autocontinue";

		// ─── Short-circuit gates (no LLM call) ───
		if (!this.promptLoader) {
			logger.warn(mod, "Gate skipped: promptLoader not configured");
			return false;
		}
		if (this.isStopRequested()) {
			logger.info(mod, "Gate skipped: stop requested — handing control back to user");
			return false;
		}
		const pendingUsers = this.workQueue.pendingUserMessages();
		if (pendingUsers > 0) {
			logger.info(mod, `Gate skipped: ${pendingUsers} user message(s) already queued — deferring to human`);
			return false; // a real user message is waiting — defer
		}
		if (this.autoContinueCount >= this.autoContinueMax) {
			logger.info(
				mod,
				`Gate skipped: consecutive cap reached (${this.autoContinueCount}/${this.autoContinueMax}) — handing control back to user`,
			);
			this.broadcaster.broadcast({ type: "system", message: t("autocontinue_cap_reached", this.locale) });
			return false;
		}

		// ─── Build the sub-agent snapshot fed to the gate ───
		const tasks = this.agentMonitor?.getAllTasks() ?? [];
		const pending = this.workQueue.getAgentEvents();
		const statusLines: string[] = [];
		for (const t of tasks) {
			const elapsed = Math.round((Date.now() - t.startedAt) / 1000);
			statusLines.push(`- ${t.agentId} (${t.taskId}) status=${t.status} elapsed=${elapsed}s — ${t.summary}`);
		}
		for (const e of pending) {
			statusLines.push(`- ${e.agentId} (${e.taskId}) reported=${e.status} — ${e.summary}`);
		}
		const agentStatus = statusLines.length > 0 ? statusLines.join("\n") : "(no active sub-agents)";

		// Hot-reload the gate prompt so edits to auto-continue.md take effect without a server restart
		// (mirrors how context-manager hot-reloads the main-agent prompt).
		this.promptLoader.reloadIfChanged?.("auto-continue");
		const prompt = this.promptLoader.resolve("auto-continue", {
			language_instruction: getLanguageInstruction(this.locale),
			user_instruction: this.lastUserInstruction.trim() || "(no prior user instruction on record)",
			last_output: lastText || "(the agent produced no text this turn)",
			agent_status: agentStatus,
			task_list: await this.readTaskList(),
		});

		// Full input/output trace at INFO level — the default log level is "info" and debug is
		// never enabled, so anything logged at debug is silently dropped. Log the complete resolved
		// prompt and raw model response so a gate decision can be diagnosed from the log file alone.
		logger.info(
			mod,
			`═══ Gate INPUT (streak ${this.autoContinueCount}/${this.autoContinueMax} · lastText=${lastText.length} chars · ${tasks.length} active task(s) · ${pending.length} pending event(s)) ═══`,
		);
		logger.info(mod, `[gate prompt]\n${prompt}`);

		// ─── Gate LLM call (1 retry on parse failure) ───
		const startedAt = Date.now();
		let rawResponse = "";
		let decision: { continue: boolean; reason: string; driverText: string } | null = null;
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				const res = await this.llmClient.complete([{ role: "user", content: prompt }], {
					responseFormat: "json",
					temperature: 0.2,
				});
				rawResponse = res.content;
				logger.info(
					mod,
					`═══ Gate OUTPUT (attempt ${attempt + 1}, ${Date.now() - startedAt}ms) ═══\n${res.content}`,
				);
				decision = this.parseAutoContinueDecision(res.content);
				break;
			} catch (err: any) {
				logger.warn(
					mod,
					`Gate parse attempt ${attempt + 1} failed: ${err.message} | raw response was: ${rawResponse || "(empty / LLM call threw)"}`,
				);
			}
		}
		const elapsedMs = Date.now() - startedAt;

		// ─── Interpret the decision ───
		if (!decision) {
			logger.warn(
				mod,
				`Gate result: UNPARSEABLE after 2 attempts (${elapsedMs}ms) — failing safe, handing control back to user`,
			);
			return false;
		}
		if (!decision.continue) {
			logger.info(mod, `Gate result: STOP (${elapsedMs}ms) — ${decision.reason || "(no reason given)"}`);
			return false;
		}
		if (decision.driverText.trim() === "") {
			logger.info(
				mod,
				`Gate result: continue=true but driverText empty (${elapsedMs}ms) — treating as STOP; reason: ${decision.reason || "(none)"}`,
			);
			return false;
		}

		// Re-check AFTER the (multi-second) gate call: a real user message that arrived while
		// the gate was running must win the race. Enqueuing the driverText behind it would
		// execute stale, possibly contradictory instructions after the human's new ask — and
		// outside the streak cap (handleMessage resets the counter). Drop the driver text.
		const lateUsers = this.workQueue.pendingUserMessages();
		if (lateUsers > 0) {
			logger.info(
				mod,
				`Gate result: CONTINUE (${elapsedMs}ms) but ${lateUsers} user message(s) arrived during the gate call — dropping driverText, deferring to human`,
			);
			return false;
		}

		this.autoContinueCount++;
		logger.info(
			mod,
			`Gate result: CONTINUE (${this.autoContinueCount}/${this.autoContinueMax}, ${elapsedMs}ms) — ${decision.reason || "(no reason given)"}`,
		);
		logger.info(mod, `Gate driverText enqueued: ${decision.driverText}`);
		this.broadcaster.broadcast({
			type: "system",
			message: t("autocontinue_progress", this.locale, {
				count: this.autoContinueCount,
				max: this.autoContinueMax,
				reason: decision.reason,
			}),
		});
		this.workQueue.enqueueUserMessage(decision.driverText);
		return true;
	}

	private parseAutoContinueDecision(text: string): { continue: boolean; reason: string; driverText: string } {
		const stripped = text
			.replace(/^```(?:json)?\s*/, "")
			.replace(/\s*```\s*$/, "")
			.trim();
		const parsed = JSON.parse(stripped);
		if (typeof parsed.continue !== "boolean") {
			throw new Error("auto-continue decision missing 'continue' boolean");
		}
		return {
			continue: parsed.continue,
			reason: typeof parsed.reason === "string" ? parsed.reason : "",
			driverText: typeof parsed.driverText === "string" ? parsed.driverText : "",
		};
	}

	private recoverFromExecutionError(source: string, err: Error): void {
		if (this.state === "executing") {
			this.setState("idle");
		}
		logger.error("main-agent", `${source} error: ${err.message}`);
		// Tell the user. Without this, a provider failure mid-dispatch consumes the message
		// silently: the UI flips executing → idle and nothing explains what happened.
		try {
			this.broadcaster.broadcast({
				type: "system",
				message: t("execution_error", this.locale, { error: err?.message ?? String(err) }),
			});
		} catch (broadcastErr: any) {
			logger.warn("main-agent", `Failed to broadcast execution error: ${broadcastErr?.message ?? broadcastErr}`);
		}
	}

	private emitUiEvent(type: UiEventType, summary: string): UiEvent {
		const event: UiEvent = {
			id: randomUUID(),
			type,
			summary,
			createdAt: Date.now(),
		};
		this.uiEventStore?.add(event);
		this.broadcaster.broadcast({ type, summary });
		return event;
	}

	private resolveMemoryGetTarget(rawPath: string): { storageDir: string; relativePath: string } {
		if (!this.memoryStore) {
			throw new Error("Memory store not available.");
		}

		const normalizedPath = rawPath.trim().replace(/\\/g, "/").replace(/^\.\//, "");

		// Reject path traversal and any path outside memory/. isMemoryPath alone is not
		// enough because "memory/../secret.txt" also starts with "memory/" — explicitly
		// block any ".." segment.
		const segments = normalizedPath.split("/");
		if (!isMemoryPath(normalizedPath) || segments.includes("..")) {
			throw new Error("Only .md files under memory/ directory are allowed");
		}

		return {
			storageDir: this.memoryStore.getStorageDir(),
			relativePath: normalizedPath,
		};
	}

	// ─── Tool context facade ───────────────────────────
	// A thin, live view of this MainAgent handed to every tool handler. Getters read
	// `this.*` on each access (so post-construction mutations are visible); mutating
	// entry points delegate to the same private methods the switch used to call inline.
	private buildToolContext(): ToolContext {
		const self = this;
		return {
			// ─── Agent registry / adapters ─────────────
			get agents() {
				return self.agents;
			},
			get takenOverAgents() {
				return self.takenOverAgents;
			},
			get adapters() {
				return self.adapters;
			},
			get defaultAdapterName() {
				return self.defaultAdapterName;
			},
			get activeAgentId() {
				return self.activeAgentId;
			},
			set activeAgentId(id: string | null) {
				self.activeAgentId = id;
			},
			adapterFor: (entry) => self.adapterFor(entry),
			resolveAgent: (agentId) => self.resolveAgent(agentId),
			cleanupAgent: (id) => self.cleanupAgent(id),
			getActiveAgents: () => self.getActiveAgents(),
			getAgentWorkingDir: () => self.getAgentWorkingDir(),
			get createAgentSettleMs() {
				return self.createAgentSettleMs;
			},
			notifyAgentChange: () => self.onAgentChange?.(),

			// ─── Infrastructure ────────────────────────
			get bridge() {
				return self.bridge;
			},
			get stateDetector() {
				return self.stateDetector;
			},
			get broadcaster() {
				return self.broadcaster;
			},
			get locale() {
				return self.locale;
			},
			get workQueue() {
				return self.workQueue;
			},
			get agentMonitor() {
				return self.agentMonitor;
			},
			get agentStore() {
				return self.agentStore;
			},
			get promptTracker() {
				return self.promptTracker;
			},
			get learningPipeline() {
				return self.learningPipeline;
			},
			get changeTracker() {
				return self.changeTracker;
			},
			emitLog: (message) => {
				self.emit("log", message);
			},
			emitUiEvent: (type, summary) => self.emitUiEvent(type, summary),

			// ─── Memory ────────────────────────────────
			get memoryStore() {
				return self.memoryStore;
			},
			get embeddingProvider() {
				return self.embeddingProvider;
			},
			get searchConfig() {
				return self.searchConfig;
			},
			get syncMemory() {
				return self.syncMemory;
			},
			get globalDir() {
				return self.globalDir;
			},
			resolveMemoryGetTarget: (rawPath) => self.resolveMemoryGetTarget(rawPath),

			// ─── Skills ────────────────────────────────
			get skillRegistry() {
				return self.skillRegistry;
			},

			// ─── exec_command broadcast throttle ───────
			incExecCommandBroadcastCount: () => ++self.execCommandBroadcastCount,
		};
	}

	// ─── Helper: build assistant content blocks ────────

	private buildAssistantBlocks(text: string, toolCalls: ToolCallContent[]): MessageContent[] {
		const blocks: MessageContent[] = [];
		if (text) {
			blocks.push({ type: "text", text });
		}
		for (const tc of toolCalls) {
			blocks.push(tc);
		}
		return blocks;
	}

	// ─── Tool Execution ────────────────────────────────

	private async executeTool(toolCall: ToolCallContent): Promise<{
		output: string;
		terminal: boolean;
	}> {
		const { name, arguments: args } = toolCall;
		logger.info("main-agent", `Executing tool: ${name}(${JSON.stringify(args)})`);

		const handler = this.toolHandlers.get(name);
		if (handler) {
			return handler.execute(args, this.toolCtx);
		}

		// Skill-declared tools (merged in via tool-merge) are not in the built-in handler
		// map — dispatch them exactly as the old switch's default case did: return the
		// skill body, else an "Unknown tool" error.
		if (this.skillRegistry) {
			const skillForTool = this.skillRegistry.getByToolName(name);
			if (skillForTool) {
				return { output: skillForTool.body, terminal: false };
			}
		}
		return { output: `Unknown tool: ${name}`, terminal: false };
	}
}
