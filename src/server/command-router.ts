import type { ContextManager } from "../core/context-manager.js";
import type { MainAgent } from "../core/main-agent.js";
import type { SignalRouter } from "../core/signal-router.js";
import { logger } from "../utils/logger.js";
import type { ChatBroadcaster } from "./chat-broadcaster.js";
import type { CommandDescriptor, CommandRegistry } from "./command-registry.js";
import type { ExecutionEventStore } from "./execution-events.js";
import type { UiEventStore } from "./ui-events.js";

/** Built-in command descriptors registered at construction time */
const BUILTIN_COMMANDS: CommandDescriptor[] = [
	{ name: "stop", description: "停止当前执行任务", category: "builtin" },
	{ name: "resume", description: "恢复上次中断的执行", category: "builtin" },
	{ name: "clear", description: "清空对话历史", category: "builtin" },
	{ name: "reset", description: "重置对话并重新加载提示词和技能", category: "builtin" },
	{ name: "compact", description: "压缩对话历史并注入系统提示词", category: "builtin" },
	{ name: "context", description: "查看上下文用量", category: "builtin" },
];

/**
 * Routes slash commands (/stop, /resume, /clear) to the appropriate handlers.
 * Commands are dispatched from the WebSocket handler, not through the LLM.
 */
export class CommandRouter {
	private mainAgent: MainAgent;
	private signalRouter: SignalRouter;
	private contextManager: ContextManager;
	private broadcaster: ChatBroadcaster;
	private executionEventStore: ExecutionEventStore | null;
	private uiEventStore: UiEventStore | null;
	private onReset: (() => Promise<void>) | null;

	constructor(opts: {
		mainAgent: MainAgent;
		signalRouter: SignalRouter;
		contextManager: ContextManager;
		broadcaster: ChatBroadcaster;
		commandRegistry: CommandRegistry;
		executionEventStore?: ExecutionEventStore;
		uiEventStore?: UiEventStore;
		onReset?: () => Promise<void>;
	}) {
		this.mainAgent = opts.mainAgent;
		this.signalRouter = opts.signalRouter;
		this.contextManager = opts.contextManager;
		this.broadcaster = opts.broadcaster;
		this.executionEventStore = opts.executionEventStore ?? null;
		this.uiEventStore = opts.uiEventStore ?? null;
		this.onReset = opts.onReset ?? null;

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
		this.executionEventStore?.clear();
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
		this.executionEventStore?.clear();
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
}
