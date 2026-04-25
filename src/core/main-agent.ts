import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { AgentAdapter } from "../agents/adapter.js";
import type { LLMClient } from "../llm/client.js";
import type { LLMMessage, LLMStreamEvent, MessageContent, ToolCallContent, ToolDefinition } from "../llm/types.js";
import { buildCategoryPathFilter } from "../memory/category.js";
import { loadPersistentMemory, readPersistentMemory, updatePersistentMemory } from "../memory/persistent.js";
import { searchMemory } from "../memory/search.js";
import { isMemoryPath, type MemoryStore } from "../memory/store.js";
import type { EmbeddingProvider, HybridSearchConfig, MemoryCategory } from "../memory/types.js";
import type { AgentStore } from "../persistence/agent-store.js";
import type { ChatBroadcaster } from "../server/chat-broadcaster.js";
import type { UiEvent, UiEventStore, UiEventType } from "../server/ui-events.js";
import type { SkillRegistry } from "../skills/registry.js";
import type { TmuxBridge } from "../tmux/bridge.js";
import type { StateDetector } from "../tmux/state-detector.js";
import { loadConfig } from "../utils/config.js";
import { logger } from "../utils/logger.js";
import { cleanupMcpConfigFile, generateMcpConfigFile, selectMcpServers } from "../utils/mcp-config.js";
import { AgentMonitor } from "./agent-monitor.js";
import type { ChangeTracker } from "./change-tracker.js";
import type { ContextManager } from "./context-manager.js";
import type { LearningPipeline } from "./learning-pipeline.js";
import type { PromptTracker } from "./prompt-tracker.js";
import type { Signal, SignalRouter } from "./signal-router.js";
import { type AgentEvent, WorkQueue } from "./work-queue.js";

// ─── Types ──────────────────────────────────────────────

export type AgentState = "idle" | "executing";

export interface AgentEntry {
	paneTarget: string;
	workingDir: string;
}

export interface MainAgentEvents {
	state_change: [state: AgentState];
	log: [message: string];
}

// ─── Tool definitions ───────────────────────────────────

const TOOL_DEFINITIONS: ToolDefinition[] = [
	{
		name: "send_to_agent",
		description:
			"Send an instruction prompt to the coding agent. Returns immediately with a task_id. The agent executes asynchronously — you will receive a callback message when the agent finishes, encounters an error, or needs input. If the target agent is busy, returns the current task info and recent agent logs instead. If agent_id is omitted, routes to the most recently used agent.",
		parameters: {
			type: "object",
			properties: {
				prompt: { type: "string", description: "The instruction prompt to send to the coding agent" },
				summary: {
					type: "string",
					description:
						"A brief human-readable summary of the current action for the chat interface (e.g., 'Asking agent to add JWT auth to auth/login.ts')",
				},
				agent_id: {
					type: "string",
					description: "Target agent name. If omitted, routes to the active agent.",
				},
			},
			required: ["prompt", "summary"],
		},
	},
	{
		name: "respond_to_agent",
		description:
			"Respond to an agent waiting for input. Only callable when the agent has an active task in waiting_input status. Returns immediately — you will receive a callback when the agent settles again. Formats: 'Enter', 'Escape', 'y', 'n', 'arrow:down:N', 'keys:K1,K2,...', or plain text (including menu option numbers like '2'). If agent_id is omitted, routes to the most recently used agent.",
		parameters: {
			type: "object",
			properties: {
				value: { type: "string", description: "The response value to send" },
				summary: {
					type: "string",
					description:
						"A brief human-readable summary of this response for the chat interface (e.g., 'Confirming dependency installation')",
				},
				agent_id: {
					type: "string",
					description: "Target agent name. If omitted, routes to the active agent.",
				},
			},
			required: ["value", "summary"],
		},
	},
	{
		name: "interrupt_agent",
		description:
			"Interrupt a coding agent that is going off track by sending an Escape key to its tmux session. This immediately interrupts the agent's current operation without destroying the session. Use when the agent is deviating from the goal and you want to regain control before sending a corrected instruction. If agent_id is omitted, routes to the most recently used agent.",
		parameters: {
			type: "object",
			properties: {
				summary: {
					type: "string",
					description:
						"A brief human-readable summary explaining why the agent is being interrupted (e.g., 'Agent is modifying wrong file, interrupting to redirect')",
				},
				agent_id: {
					type: "string",
					description: "Target agent name. If omitted, routes to the active agent.",
				},
			},
			required: ["summary"],
		},
	},
	{
		name: "inspect_agent",
		description:
			"Inspect an agent's current pane content and task status. Can be used at any time — during agent execution, while waiting, or after completion. Useful for checking progress, understanding what an agent is doing, or getting more context beyond what a callback provided. If agent_id is omitted, routes to the most recently used agent.",
		parameters: {
			type: "object",
			properties: {
				lines: { type: "number", description: "Number of lines to capture (e.g. 100, 200, 500)" },
				agent_id: {
					type: "string",
					description: "Target agent name. If omitted, routes to the active agent.",
				},
			},
			required: ["lines"],
		},
	},
	{
		name: "mark_failed",
		description:
			"Mark the current task as failed and return to idle state. Use when the task cannot be accomplished.",
		parameters: {
			type: "object",
			properties: {
				reason: { type: "string", description: "Why the task failed" },
			},
			required: ["reason"],
		},
	},
	{
		name: "escalate_to_human",
		description:
			"Escalate the current situation to the human operator and return to idle state. Use when proceeding autonomously would be riskier than pausing: destructive/irreversible operations, ambiguous user intent, major architectural trade-offs, scope expansion beyond the original request, security-sensitive changes, or production/shared resource modifications.",
		parameters: {
			type: "object",
			properties: {
				reason: { type: "string", description: "Why human intervention is needed" },
			},
			required: ["reason"],
		},
	},
	{
		name: "memory_search",
		description:
			"Search project memory for relevant information. Use this before answering questions about prior work, decisions, dates, people, preferences, or todos.",
		parameters: {
			type: "object",
			properties: {
				query: { type: "string", description: "Search query text (natural language)" },
				maxResults: { type: "number", description: "Maximum results to return (default 10)" },
				minScore: { type: "number", description: "Minimum relevance score 0-1 (default 0.1)" },
				category: {
					type: "string",
					description: 'Optional category filter: "core", "preferences", "people", "todos", "daily", "topic"',
				},
			},
			required: ["query"],
		},
	},
	{
		name: "memory_get",
		description:
			"Read a specific memory file. Optionally specify a line range. Use after memory_search to read full context around a search hit.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: 'Relative path (e.g. "memory/core.md")' },
				from: { type: "number", description: "1-indexed start line (optional)" },
				lines: { type: "number", description: "Number of lines to read (optional)" },
			},
			required: ["path"],
		},
	},
	{
		name: "memory_edit",
		description:
			"Edit a memory file. Supports append (default), overwrite, search-and-replace, and delete. Only memory/*.md files are allowed.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: 'Relative path (e.g. "memory/core.md")' },
				content: { type: "string", description: "Content to write (for append/overwrite/replace)" },
				mode: {
					type: "string",
					enum: ["append", "overwrite", "replace", "delete"],
					description: "Edit mode (default: append)",
				},
				match: {
					type: "string",
					description: "Text to find for replace/delete operations. Must be an exact match in the file.",
				},
			},
			required: ["path"],
		},
	},
	{
		name: "read_skill",
		description:
			"Read the full instructions of a skill by name. Use this when you need detailed guidance on how to use a specific skill (e.g., command usage, workflow, tips).",
		parameters: {
			type: "object",
			properties: {
				name: { type: "string", description: 'The skill name (e.g. "commit")' },
			},
			required: ["name"],
		},
	},
	{
		name: "create_agent",
		description:
			'Create a tmux session with the "cliclaw-" prefix and launch the coding agent in it. Must be called before send_to_agent/respond_to_agent/inspect_agent. On naming conflict, returns an error so you can retry with a different name.\n\nIMPORTANT: If the user provides a resume id (or one was found in memory), you MUST pass it as resume_id. Omitting it will lose the agent\'s prior conversation context.',
		parameters: {
			type: "object",
			properties: {
				agent_name: {
					type: "string",
					description: 'Agent name (will be prefixed with "cliclaw-" if not already). If omitted, auto-generated.',
				},
				working_dir: {
					type: "string",
					description: "Working directory for the agent. Defaults to process.cwd() if omitted.",
				},
				resume_id: {
					type: "string",
					description:
						"Resume id for restoring a previous agent conversation. REQUIRED when the user supplies a resume id or one was retrieved from memory. When provided, launches with --resume to restore the agent's prior conversation. When omitted, a fresh agent starts and all previous context is lost.",
				},
				pre_commands: {
					type: "array",
					items: { type: "string" },
					description:
						'Shell commands to run before launching the agent. Each command is joined with " && " and prepended to the agent launch command. Example: ["export FOO=bar", "source .env"] results in: export FOO=bar && source .env && claude ...',
				},
				mcp_servers: {
					type: "array",
					items: { type: "string" },
					description:
						"Names of MCP servers to make available to this SubAgent. Uses server names from Cliclaw's MCP configuration. When provided, only these servers are available via --strict-mcp-config. When omitted, the SubAgent uses its default MCP behavior. Pass an empty array to launch with no MCP servers.",
				},
			},
		},
	},
	{
		name: "list_agents",
		description:
			"List all active coding agents (cliclaw- prefixed tmux sessions). Useful for checking existing agents before creating a new one.",
		parameters: {
			type: "object",
			properties: {},
		},
	},
	{
		name: "kill_agent",
		description:
			'Gracefully exit a coding agent and destroy its tmux session. Returns captured output and a resume id (if available) for resuming later with --resume. If agent_id is omitted, targets the active agent. Set agent_id to "all" to kill all agents.',
		parameters: {
			type: "object",
			properties: {
				agent_id: {
					type: "string",
					description:
						'Target agent name (e.g. "cliclaw-chat-1"). Omit to target the active agent. Set to "all" to kill all agents.',
				},
				summary: {
					type: "string",
					description: "A brief human-readable summary (e.g., 'Cleaning up agent after task complete')",
				},
			},
			required: ["summary"],
		},
	},
	{
		name: "persistent_memory",
		description:
			"Read or update the persistent MEMORY.md that is always loaded into your system prompt. Use this when the user asks you to remember/forget something, or when you need to review current memories.",
		parameters: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: ["read", "update"],
					description: "read: return current MEMORY.md content. update: add/modify/remove entries.",
				},
				scope: {
					type: "string",
					enum: ["project", "global"],
					description: "project: workspace-level. global: ~/.cliclaw/. Default: project.",
				},
				section: {
					type: "string",
					enum: ["user_profile", "project_conventions", "key_decisions", "people_and_context", "active_notes"],
					description: "Target section. Required when action is update.",
				},
				operation: {
					type: "string",
					enum: ["append", "remove", "replace"],
					description:
						"append: add entry. remove: delete matching entry. replace: rewrite section. Default: append.",
				},
				content: {
					type: "string",
					description: "The memory content to write/match/replace.",
				},
			},
			required: ["action"],
		},
	},
	{
		name: "exec_command",
		description:
			"Execute a bash command directly for read-only reconnaissance. Use for reading files, browsing directories, searching code, and checking environment info. NEVER use for modifications, tests, builds, git operations, or any command with side effects — those MUST go through send_to_agent.",
		parameters: {
			type: "object",
			properties: {
				command: { type: "string", description: "The bash command to execute (read-only operations only)" },
				summary: {
					type: "string",
					description:
						"Very brief summary of the action for chat UI, max 20 chars (e.g., '查看目录结构', '搜索配置文件', 'Check deps')",
				},
				cwd: {
					type: "string",
					description:
						"Working directory for execution. Defaults to agent working directory if an agent exists, otherwise process.cwd().",
				},
				timeout: {
					type: "number",
					description: "Timeout in milliseconds (default: 30000)",
				},
			},
			required: ["command", "summary"],
		},
	},
	{
		name: "list_agent_tasks",
		description:
			"List all active sub-agent tasks currently being monitored and any pending events in the agent event queue. Use this to get a real-time snapshot of sub-agent status before deciding whether to intervene.",
		parameters: {
			type: "object",
			properties: {},
			required: [],
		},
	},
];

// ─── MainAgent ──────────────────────────────────────────

export class MainAgent extends EventEmitter<MainAgentEvents> {
	private contextManager: ContextManager;
	private signalRouter: SignalRouter;
	private llmClient: LLMClient;
	private adapter: AgentAdapter;
	private bridge: TmuxBridge;
	private stateDetector: StateDetector;
	private broadcaster: ChatBroadcaster;
	private uiEventStore: UiEventStore | null = null;
	private workQueue = new WorkQueue();
	private isDispatching = false;
	private agents: Map<string, AgentEntry> = new Map();
	private activeAgentId: string | null = null;
	private takenOverAgents = new Set<string>();
	private memoryStore: MemoryStore | null = null;
	private syncMemory: (() => Promise<void>) | null = null;
	private embeddingProvider: EmbeddingProvider | null = null;
	private skillRegistry: SkillRegistry | null = null;
	private debug: boolean;
	private promptTracker: PromptTracker | undefined;
	private learningPipeline: LearningPipeline | undefined;
	private changeTracker: ChangeTracker | undefined;
	private firstLLMCall = true;
	private execCommandBroadcastCount = 0;
	private agentMonitor: AgentMonitor | null = null;
	private agentStore: AgentStore | null = null;
	private globalDir: string;
	private workspaceDir: string;
	private searchConfig: HybridSearchConfig = {
		enabled: true,
		vectorWeight: 0.7,
		textWeight: 0.3,
		candidateMultiplier: 3,
		temporalDecay: { enabled: true, halfLifeDays: 30 },
	};

	// ─── State Machine ─────────────────────────────────
	state: AgentState = "idle";

	getPendingUserMessageCount(): number {
		return this.workQueue.pendingUserMessages();
	}

	constructor(opts: {
		contextManager: ContextManager;
		signalRouter: SignalRouter;
		llmClient: LLMClient;
		adapter: AgentAdapter;
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
	}) {
		super();
		this.contextManager = opts.contextManager;
		this.signalRouter = opts.signalRouter;
		this.llmClient = opts.llmClient;
		this.adapter = opts.adapter;
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
		this.promptTracker = opts.promptTracker;
		this.learningPipeline = opts.learningPipeline;
		this.changeTracker = opts.changeTracker;
		if (opts.searchConfig) {
			this.searchConfig = { ...this.searchConfig, ...opts.searchConfig };
		}
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
	getActiveAgents(): Array<{
		agentName: string;
		agentId: string;
		paneTarget: string;
		workingDir: string;
		status: string;
		takenOver: boolean;
	}> {
		const result: Array<{
			agentName: string;
			agentId: string;
			paneTarget: string;
			workingDir: string;
			status: string;
			takenOver: boolean;
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
			result.push({
				agentName: id,
				agentId: id,
				paneTarget: entry.paneTarget,
				workingDir: entry.workingDir,
				status,
				takenOver: this.takenOverAgents.has(id),
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
			signalRouter: this.signalRouter,
			workQueue: this.workQueue,
		});

		this.workQueue.on("item_available", () => {
			if (this.state === "idle" && !this.isDispatching) {
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
			state: this.state,
			queueSize: this.workQueue.pendingUserMessages(),
		});
	}

	// ─── handleMessage — main entry point ──────────────

	async handleMessage(content: string): Promise<void> {
		this.workQueue.enqueueUserMessage(content);

		if (this.state === "executing" || this.isDispatching) {
			this.broadcaster.broadcast({
				type: "system",
				message: "消息已排队，将在当前操作完成后处理",
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
			this.broadcaster.broadcast({ type: "clear" });
			this.broadcaster.broadcast({ type: "system", message: "上下文已压缩，历史对话已清空" });
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

		const stream = this.llmClient.stream(messages, {
			systemPrompt: system,
			tools: TOOL_DEFINITIONS,
			temperature: 0.2,
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
				const result = await this.executeTool(toolCall);

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
			if (this.signalRouter.isStopRequested()) {
				this.signalRouter.resume(); // Clear the flag
				this.setState("idle");
				this.broadcaster.broadcast({
					type: "system",
					message: "执行已停止",
				});
				return;
			}

			// 2. Check context thresholds
			if (this.contextManager.shouldRunMemoryFlush()) {
				await this.contextManager.runMemoryFlush();
			}
			if (this.contextManager.shouldCompress()) {
				await this.contextManager.compress();
				this.broadcaster.broadcast({ type: "clear" });
				this.broadcaster.broadcast({ type: "system", message: "上下文已压缩，历史对话已清空" });
			}

			// 4. Next LLM call
			const { toolCalls: nextToolCalls, textContent } = await this.streamLLMResponse();

			if (nextToolCalls.length === 0) {
				// No more tool calls — add text response and back to IDLE
				if (textContent) {
					this.contextManager.addMessage({ role: "assistant", content: textContent });
				}
				this.broadcaster.broadcast({ type: "assistant_done" });
				this.setState("idle");
				return;
			}

			// Has tool calls — add assistant message and continue loop
			const assistantBlocks = this.buildAssistantBlocks(textContent, nextToolCalls);
			this.contextManager.addMessage({ role: "assistant", content: assistantBlocks });
			this.broadcaster.broadcast({ type: "assistant_done" });

			toolCalls = nextToolCalls;
		}
	}

	// ─── Resume (after /stop) ──────────────────────────

	async handleResume(): Promise<void> {
		if (this.state === "executing") return;

		try {
			this.contextManager.addMessage({
				role: "user",
				content: "[RESUME] 继续执行之前的任务",
			});

			this.setState("executing");

			const { toolCalls, textContent } = await this.streamLLMResponse();

			if (toolCalls.length > 0) {
				const assistantBlocks = this.buildAssistantBlocks(textContent, toolCalls);
				this.contextManager.addMessage({ role: "assistant", content: assistantBlocks });
				this.broadcaster.broadcast({ type: "assistant_done" });
				await this.executeToolLoop(toolCalls);
			} else {
				if (textContent) {
					this.contextManager.addMessage({ role: "assistant", content: textContent });
				}
				this.broadcaster.broadcast({ type: "assistant_done" });
				this.setState("idle");
			}
		} catch (err: any) {
			this.recoverFromExecutionError("handleResume", err);
			throw err;
		}
	}

	// ─── Unified Work Dispatch ────────────────────────

	private async dispatchNext(): Promise<void> {
		if (this.state !== "idle") return;
		if (this.isDispatching) return;
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
		// Optimistic state: show "executing" immediately so the UI responds fast
		this.setState("executing");
		this.contextManager.addMessage({ role: "user", content });

		// Stream LLM response
		const { toolCalls, textContent } = await this.streamLLMResponse();

		if (toolCalls.length > 0) {
			// Add assistant message to conversation
			const assistantBlocks = this.buildAssistantBlocks(textContent, toolCalls);
			this.contextManager.addMessage({ role: "assistant", content: assistantBlocks });
			this.broadcaster.broadcast({ type: "assistant_done" });

			// Execute tools and enter self-loop
			await this.executeToolLoop(toolCalls);
		} else {
			// Pure text response — return to IDLE
			this.contextManager.addMessage({ role: "assistant", content: textContent });
			this.broadcaster.broadcast({ type: "assistant_done" });
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
			this.broadcaster.broadcast({ type: "assistant_done" });

			await this.executeToolLoop(toolCalls);
		} else {
			if (textContent) {
				this.contextManager.addMessage({ role: "assistant", content: textContent });
				this.broadcaster.broadcast({ type: "assistant_done" });
			}
			// Pure text / empty response — return to IDLE
			this.setState("idle");
		}
	}

	private recoverFromExecutionError(source: string, err: Error): void {
		if (this.state === "executing") {
			this.setState("idle");
		}
		logger.error("main-agent", `${source} error: ${err.message}`);
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

		switch (name) {
			case "send_to_agent": {
				const resolved = this.resolveAgent(args.agent_id as string | undefined);
				if ("error" in resolved) {
					return { output: `Error: ${resolved.error}`, terminal: false };
				}
				const { entry: sendAgent, id: sendAgentId } = resolved;
				this.activeAgentId = sendAgentId;

				const prompt = args.prompt as string;
				const summary = args.summary as string;

				// Non-blocking: check if agent is busy
				if (this.agentMonitor?.isBusy(sendAgentId)) {
					const task = this.agentMonitor.getTask(sendAgentId)!;
					const elapsed = Math.round((Date.now() - task.startedAt) / 1000);
					let paneContent = "";
					try {
						const capture = await this.bridge.capturePane(sendAgent.paneTarget, { startLine: -100 });
						paneContent = capture.content;
					} catch {
						paneContent = "(failed to capture pane content)";
					}
					return {
						output: `Agent ${sendAgentId} is busy (task_id: ${task.taskId}, running for ${elapsed}s).\nCurrent task: ${task.summary}\nCurrent agent logs:\n${paneContent}`,
						terminal: false,
					};
				}

				this.emitUiEvent("agent_update", summary);

				const sendPreHash = await this.stateDetector.captureHash(sendAgent.paneTarget);
				await this.adapter.sendPrompt(this.bridge, sendAgent.paneTarget, prompt);
				this.promptTracker?.record(sendAgentId, prompt);

				if (this.agentMonitor) {
					const result = this.agentMonitor.dispatch(sendAgentId, sendAgent.paneTarget, {
						preHash: sendPreHash,
						summary,
						taskContext: prompt,
					});

					if (result.dispatched) {
						return {
							output: `Task dispatched. task_id: ${result.task.taskId}, agent: ${sendAgentId}.\nYou will receive a callback when the agent finishes.`,
							terminal: false,
						};
					}
					return {
						output: `Agent ${sendAgentId} became busy unexpectedly.`,
						terminal: false,
					};
				}

				return { output: "Error: AgentMonitor not initialized", terminal: false };
			}

			case "respond_to_agent": {
				const resolved = this.resolveAgent(args.agent_id as string | undefined);
				if ("error" in resolved) {
					return { output: `Error: ${resolved.error}`, terminal: false };
				}
				const { entry: respondAgent, id: respondAgentId } = resolved;
				this.activeAgentId = respondAgentId;

				const value = args.value as string;
				const summary = args.summary as string;

				// Check task state
				if (this.agentMonitor) {
					const task = this.agentMonitor.getTask(respondAgentId);
					if (!task) {
						return {
							output: `Error: Agent ${respondAgentId} has no active task.`,
							terminal: false,
						};
					}
					if (task.status !== "waiting_input") {
						return {
							output: `Error: Agent ${respondAgentId} is not waiting for input (current status: ${task.status}).`,
							terminal: false,
						};
					}
				}

				this.emitUiEvent("agent_update", summary);

				await this.adapter.sendResponse(this.bridge, respondAgent.paneTarget, value);
				this.promptTracker?.record(respondAgentId, value);

				if (this.agentMonitor) {
					// Wait for agent to begin processing the response before capturing hash.
					// Without this delay, captureHash may snapshot the pre-processing state,
					// causing Phase 1 to never see a hash change (stuck until timeout).
					await new Promise((resolve) => setTimeout(resolve, 500));
					const newPreHash = await this.stateDetector.captureHash(respondAgent.paneTarget);
					const resumed = this.agentMonitor.resumeTask(respondAgentId, newPreHash);
					if (!resumed) {
						return {
							output: `Error: Failed to resume task monitoring for agent ${respondAgentId}.`,
							terminal: false,
						};
					}
					return {
						output: "Response sent, agent continuing execution.",
						terminal: false,
					};
				}

				return { output: "Error: AgentMonitor not initialized", terminal: false };
			}

			case "interrupt_agent": {
				const resolved = this.resolveAgent(args.agent_id as string | undefined);
				if ("error" in resolved) {
					return { output: `Error: ${resolved.error}`, terminal: false };
				}
				const { entry: interruptAgent, id: interruptAgentId } = resolved;
				this.activeAgentId = interruptAgentId;

				const summary = args.summary as string;

				this.emit("log", `Interrupting agent ${interruptAgentId}: ${summary}`);
				this.broadcaster.broadcast({ type: "system", message: `中断 agent: ${summary}` });

				await this.bridge.sendEscape(interruptAgent.paneTarget);

				if (this.agentMonitor) {
					this.agentMonitor.cleanup(interruptAgentId);
				}

				return {
					output: `Agent ${interruptAgentId} interrupted. You can now send a new instruction with send_to_agent.`,
					terminal: false,
				};
			}

			case "inspect_agent": {
				const resolved = this.resolveAgent(args.agent_id as string | undefined);
				if ("error" in resolved) {
					return { output: `Error: ${resolved.error}`, terminal: false };
				}
				const { id: inspectAgentId } = resolved;
				const lines = args.lines as number;

				let paneContent: string;
				try {
					const capture = await this.bridge.capturePane(resolved.entry.paneTarget, { startLine: -lines });
					paneContent = capture.content;
				} catch (err: any) {
					return {
						output: `Error: Failed to capture pane for agent ${inspectAgentId}: ${err.message}`,
						terminal: false,
					};
				}

				let statusLabel = "idle";
				if (this.agentMonitor) {
					const task = this.agentMonitor.getTask(inspectAgentId);
					if (task) {
						statusLabel = task.status;
					}
				}

				return {
					output: `[Agent ${inspectAgentId}] Status: ${statusLabel}\n${paneContent}`,
					terminal: false,
				};
			}

			case "mark_failed": {
				const reason = args.reason as string;
				this.emit("log", `Task failed: ${reason}`);
				this.broadcaster.broadcast({ type: "system", message: `任务失败: ${reason}` });
				return { output: `Task marked as failed: ${reason}`, terminal: true };
			}

			case "escalate_to_human": {
				const reason = args.reason as string;
				this.emit("log", `Escalated to human: ${reason}`);
				this.broadcaster.broadcast({ type: "system", message: `需要人工介入: ${reason}` });
				return { output: `Escalated to human: ${reason}`, terminal: true };
			}

			case "memory_search": {
				if (!this.memoryStore) {
					return { output: "Memory store not available.", terminal: false };
				}
				const query = args.query as string;
				const maxResults = args.maxResults as number | undefined;
				const minScore = args.minScore as number | undefined;
				const category = args.category as MemoryCategory | undefined;

				try {
					let categoryPathFilter: string[] | undefined;
					if (category) {
						const trackedPaths = this.memoryStore.getTrackedFilePaths();
						categoryPathFilter = buildCategoryPathFilter(category, trackedPaths);
					}

					const results = await searchMemory(this.memoryStore, query, this.embeddingProvider, this.searchConfig, {
						maxResults,
						minScore,
						categoryPathFilter,
					});

					if (results.length === 0) {
						return { output: "No memory results found for this query.", terminal: false };
					}

					const formatted = results
						.map(
							(r, i) =>
								`[${i + 1}] ${r.path}:${r.startLine}-${r.endLine} (score: ${r.score.toFixed(3)})\n${r.snippet.slice(0, 300)}`,
						)
						.join("\n\n");

					return { output: formatted, terminal: false };
				} catch (err: any) {
					logger.warn("main-agent", `memory_search failed: ${err.message}`);
					return { output: `Memory search error: ${err.message}`, terminal: false };
				}
			}

			case "memory_get": {
				if (!this.memoryStore) {
					return { output: "Memory store not available.", terminal: false };
				}
				const rawPath = args.path as string;
				const from = args.from as number | undefined;
				const lineCount = args.lines as number | undefined;
				let storageDir: string;
				let memGetPath: string;
				try {
					({ storageDir, relativePath: memGetPath } = this.resolveMemoryGetTarget(rawPath));
				} catch (err: any) {
					return { output: `Memory get error: ${err.message}`, terminal: false };
				}

				try {
					const absPath = join(storageDir, memGetPath);
					const content = await readFile(absPath, "utf-8");
					const lines = content.split("\n");

					if (from !== undefined) {
						const startIdx = Math.max(0, from - 1);
						const count = lineCount ?? lines.length - startIdx;
						const slice = lines.slice(startIdx, startIdx + count);
						return { output: slice.join("\n"), terminal: false };
					}

					return { output: content, terminal: false };
				} catch (err: any) {
					if (err.code === "ENOENT") {
						return { output: `File not found: ${rawPath}`, terminal: false };
					}
					return { output: `Error reading file: ${err.message}`, terminal: false };
				}
			}

			case "memory_edit":
			case "memory_write": {
				if (!this.memoryStore) {
					return { output: "Memory store not available.", terminal: false };
				}
				const editPath = args.path as string;
				const editContent = args.content as string | undefined;
				const editMode = (args.mode as "append" | "overwrite" | "replace" | "delete") ?? "append";
				const editMatch = args.match as string | undefined;

				try {
					const result = await this.memoryStore.edit({
						path: editPath,
						content: editContent,
						mode: editMode,
						match: editMatch,
					});
					if (this.syncMemory) {
						try {
							await this.syncMemory();
						} catch (err: any) {
							return {
								output: `Edited ${result.path} successfully. Warning: memory sync failed: ${err.message}`,
								terminal: false,
							};
						}
					}
					return { output: `Edited ${result.path} successfully (${editMode}).`, terminal: false };
				} catch (err: any) {
					return { output: `Memory edit error: ${err.message}`, terminal: false };
				}
			}

			case "persistent_memory": {
				const action = args.action as string;
				const scope = (args.scope as string) ?? "project";
				const filePath =
					scope === "global"
						? join(this.globalDir, "MEMORY.md")
						: join(this.workspaceDir, ".cliclaw", "MEMORY.md");

				try {
					if (action === "read") {
						const content = await readPersistentMemory(filePath);
						if (!content) {
							return { output: `No MEMORY.md found at ${scope} scope.`, terminal: false };
						}
						return { output: content, terminal: false };
					}

					// action === "update"
					const section = args.section as string;
					const operation = (args.operation as "append" | "remove" | "replace") ?? "append";
					const content = args.content as string;

					if (!section) {
						return { output: "Error: 'section' is required for update action.", terminal: false };
					}
					if (!content) {
						return { output: "Error: 'content' is required for update action.", terminal: false };
					}

					await updatePersistentMemory({ filePath, section, operation, content });

					// Hot-reload: re-merge and update {{memory}} module
					const merged = await loadPersistentMemory(this.globalDir, this.workspaceDir);
					this.contextManager.updateModule("memory", merged);

					return {
						output: `Persistent memory updated (${scope}/${section}/${operation}). System prompt refreshed.`,
						terminal: false,
					};
				} catch (err: any) {
					return { output: `Persistent memory error: ${err.message}`, terminal: false };
				}
			}

			case "read_skill": {
				if (!this.skillRegistry) {
					return { output: "Skill registry not available.", terminal: false };
				}
				const skillName = args.name as string;
				const skill = this.skillRegistry.getByName(skillName);
				if (!skill) {
					return { output: `Skill not found: ${skillName}`, terminal: false };
				}
				return { output: skill.body, terminal: false };
			}

			case "create_agent": {
				logger.debug("main-agent", `create_agent raw args: ${JSON.stringify(args)}`);
				const rawName = args.agent_name as string | undefined;
				let agentName: string;
				if (!rawName) {
					agentName = generateAgentName("chat");
				} else if (!rawName.startsWith("cliclaw-")) {
					agentName = `cliclaw-${rawName}`;
				} else {
					agentName = rawName;
				}

				const rawWorkingDir = (args.working_dir as string | undefined) ?? process.cwd();
				const workingDir = rawWorkingDir.startsWith("~/")
					? join(homedir(), rawWorkingDir.slice(2))
					: rawWorkingDir.startsWith("~")
						? homedir()
						: rawWorkingDir;
				if (workingDir !== rawWorkingDir) {
					logger.debug("main-agent", `create_agent expanded working_dir: "${rawWorkingDir}" → "${workingDir}"`);
				}

				try {
					const dirStat = await stat(workingDir);
					if (!dirStat.isDirectory()) {
						return { output: `Error: "${workingDir}" is not a directory.`, terminal: false };
					}
				} catch {
					return { output: `Error: Directory "${workingDir}" does not exist.`, terminal: false };
				}

				const exists = await this.bridge.hasSession(agentName);
				if (exists) {
					return {
						output: `Error: Agent "${agentName}" already exists. Choose a different name or use list_agents to see existing agents.`,
						terminal: false,
					};
				}

				try {
					const rawResumeId = args.resume_id as string | undefined;
					const resumeId = rawResumeId?.trim() || undefined;
					if (resumeId && /\s/.test(resumeId)) {
						return {
							output: `Error: resume_id must not contain whitespace: "${resumeId}"`,
							terminal: false,
						};
					}
					const rawPreCommands = args.pre_commands as string[] | undefined;
					const preCommands =
						rawPreCommands && Array.isArray(rawPreCommands) && rawPreCommands.length > 0
							? rawPreCommands.filter((c) => typeof c === "string" && c.trim())
							: undefined;

					// Handle mcp_servers: generate temp config file if specified
					let mcpConfigPath: string | undefined;
					const rawMcpServers = args.mcp_servers as string[] | undefined;
					if (rawMcpServers !== undefined && Array.isArray(rawMcpServers)) {
						const config = await loadConfig();
						if (!config.mcpServers || Object.keys(config.mcpServers).length === 0) {
							return {
								output: "Error: No MCP servers configured. Add MCP servers via the settings UI or config.json.",
								terminal: false,
							};
						}
						const selection = selectMcpServers(config.mcpServers, rawMcpServers);
						if ("error" in selection) {
							return { output: `Error: ${selection.error}`, terminal: false };
						}
						mcpConfigPath = await generateMcpConfigFile(selection.servers, agentName);
						logger.info("main-agent", `Generated MCP config for ${agentName}: ${mcpConfigPath}`);
					}

					const paneTarget = await this.adapter.launch(this.bridge, {
						workingDir,
						sessionName: agentName,
						resumeId,
						preCommands,
						mcpConfigPath,
					});
					this.agents.set(agentName, { paneTarget, workingDir });
					await this.changeTracker?.registerAgent(agentName, workingDir);
					this.agentStore?.saveAgent(agentName, { paneTarget, workingDir });
					this.activeAgentId = agentName;
					this.stateDetector.setCharacteristics(this.adapter.getCharacteristics());
					logger.info("main-agent", `Agent created: ${agentName}, pane: ${paneTarget}, cwd: ${workingDir}`);
					this.onAgentChange?.();
					const mcpNote = mcpConfigPath ? ` MCP servers: ${rawMcpServers!.join(", ")}.` : "";
					return {
						output: `Agent "${agentName}" created in ${workingDir}. Agent launched in ${paneTarget}.${mcpNote} You can now use send_to_agent.`,
						terminal: false,
					};
				} catch (err: any) {
					return { output: `Failed to create agent: ${err.message}`, terminal: false };
				}
			}

			case "list_agents": {
				try {
					const tmuxSessions = await this.bridge.listCliclawAgents();
					if (tmuxSessions.length === 0) {
						return { output: "No active agents found.", terminal: false };
					}
					const formatted = tmuxSessions
						.map((s) => `- ${s.name} (windows: ${s.windows}, attached: ${s.attached})`)
						.join("\n");
					return { output: `Found ${tmuxSessions.length} agent(s):\n${formatted}`, terminal: false };
				} catch (err: any) {
					return { output: `Error listing agents: ${err.message}`, terminal: false };
				}
			}

			case "kill_agent": {
				const killAgentId = args.agent_id as string | undefined;
				const killSummary = args.summary as string;
				this.emitUiEvent("agent_update", killSummary);

				try {
					// ── Kill all agents ──
					if (killAgentId === "all") {
						const tmuxSessions = await this.bridge.listCliclawAgents();
						if (tmuxSessions.length === 0 && this.agents.size === 0) {
							return { output: "No agents to kill.", terminal: false };
						}

						// Gracefully exit each registered agent (best-effort)
						const resumeIds: string[] = [];
						for (const [id, entry] of this.agents) {
							try {
								if (this.adapter.exitAgent) {
									const result = await this.adapter.exitAgent(this.bridge, entry.paneTarget);
									if (result.resumeId) resumeIds.push(`${id}: ${result.resumeId}`);
								}
							} catch {
								/* best-effort */
							}
						}

						// Kill all tmux sessions
						const killed: string[] = [];
						for (const s of tmuxSessions) {
							try {
								await this.bridge.killSession(s.name);
								killed.push(s.name);
							} catch {
								/* best-effort */
							}
						}

						// Cleanup all registered agents
						const registeredIds = [...this.agents.keys()];
						for (const id of registeredIds) {
							if (this.learningPipeline && this.changeTracker) {
								const entry = this.agents.get(id);
								if (entry) {
									try {
										await this.learningPipeline.ingestAgentKill({
											sessionId: id,
											sessionName: id,
											cwd: entry.workingDir,
											agentPrompts: this.promptTracker?.getFor(id) ?? [],
										});
									} catch (err) {
										logger.warn("main-agent", `learning ingest failed for ${id}: ${(err as Error).message}`);
									}
								}
								this.changeTracker.releaseAgent(id);
							}
							// Always release prompt tracker, independent of learning pipeline
							this.promptTracker?.release(id);
							// Cleanup MCP config temp file (best-effort)
							await cleanupMcpConfigFile(id).catch(() => {});
							this.cleanupAgent(id);
						}
						this.activeAgentId = null;
						this.onAgentChange?.();

						const parts = [`Killed ${killed.length} agent(s): ${killed.join(", ")}`];
						if (resumeIds.length > 0) {
							parts.push(`\nResume IDs:\n${resumeIds.join("\n")}`);
						}
						return { output: parts.join("\n"), terminal: false };
					}

					// ── Kill single agent ──
					const resolved = this.resolveAgent(killAgentId);
					if ("error" in resolved) {
						return { output: `Error: ${resolved.error}`, terminal: false };
					}
					const { entry: agentEntry, id: agentId } = resolved;

					// Gracefully exit agent to capture resume id (best-effort)
					let agentContent = "";
					let resumeId: string | undefined;
					if (this.adapter.exitAgent) {
						try {
							const exitResult = await this.adapter.exitAgent(this.bridge, agentEntry.paneTarget);
							agentContent = exitResult.content;
							resumeId = exitResult.resumeId;
						} catch (err: any) {
							logger.warn("main-agent", `exitAgent failed (will still kill tmux): ${err.message}`);
						}
					}

					// Kill tmux session
					const exists = await this.bridge.hasSession(agentId);
					if (exists) {
						await this.bridge.killSession(agentId);
					}

					if (this.learningPipeline && this.changeTracker) {
						try {
							await this.learningPipeline.ingestAgentKill({
								sessionId: agentId,
								sessionName: agentId,
								cwd: agentEntry.workingDir,
								agentPrompts: this.promptTracker?.getFor(agentId) ?? [],
							});
						} catch (err) {
							logger.warn("main-agent", `learning ingest failed for ${agentId}: ${(err as Error).message}`);
						}
						this.changeTracker.releaseAgent(agentId);
					}
					// Always release prompt tracker, independent of learning pipeline
					this.promptTracker?.release(agentId);
					// Cleanup MCP config temp file (best-effort)
					await cleanupMcpConfigFile(agentId).catch(() => {});

					// Cleanup agent registry
					this.cleanupAgent(agentId);
					this.onAgentChange?.();

					const parts = [`[Agent killed]\n${agentContent}`];
					if (resumeId) {
						parts.push(`\nResume ID: ${resumeId}`);
						parts.push(`Working directory: ${agentEntry.workingDir}`);
					}
					return { output: parts.join("\n"), terminal: false };
				} catch (err: any) {
					return { output: `Failed to kill agent: ${err.message}`, terminal: false };
				}
			}

			case "exec_command": {
				const command = args.command as string;
				const execSummary = args.summary as string;
				const rawCwd = (args.cwd as string | undefined) ?? this.getAgentWorkingDir();
				const cwd = rawCwd.startsWith("~/")
					? join(homedir(), rawCwd.slice(2))
					: rawCwd.startsWith("~")
						? homedir()
						: rawCwd;
				const timeout = (args.timeout as number | undefined) ?? 30000;
				const MAX_OUTPUT = 10000;

				// Throttled broadcast: emit tool_activity on 1st, 4th, 7th, ... call
				this.execCommandBroadcastCount++;
				if (this.execCommandBroadcastCount % 3 === 1) {
					this.emitUiEvent("tool_activity", execSummary);
				}

				logger.debug("main-agent", `exec_command cwd="${cwd}" cmd=${JSON.stringify(command)}`);
				try {
					const execFileAsync = promisify(execFile);
					const { stdout, stderr } = await execFileAsync("bash", ["-c", command], {
						cwd,
						timeout,
						maxBuffer: 1024 * 1024,
					});
					let output = stdout + (stderr ? `\n${stderr}` : "");
					if (output.length > MAX_OUTPUT) {
						const totalLen = output.length;
						output = `${output.slice(0, MAX_OUTPUT)}\n\n[Output truncated: ${totalLen} chars total, showing first ${MAX_OUTPUT}]`;
					}
					return { output: output || "(no output)", terminal: false };
				} catch (err: any) {
					if (err.killed || err.signal === "SIGTERM") {
						return {
							output: `[exec_command timeout after ${timeout}ms]\nCommand: ${command}`,
							terminal: false,
						};
					}
					if (err.code === "ENOENT") {
						const pathEnv = process.env.PATH ?? "(unset)";
						logger.error("main-agent", `exec_command ENOENT: bash not found. PATH=${pathEnv}`);
						return {
							output: `exec_command error: bash not found (ENOENT). PATH=${pathEnv}`,
							terminal: false,
						};
					}
					if (err.code !== undefined && typeof err.code === "number") {
						let output = `[exit code: ${err.code}]\n${err.stderr || ""}${err.stdout || ""}`.trim();
						if (output.length > MAX_OUTPUT) {
							const totalLen = output.length;
							output = `${output.slice(0, MAX_OUTPUT)}\n\n[Output truncated: ${totalLen} chars total, showing first ${MAX_OUTPUT}]`;
						}
						return { output, terminal: false };
					}
					logger.error("main-agent", `exec_command unexpected error: ${err.message} ${JSON.stringify(err)}`);
					return { output: `exec_command error: ${err.message}`, terminal: false };
				}
			}

			case "list_agent_tasks": {
				const activeTasks = this.agentMonitor?.getAllTasks() ?? [];
				const pendingEvents = this.workQueue.getAgentEvents();

				const lines: string[] = [];

				if (activeTasks.length > 0) {
					lines.push("## Active Agent Tasks");
					for (const task of activeTasks) {
						const elapsedSeconds = Math.round((Date.now() - task.startedAt) / 1000);
						lines.push(
							`- agent=${task.agentId} task=${task.taskId} status=${task.status} elapsed=${elapsedSeconds}s`,
						);
						lines.push(`  summary: ${task.summary}`);
					}
				}

				if (pendingEvents.length > 0) {
					if (lines.length > 0) lines.push("");
					lines.push("## Pending Events (WorkQueue)");
					for (const evt of pendingEvents) {
						lines.push(
							`- agent=${evt.agentId} task=${evt.taskId} status=${evt.status} duration=${evt.durationSeconds}s`,
						);
						lines.push(`  summary: ${evt.summary}`);
						lines.push(`  detail: ${evt.detail}`);
					}
				}

				if (lines.length === 0) {
					return { output: "No active agent tasks or pending events.", terminal: false };
				}

				return { output: lines.join("\n"), terminal: false };
			}

			default: {
				if (this.skillRegistry) {
					const skillForTool = this.skillRegistry.getByToolName(name);
					if (skillForTool) {
						return { output: skillForTool.body, terminal: false };
					}
				}
				return { output: `Unknown tool: ${name}`, terminal: false };
			}
		}
	}

	private formatSignal(signal: Signal): string {
		const parts: string[] = [`[${signal.type}]`];

		if (signal.analysis) {
			parts.push(`Status: ${signal.analysis.status} (confidence: ${signal.analysis.confidence})`);
			parts.push(`Detail: ${signal.analysis.detail}`);
		}

		if (signal.message) {
			parts.push(`Message: ${signal.message}`);
		}

		parts.push(`--- Pane Content ---\n${signal.paneContent}`);

		return parts.join("\n");
	}
}

function generateAgentName(prefix: string): string {
	const slug = prefix
		.replace(/[^\w\u4e00-\u9fff]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 30)
		.replace(/-$/, "");
	return `cliclaw-${slug || "agent"}`;
}
