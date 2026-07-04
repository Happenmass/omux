import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentAdapter, AgentCharacteristics } from "../../src/agents/adapter.js";
import { ContextManager } from "../../src/core/context-manager.js";
import { MainAgent } from "../../src/core/main-agent.js";
import type { PromptLoader } from "../../src/llm/prompt-loader.js";
import type { LLMStreamEvent } from "../../src/llm/types.js";
import type { TmuxBridge } from "../../src/tmux/bridge.js";

/**
 * Integration test: simulates the full handleMessage → streaming LLM → tool execution flow
 * through the MainAgent state machine.
 *
 * Components wired together:
 *   ContextManager (real) ← MainAgent (real)
 *   LLMClient, Adapter, Bridge, StateDetector, PromptLoader, Broadcaster (mocked)
 */

function createMockPromptLoader(): PromptLoader {
	return {
		getRaw: vi
			.fn()
			.mockReturnValue(
				"You are the Main Agent.\nHistory: {{compressed_history}}\nMemory: {{memory}}\nCapabilities: {{agent_capabilities}}",
			),
		resolve: vi.fn().mockReturnValue("compressor prompt"),
		load: vi.fn().mockResolvedValue(undefined),
		setGlobalContext: vi.fn(),
	} as any;
}

function createMockBroadcaster() {
	return {
		broadcast: vi.fn(),
		addClient: vi.fn(),
		removeClient: vi.fn(),
		getClientCount: vi.fn().mockReturnValue(0),
	} as any;
}

function createMockAdapter(): AgentAdapter {
	return {
		name: "mock",
		displayName: "Mock Agent",
		launch: vi.fn().mockResolvedValue("test-session:0.0"),
		sendPrompt: vi.fn().mockResolvedValue(undefined),
		sendResponse: vi.fn().mockResolvedValue(undefined),
		abort: vi.fn(),
		shutdown: vi.fn().mockResolvedValue(undefined),
		getCharacteristics: vi.fn().mockReturnValue({
			waitingPatterns: [/^>\s*$/m],
			completionPatterns: [/^>\s*$/m],
			errorPatterns: [/Error:/i],
			activePatterns: [/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/],
		} satisfies AgentCharacteristics),
	};
}

function createMockBridge(): TmuxBridge {
	return {
		capturePane: vi.fn().mockResolvedValue({
			content: "mock pane content\n".repeat(50),
			lines: 50,
			timestamp: Date.now(),
		}),
		hasSession: vi.fn().mockResolvedValue(false),
		listOmuxAgents: vi.fn().mockResolvedValue([]),
	} as any;
}

function createMockStateDetector() {
	const callbacks: Array<(analysis: any, content: string) => void> = [];
	return {
		setCharacteristics: vi.fn(),
		captureHash: vi.fn().mockResolvedValue("mock-pre-hash"),
		waitForSettled: vi.fn().mockResolvedValue({
			analysis: { status: "completed", confidence: 0.9, detail: "Agent finished" },
			content: "> task done",
			timedOut: false,
		}),
		onStateChange: vi.fn((cb: any) => {
			callbacks.push(cb);
			return () => {
				const idx = callbacks.indexOf(cb);
				if (idx >= 0) callbacks.splice(idx, 1);
			};
		}),
		startMonitoring: vi.fn(),
		stopMonitoring: vi.fn(),
		analyzeState: vi.fn(),
		deepAnalyze: vi.fn(),
		quickPatternCheck: vi.fn().mockReturnValue(null),
		_callbacks: callbacks,
	} as any;
}

// ─── Streaming helpers ──────────────────────────────

function toolCallEvents(toolName: string, args: Record<string, any>, toolCallId = "tc1", text = ""): LLMStreamEvent[] {
	const events: LLMStreamEvent[] = [];
	if (text) {
		events.push({ type: "text_delta", delta: text });
	}
	events.push({
		type: "tool_call_delta",
		index: 0,
		id: toolCallId,
		name: toolName,
		argumentsDelta: JSON.stringify(args),
	});
	events.push({
		type: "done",
		response: {
			content: text,
			contentBlocks: [
				...(text ? [{ type: "text" as const, text }] : []),
				{ type: "tool_call" as const, id: toolCallId, name: toolName, arguments: args },
			],
			usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
			stopReason: "tool_use",
			model: "test",
		},
	});
	return events;
}

function textResponseEvents(text: string): LLMStreamEvent[] {
	const events: LLMStreamEvent[] = [];
	for (const char of text) {
		events.push({ type: "text_delta", delta: char });
	}
	events.push({
		type: "done",
		response: {
			content: text,
			contentBlocks: [{ type: "text", text }],
			usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
			stopReason: "end_turn",
			model: "test",
		},
	});
	return events;
}

function createMockStreamingLLM(responses: LLMStreamEvent[][]) {
	let callCount = 0;
	return {
		stream: vi.fn().mockImplementation(() => {
			const events = responses[callCount] ?? [];
			callCount++;
			return (async function* () {
				for (const event of events) {
					yield event;
				}
			})();
		}),
		complete: vi.fn(),
		getModel: vi.fn().mockReturnValue("test-model"),
	} as any;
}

describe("Integration: Chat mode end-to-end", () => {
	let promptLoader: ReturnType<typeof createMockPromptLoader>;
	let adapter: AgentAdapter;
	let bridge: ReturnType<typeof createMockBridge>;
	let stateDetector: ReturnType<typeof createMockStateDetector>;
	let broadcaster: ReturnType<typeof createMockBroadcaster>;

	beforeEach(() => {
		promptLoader = createMockPromptLoader();
		adapter = createMockAdapter();
		bridge = createMockBridge();
		stateDetector = createMockStateDetector();
		broadcaster = createMockBroadcaster();
	});

	it("should complete via create_agent → send_to_agent → text response", async () => {
		const llmClient = createMockStreamingLLM([
			toolCallEvents("create_agent", {}, "tc0"),
			toolCallEvents("send_to_agent", { prompt: "Implement the feature", summary: "Implementing feature" }, "tc1"),
			textResponseEvents("Feature implemented successfully."),
		]);

		const contextManager = new ContextManager({ llmClient, promptLoader });

		const mainAgent = new MainAgent({
			contextManager,
			llmClient,
			adapter,
			bridge,
			createAgentSettleMs: 0,
			stateDetector: stateDetector as any,
			broadcaster,
		});
		mainAgent.setupAgentMonitor();

		await mainAgent.handleMessage("Build a feature");

		expect(mainAgent.state).toBe("idle");
		expect(adapter.launch).toHaveBeenCalledTimes(1);
		expect(adapter.sendPrompt).toHaveBeenCalledWith(bridge, "test-session:0.0", "Implement the feature");
		expect(stateDetector.captureHash).toHaveBeenCalled();
		// send_to_agent now dispatches async via AgentMonitor — no direct waitForSettled call
		expect(broadcaster.broadcast).toHaveBeenCalledWith({
			type: "agent_update",
			summary: "Implementing feature",
		});
		expect(broadcaster.broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: "assistant_done" }));
	});

	it("should complete via text response directly (no agent interaction)", async () => {
		const llmClient = createMockStreamingLLM([textResponseEvents("Goal achieved directly.")]);

		const contextManager = new ContextManager({ llmClient, promptLoader });
		const mainAgent = new MainAgent({
			contextManager,
			llmClient,
			adapter,
			bridge,
			createAgentSettleMs: 0,
			stateDetector: stateDetector as any,
			broadcaster,
		});

		await mainAgent.handleMessage("Quick goal");

		expect(mainAgent.state).toBe("idle");
		expect(broadcaster.broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: "assistant_done" }));
	});

	it("should handle multi-step tool use: create_agent → inspect_agent → send_to_agent → text response", async () => {
		const llmClient = createMockStreamingLLM([
			toolCallEvents("create_agent", {}, "tc0"),
			toolCallEvents("inspect_agent", { lines: 200 }, "tc1"),
			toolCallEvents("send_to_agent", { prompt: "Fix the bug", summary: "Fixing bug" }, "tc2"),
			textResponseEvents("Bug fixed."),
		]);

		const contextManager = new ContextManager({ llmClient, promptLoader });
		const mainAgent = new MainAgent({
			contextManager,
			llmClient,
			adapter,
			bridge,
			createAgentSettleMs: 0,
			stateDetector: stateDetector as any,
			broadcaster,
		});
		mainAgent.setupAgentMonitor();

		await mainAgent.handleMessage("Fix bugs");

		expect(mainAgent.state).toBe("idle");
		expect(bridge.capturePane).toHaveBeenCalledWith("test-session:0.0", { startLine: -200 });
		expect(adapter.sendPrompt).toHaveBeenCalledWith(bridge, "test-session:0.0", "Fix the bug");
		// send_to_agent now dispatches async via AgentMonitor — no direct waitForSettled call
	});

	it("should handle goal failure via mark_failed tool", async () => {
		const llmClient = createMockStreamingLLM([
			toolCallEvents("mark_failed", { reason: "Cannot resolve dependency" }, "tc1"),
		]);

		const contextManager = new ContextManager({ llmClient, promptLoader });
		const mainAgent = new MainAgent({
			contextManager,
			llmClient,
			adapter,
			bridge,
			createAgentSettleMs: 0,
			stateDetector: stateDetector as any,
			broadcaster,
		});

		await mainAgent.handleMessage("Attempt something");

		expect(mainAgent.state).toBe("idle");
		expect(broadcaster.broadcast).toHaveBeenCalledWith(
			expect.objectContaining({ type: "system", message: expect.stringContaining("Task failed") }),
		);
	});

	it("should handle escalate_to_human as terminal tool", async () => {
		const llmClient = createMockStreamingLLM([
			toolCallEvents("escalate_to_human", { reason: "Need permission to delete files" }, "tc1"),
		]);

		const contextManager = new ContextManager({ llmClient, promptLoader });
		const mainAgent = new MainAgent({
			contextManager,
			llmClient,
			adapter,
			bridge,
			createAgentSettleMs: 0,
			stateDetector: stateDetector as any,
			broadcaster,
		});

		await mainAgent.handleMessage("Cleanup project");

		expect(mainAgent.state).toBe("idle");
		expect(broadcaster.broadcast).toHaveBeenCalledWith(
			expect.objectContaining({ type: "system", message: expect.stringContaining("Human intervention needed") }),
		);
	});
});
