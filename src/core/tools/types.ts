import type { AgentAdapter } from "../../agents/adapter.js";
import type { ToolDefinition } from "../../llm/types.js";
import type { MemoryStore } from "../../memory/store.js";
import type { EmbeddingProvider, HybridSearchConfig } from "../../memory/types.js";
import type { AgentStore } from "../../persistence/agent-store.js";
import type { ChatBroadcaster } from "../../server/chat-broadcaster.js";
import type { UiEvent, UiEventType } from "../../server/ui-events.js";
import type { SkillRegistry } from "../../skills/registry.js";
import type { TmuxBridge } from "../../tmux/bridge.js";
import type { StateDetector } from "../../tmux/state-detector.js";
import type { SupportedLocale } from "../../utils/locale.js";
import type { AgentMonitor } from "../agent-monitor.js";
import type { ChangeTracker } from "../change-tracker.js";
import type { LearningPipeline } from "../learning-pipeline.js";
import type { AgentEntry } from "../main-agent.js";
import type { PromptTracker } from "../prompt-tracker.js";
import type { WorkQueue } from "../work-queue.js";

/**
 * A single MainAgent tool: its wire ToolDefinition alongside its handler. Grouping
 * the two keeps them from drifting (the definition used to live ~1000 lines from the
 * switch case that implemented it). Handlers receive a live ToolContext view into
 * MainAgent, never a construction-time snapshot — tests (and runtime) mutate agent
 * state after construction and the handler must see it.
 */
export interface ToolHandler {
	definition: ToolDefinition;
	execute(args: Record<string, any>, ctx: ToolContext): Promise<{ output: string; terminal: boolean }>;
}

/**
 * The exact surface tool handlers need from MainAgent. Implemented by MainAgent so
 * handlers read `this.*` live (agents map, monitor, work queue, etc. can all change
 * after construction). Grouped by concern rather than exposing 25 loose fields.
 */
export interface ToolContext {
	// ─── Agent registry / adapters ─────────────────────
	readonly agents: Map<string, AgentEntry>;
	readonly takenOverAgents: Set<string>;
	readonly adapters: Map<string, AgentAdapter>;
	readonly defaultAdapterName: string;
	activeAgentId: string | null;
	/** Resolve the adapter an agent was launched with, falling back to the default adapter. */
	adapterFor(entry: AgentEntry): AgentAdapter;
	/** Resolve an agent id (or the active one) to its entry, or an error. */
	resolveAgent(agentId?: string): { entry: AgentEntry; id: string } | { error: string };
	/** Remove an agent from all registries. Caller is responsible for onAgentChange(). */
	cleanupAgent(id: string): void;
	/** Return all managed agents with their current status. */
	getActiveAgents(): Array<{
		agentName: string;
		agentId: string;
		paneTarget: string;
		workingDir: string;
		status: string;
		takenOver: boolean;
		adapter: string;
		model: string;
	}>;
	/** Working dir of the active agent (or process.cwd()). */
	getAgentWorkingDir(): string;
	readonly createAgentSettleMs: number;
	notifyAgentChange(): void;

	// ─── Infrastructure ────────────────────────────────
	readonly bridge: TmuxBridge;
	readonly stateDetector: StateDetector;
	readonly broadcaster: ChatBroadcaster;
	/** Locale for user-facing broadcast messages (via server/messages.ts `t()`). */
	readonly locale: SupportedLocale;
	readonly workQueue: WorkQueue;
	readonly agentMonitor: AgentMonitor | null;
	readonly agentStore: AgentStore | null;
	readonly promptTracker: PromptTracker | undefined;
	readonly learningPipeline: LearningPipeline | undefined;
	readonly changeTracker: ChangeTracker | undefined;
	/** Emit a MainAgent event (e.g. "log"). */
	emitLog(message: string): void;
	/** Add a UI event to the store and broadcast it. */
	emitUiEvent(type: UiEventType, summary: string): UiEvent;

	// ─── Memory ────────────────────────────────────────
	readonly memoryStore: MemoryStore | null;
	readonly embeddingProvider: EmbeddingProvider | null;
	readonly searchConfig: HybridSearchConfig;
	readonly syncMemory: (() => Promise<void>) | null;
	readonly globalDir: string;
	resolveMemoryGetTarget(rawPath: string): { storageDir: string; relativePath: string };

	// ─── Skills ────────────────────────────────────────
	readonly skillRegistry: SkillRegistry | null;

	// ─── exec_command broadcast throttle ───────────────
	/** Increment the exec_command broadcast counter and return the new value. */
	incExecCommandBroadcastCount(): number;
}
