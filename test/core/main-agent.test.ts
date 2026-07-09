import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MainAgent } from "../../src/core/main-agent.js";
import type { LLMStreamEvent } from "../../src/llm/types.js";

// ─── Mock factories ──────────────────────────────────

function createMockContextManager() {
	return {
		addMessage: vi.fn(),
		getMessages: vi.fn().mockReturnValue([]),
		getSystemPrompt: vi.fn().mockReturnValue("You are the Main Agent"),
		updateModule: vi.fn(),
		shouldCompress: vi.fn().mockReturnValue(false),
		compress: vi.fn(),
		getConversationLength: vi.fn().mockReturnValue(0),
		prepareForLLM: vi.fn().mockReturnValue({
			system: "You are the Main Agent",
			messages: [],
		}),
		reportUsage: vi.fn(),
		shouldRunMemoryFlush: vi.fn().mockReturnValue(false),
		runMemoryFlush: vi.fn(),
		getCurrentTokenEstimate: vi.fn().mockReturnValue(0),
		getContextWindowLimit: vi.fn().mockReturnValue(200000),
		// Stable conversation_id for the OpenAI Responses prompt_cache_key path. The mock
		// returns a fixed value so byte-equality assertions in caller-level tests remain
		// deterministic; provider-level tests are in test/llm/openai-responses.test.ts.
		getConversationId: vi.fn().mockReturnValue("test-conversation-id"),
		// Stub for the compact-tuning hand-off. MainAgent calls this at construction time so
		// `compress()` can run on-chain with cache reuse. Tests don't exercise compression
		// here — provider-level cache behavior is tested in test/llm/openai-responses.test.ts
		// and the in-chain shape is tested in test/core/context-manager.test.ts.
		setCompactTuning: vi.fn(),
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

/**
 * Create a mock LLM client that returns streaming responses.
 * Each entry in `responses` is an array of LLMStreamEvents.
 */
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
	} as any;
}

function createMockAdapter() {
	return {
		name: "test-agent",
		displayName: "Test Agent",
		defaultModel: "test-model",
		launch: vi.fn().mockResolvedValue("test-session:0.0"),
		sendPrompt: vi.fn().mockResolvedValue(undefined),
		sendResponse: vi.fn().mockResolvedValue(undefined),
		abort: vi.fn(),
		getCharacteristics: vi.fn().mockReturnValue({
			waitingPatterns: [],
			completionPatterns: [],
			errorPatterns: [],
			activePatterns: [],
		}),
	} as any;
}

function createMockBridge() {
	return {
		capturePane: vi.fn().mockResolvedValue({
			content: "pane content\n".repeat(10),
			lines: 50,
			timestamp: Date.now(),
		}),
		hasSession: vi.fn().mockResolvedValue(false),
		listOmuxAgents: vi.fn().mockResolvedValue([]),
		createSession: vi.fn().mockResolvedValue(undefined),
		sendEscape: vi.fn().mockResolvedValue(undefined),
	} as any;
}

function createMockStateDetector() {
	return {
		setCharacteristics: vi.fn(),
		captureHash: vi.fn().mockResolvedValue("mock-pre-hash"),
		waitForSettled: vi.fn().mockResolvedValue({
			analysis: { status: "completed", confidence: 0.9, detail: "Agent finished" },
			content: "> task done",
			timedOut: false,
		}),
		startMonitoring: vi.fn(),
		stopMonitoring: vi.fn(),
		onStateChange: vi.fn().mockReturnValue(() => {}),
	} as any;
}

// ─── Helper: build streaming events ────────────────────

function textResponse(text: string): LLMStreamEvent[] {
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

function toolCallResponse(
	toolName: string,
	args: Record<string, any>,
	toolCallId = "tc1",
	text = "",
): LLMStreamEvent[] {
	const events: LLMStreamEvent[] = [];
	if (text) {
		events.push({ type: "text_delta", delta: text });
	}
	const argsJson = JSON.stringify(args);
	events.push({
		type: "tool_call_delta",
		index: 0,
		id: toolCallId,
		name: toolName,
		argumentsDelta: argsJson,
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

function createDeferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

// ─── Tests ─────────────────────────────────────────────

describe("MainAgent State Machine", () => {
	let mockCtx: ReturnType<typeof createMockContextManager>;
	let mockBroadcaster: ReturnType<typeof createMockBroadcaster>;
	let mockAdapter: ReturnType<typeof createMockAdapter>;
	let mockBridge: ReturnType<typeof createMockBridge>;
	let mockDetector: ReturnType<typeof createMockStateDetector>;

	function setupAgent(
		responses: LLMStreamEvent[][],
		overrides: Record<string, any> = {},
		{ withMonitor = false }: { withMonitor?: boolean } = {},
	) {
		mockCtx = createMockContextManager();
		mockBroadcaster = createMockBroadcaster();
		mockAdapter = createMockAdapter();
		mockBridge = createMockBridge();
		mockDetector = createMockStateDetector();

		const mockLLM = createMockStreamingLLM(responses);

		const agent = new MainAgent({
			contextManager: mockCtx,
			llmClient: mockLLM,
			adapter: mockAdapter,
			bridge: mockBridge,
			createAgentSettleMs: 0,
			stateDetector: mockDetector,
			broadcaster: mockBroadcaster,
			...overrides,
		});

		if (withMonitor) {
			agent.setupAgentMonitor();
		}

		return agent;
	}

	describe("initial state", () => {
		it("should start in idle state", () => {
			const agent = setupAgent([]);
			expect(agent.state).toBe("idle");
		});
	});

	describe("handleMessage in IDLE state", () => {
		it("should add user message to conversation", async () => {
			const agent = setupAgent([textResponse("Hello!")]);
			await agent.handleMessage("hi");

			expect(mockCtx.addMessage).toHaveBeenCalledWith(expect.objectContaining({ role: "user", content: "hi" }));
		});

		it("should stream text response and stay idle", async () => {
			const agent = setupAgent([textResponse("Hello there!")]);
			await agent.handleMessage("hi");

			// Should broadcast deltas
			const deltaCalls = mockBroadcaster.broadcast.mock.calls.filter((c: any) => c[0].type === "assistant_delta");
			expect(deltaCalls.length).toBeGreaterThan(0);

			// Should broadcast assistant_done
			expect(mockBroadcaster.broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: "assistant_done" }));

			// Should stay idle
			expect(agent.state).toBe("idle");
		});

		it("should enter executing state when LLM returns tool calls", async () => {
			const agent = setupAgent([toolCallResponse("mark_failed", { reason: "test" })]);

			await agent.handleMessage("do something");

			// Terminal tool → back to idle
			expect(agent.state).toBe("idle");

			// Should have been in executing state (verified by state broadcast)
			const stateCalls = mockBroadcaster.broadcast.mock.calls.filter((c: any) => c[0].type === "state");
			expect(stateCalls).toContainEqual([
				expect.objectContaining({ type: "state", state: "executing", queueSize: expect.any(Number) }),
			]);
			expect(stateCalls).toContainEqual([
				expect.objectContaining({ type: "state", state: "idle", queueSize: expect.any(Number) }),
			]);
		});

		it("should serialize concurrent idle messages", async () => {
			mockCtx = createMockContextManager();
			mockBroadcaster = createMockBroadcaster();
			mockAdapter = createMockAdapter();
			mockBridge = createMockBridge();
			mockDetector = createMockStateDetector();

			const firstStreamGate = createDeferred();
			let callCount = 0;
			let activeStreams = 0;
			let maxConcurrentStreams = 0;

			const mockLLM = {
				stream: vi.fn().mockImplementation(() => {
					const currentCall = callCount++;
					const text = currentCall === 0 ? "First reply" : "Second reply";

					return (async function* () {
						activeStreams++;
						maxConcurrentStreams = Math.max(maxConcurrentStreams, activeStreams);
						try {
							if (currentCall === 0) {
								await firstStreamGate.promise;
							}
							for (const char of text) {
								yield { type: "text_delta", delta: char } as const;
							}
							yield {
								type: "done" as const,
								response: {
									content: text,
									contentBlocks: [{ type: "text" as const, text }],
									usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
									stopReason: "end_turn",
									model: "test",
								},
							};
						} finally {
							activeStreams--;
						}
					})();
				}),
				complete: vi.fn(),
			};

			const agent = new MainAgent({
				contextManager: mockCtx,
				llmClient: mockLLM as any,
				adapter: mockAdapter,
				bridge: mockBridge,
				createAgentSettleMs: 0,
				stateDetector: mockDetector,
				broadcaster: mockBroadcaster,
			});

			const firstPromise = agent.handleMessage("first");
			const secondPromise = agent.handleMessage("second");

			await Promise.resolve();
			firstStreamGate.resolve();

			await Promise.all([firstPromise, secondPromise]);

			expect(maxConcurrentStreams).toBe(1);
			expect(mockCtx.addMessage.mock.calls).toEqual([
				[{ role: "user", content: "first" }],
				[{ role: "assistant", content: "First reply" }],
				[{ role: "user", content: "second" }],
				[{ role: "assistant", content: "Second reply" }],
			]);
			expect(mockBroadcaster.broadcast).toHaveBeenCalledWith({
				type: "system",
				message: "Message queued; it will be handled after the current operation completes",
			});
		});
	});

	describe("handleMessage in EXECUTING state", () => {
		it("should queue message and send system notification", async () => {
			// Setup: first call returns a tool that blocks (create_agent + send_to_agent)
			// But simpler: just set the state to executing manually by sending a message that triggers tools
			const agent = setupAgent(
				[
					toolCallResponse("create_agent", {}, "tc0"),
					toolCallResponse("send_to_agent", { prompt: "work", summary: "Working" }, "tc1"),
					textResponse("Done"),
				],
				{},
				{ withMonitor: true },
			);

			// Start a task that will enter EXECUTING
			const handlePromise = agent.handleMessage("do a task");

			// Wait for it to complete
			await handlePromise;

			// The agent should be back to idle after text response
			expect(agent.state).toBe("idle");
		});
	});

	describe("IDLE → EXECUTING → IDLE flow", () => {
		it("should complete full flow: text + tool call → execute → text response → idle", async () => {
			const agent = setupAgent(
				[
					// First LLM call: tool call
					toolCallResponse("create_agent", {}, "tc0", "I'll create a session."),
					// Second LLM call (after create_agent result): send_to_agent (returns immediately)
					toolCallResponse(
						"send_to_agent",
						{ prompt: "implement feature", summary: "Implementing feature" },
						"tc1",
					),
					// Third LLM call (after send_to_agent dispatch result): text response → idle
					textResponse("Feature implemented successfully."),
				],
				{},
				{ withMonitor: true },
			);

			await agent.handleMessage("implement the feature");

			expect(agent.state).toBe("idle");

			// Check assistant_done was broadcast
			expect(mockBroadcaster.broadcast).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "assistant_done",
				}),
			);
		});
	});

	describe("tool summary broadcasting", () => {
		it("should broadcast agent_update for send_to_agent with summary", async () => {
			const agent = setupAgent(
				[
					toolCallResponse("create_agent", {}, "tc0"),
					toolCallResponse("send_to_agent", { prompt: "add auth", summary: "Adding JWT auth" }, "tc1"),
					textResponse("Done"),
				],
				{},
				{ withMonitor: true },
			);

			await agent.handleMessage("add auth");

			expect(mockBroadcaster.broadcast).toHaveBeenCalledWith({
				type: "agent_update",
				summary: "Adding JWT auth",
			});
		});
	});

	describe("stopRequested between rounds", () => {
		it("should stop executing loop when stopRequested is set", async () => {
			const agent = setupAgent([
				toolCallResponse("create_agent", {}, "tc0"),
				// After this tool, stopRequested will be true
				toolCallResponse("inspect_agent", { lines: 100 }, "tc1"),
			]);

			// Simulate /stop landing during execution: false on the first between-round
			// check, true afterwards (the latch now lives on MainAgent itself).
			let stopCallCount = 0;
			vi.spyOn(agent, "isStopRequested").mockImplementation(() => {
				stopCallCount++;
				return stopCallCount > 1;
			});

			await agent.handleMessage("do stuff");

			// Should be back to idle due to stop
			expect(agent.state).toBe("idle");

			// Should broadcast system message about stop
			expect(mockBroadcaster.broadcast).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "system",
					message: "Execution stopped",
				}),
			);
		});

		it("requestStop aborts the in-flight LLM stream and returns to idle immediately", async () => {
			// A stream that hangs mid-response until aborted. Yields one delta, then parks on a
			// promise that only rejects with an AbortError when the caller's signal fires —
			// modeling a long model response that /stop should cut off before completion.
			const streamStarted = createDeferred();
			const llm = {
				stream: vi.fn().mockImplementation((_messages: any, opts: any) => {
					const signal: AbortSignal | undefined = opts?.signal;
					return (async function* () {
						yield { type: "text_delta", delta: "thinking" } as LLMStreamEvent;
						streamStarted.resolve();
						await new Promise<void>((_res, rej) => {
							signal?.addEventListener("abort", () => {
								const e = new Error("aborted");
								e.name = "AbortError";
								rej(e);
							});
						});
					})();
				}),
				complete: vi.fn(),
			} as any;

			const agent = setupAgent([], { llmClient: llm });

			const done = agent.handleMessage("do a long task");
			await streamStarted.promise; // stream is now parked mid-response
			expect(agent.state).toBe("executing");

			agent.requestStop();
			await done;

			// Aborted cleanly: back to idle, latch cleared, no partial assistant message persisted.
			expect(agent.state).toBe("idle");
			expect(agent.isStopRequested()).toBe(false);
			expect(mockBroadcaster.broadcast).toHaveBeenCalledWith(
				expect.objectContaining({ type: "system", message: "Execution stopped" }),
			);
			expect(mockCtx.addMessage).not.toHaveBeenCalledWith(expect.objectContaining({ role: "assistant" }));
		});
	});

	describe("execution control (stop latch)", () => {
		it("tracks requestStop / clearStopRequest / isStopRequested", () => {
			const agent = setupAgent([]);
			expect(agent.isStopRequested()).toBe(false);
			agent.requestStop();
			expect(agent.isStopRequested()).toBe(true);
			agent.clearStopRequest();
			expect(agent.isStopRequested()).toBe(false);
		});

		it("MA-1: a stale stop request is cleared when a fresh user message dispatches", async () => {
			const agent = setupAgent([
				toolCallResponse("inspect_agent", { lines: 100 }, "tc1"),
				textResponse("All good."),
			]);
			agent.setPaneTarget("test:0.0");

			// /stop raced the loop's return to idle: the flag is latched while nothing executes.
			agent.requestStop();
			expect(agent.isStopRequested()).toBe(true);

			await agent.handleMessage("check status");

			// The fresh message supersedes the stale stop: NO truncation after one tool round.
			expect(agent.isStopRequested()).toBe(false);
			expect(agent.state).toBe("idle");
			const stopMsgs = mockBroadcaster.broadcast.mock.calls.filter(
				(c: any) => c[0].type === "system" && c[0].message === "Execution stopped",
			);
			expect(stopMsgs).toHaveLength(0);
			// Both LLM rounds ran (tool round + final text round).
			expect(mockCtx.addMessage).toHaveBeenCalledWith(
				expect.objectContaining({ role: "assistant", content: "All good." }),
			);
		});

		it("MA-1: a stop requested mid-execution still halts the loop between rounds", async () => {
			const agent = setupAgent([
				toolCallResponse("inspect_agent", { lines: 100 }, "tc1"),
				textResponse("should never be reached"),
			]);
			agent.setPaneTarget("test:0.0");

			// Latch the stop while the first tool round is executing (i.e. after dispatch
			// consumed any stale flag): hook the pane capture that inspect_agent performs.
			mockBridge.capturePane.mockImplementation(async () => {
				agent.requestStop();
				return { content: "pane content", lines: 50, timestamp: Date.now() };
			});

			await agent.handleMessage("check status");

			expect(agent.state).toBe("idle");
			expect(agent.isStopRequested()).toBe(false); // consumed by the loop
			expect(mockBroadcaster.broadcast).toHaveBeenCalledWith(
				expect.objectContaining({ type: "system", message: "Execution stopped" }),
			);
			expect(mockCtx.addMessage).not.toHaveBeenCalledWith(
				expect.objectContaining({ role: "assistant", content: "should never be reached" }),
			);
		});
	});

	describe("terminal tools return to IDLE", () => {
		it("mark_failed should return to idle", async () => {
			const agent = setupAgent([toolCallResponse("mark_failed", { reason: "Cannot proceed" })]);

			await agent.handleMessage("do task");
			expect(agent.state).toBe("idle");
		});

		it("escalate_to_human should return to idle", async () => {
			const agent = setupAgent([toolCallResponse("escalate_to_human", { reason: "Need confirmation" })]);

			await agent.handleMessage("do dangerous thing");
			expect(agent.state).toBe("idle");
		});
	});

	describe("interrupt_agent tool", () => {
		it("should abort via the adapter and cleanup agent monitor task", async () => {
			const agent = setupAgent(
				[
					toolCallResponse("create_agent", {}, "tc0"),
					toolCallResponse("interrupt_agent", { summary: "Agent is modifying wrong file" }, "tc1"),
					textResponse("Interrupted, will redirect."),
				],
				{},
				{ withMonitor: true },
			);

			await agent.handleMessage("do task");

			expect(agent.state).toBe("idle");

			// Should broadcast system message about interrupt
			expect(mockBroadcaster.broadcast).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "system",
					message: expect.stringContaining("Interrupting agent"),
				}),
			);

			// MA-6: must go through the adapter contract (double Escape etc.), not a raw
			// single bridge.sendEscape.
			expect(mockAdapter.abort).toHaveBeenCalledWith(mockBridge, "test-session:0.0");
			expect(mockBridge.sendEscape).not.toHaveBeenCalled();
		});
	});

	describe("respond_to_agent preHash ordering", () => {
		it("MA-3: captures preHash BEFORE sendResponse so a fast-settling agent cannot wedge Phase 1", async () => {
			const agent = setupAgent(
				[
					toolCallResponse("respond_to_agent", { value: "1", summary: "Picking menu option" }, "tc1"),
					textResponse("Response sent."),
					textResponse("Agent settled."),
				],
				{},
				{ withMonitor: true },
			);
			agent.setPaneTarget("test:0.0", "omux-menu");

			// Inject a waiting_input task so respond_to_agent passes its status gate.
			(agent as any).agentMonitor.tasks.set("omux-menu", {
				taskId: "task_1",
				agentId: "omux-menu",
				status: "waiting_input",
				summary: "test",
				taskContext: "test",
				preHash: "old-hash",
				startedAt: Date.now(),
				abortController: new AbortController(),
			});
			(agent as any).agentMonitor.paneTargets.set("omux-menu", "test:0.0");

			const order: string[] = [];
			mockDetector.captureHash.mockImplementation(async () => {
				order.push("captureHash");
				return "pre-send-hash";
			});
			mockAdapter.sendResponse.mockImplementation(async () => {
				order.push("sendResponse");
			});
			const resumeSpy = vi.spyOn((agent as any).agentMonitor, "resumeTask");

			await agent.handleMessage("answer the menu");

			// The pre-send pane is the baseline: the response echo itself satisfies Phase 1.
			expect(order).toEqual(["captureHash", "sendResponse"]);
			expect(resumeSpy).toHaveBeenCalledWith("omux-menu", "pre-send-hash");
		});

		// ── MT-5: a malformed value now THROWS in the adapter (strict arrow:/keys: grammar).
		//     The paired-tool-result guard must convert that throw into a readable tool result,
		//     never a dangling function_call. ──
		it("surfaces an adapter throw (malformed directive) as a readable error tool result", async () => {
			const agent = setupAgent(
				[
					toolCallResponse("respond_to_agent", { value: "arrow:sideways", summary: "bad directive" }, "call_x"),
					textResponse("Recovered."),
				],
				{},
				{ withMonitor: true },
			);
			agent.setPaneTarget("test:0.0", "omux-menu");
			(agent as any).agentMonitor.tasks.set("omux-menu", {
				taskId: "task_1",
				agentId: "omux-menu",
				status: "waiting_input",
				summary: "test",
				taskContext: "test",
				preHash: "old-hash",
				startedAt: Date.now(),
				abortController: new AbortController(),
			});
			(agent as any).agentMonitor.paneTargets.set("omux-menu", "test:0.0");

			// Simulate the strict adapter rejecting a malformed arrow directive.
			mockAdapter.sendResponse.mockRejectedValue(
				new Error('Invalid arrow directive "arrow:sideways". Expected "arrow:up" or "arrow:down".'),
			);

			await agent.handleMessage("respond badly");

			// The throw must be recorded as a paired tool result (same call id), readable, non-terminal.
			const toolMsg = mockCtx.addMessage.mock.calls
				.map((c: any) => c[0])
				.find((m: any) => m.role === "tool" && m.toolCallId === "call_x");
			expect(toolMsg).toBeDefined();
			expect(toolMsg.content).toMatch(/failed/i);
			expect(toolMsg.content).toContain("arrow");
			// The loop recovered to idle instead of wedging on a dangling call.
			expect(agent.state).toBe("idle");
		});
	});

	describe("LLM response with no tool calls exits EXECUTING", () => {
		it("should return to idle when LLM returns only text in tool loop", async () => {
			const agent = setupAgent([
				// First call: tool call to enter EXECUTING
				toolCallResponse("inspect_agent", { lines: 100 }, "tc1"),
				// Second call: only text (no tools) → exit EXECUTING
				textResponse("All looks good, nothing more to do."),
			]);

			// Need a pane target for inspect_agent
			agent.setPaneTarget("test:0.0");

			await agent.handleMessage("check status");

			expect(agent.state).toBe("idle");
		});
	});

	describe("compression check between tool rounds", () => {
		it("should trigger compression when threshold exceeded", async () => {
			const agent = setupAgent([toolCallResponse("create_agent", {}, "tc0"), textResponse("Done")]);

			mockCtx.shouldCompress.mockReturnValue(true);

			await agent.handleMessage("do task");

			expect(mockCtx.compress).toHaveBeenCalled();
		});

		// ── MT-4: auto-compaction must NOT wipe the visible chat transcript. Unlike the
		//     /clear COMMAND path, it emits a system divider instead of {type:"clear"}. ──
		it("auto-compaction between rounds emits a divider, never {type:'clear'}", async () => {
			const agent = setupAgent([toolCallResponse("create_agent", {}, "tc0"), textResponse("Done")]);

			mockCtx.shouldCompress.mockReturnValue(true);

			await agent.handleMessage("do task");

			expect(mockCtx.compress).toHaveBeenCalled();
			// The web UI transcript must survive: no clear broadcast on the compaction path.
			const broadcasts = mockBroadcaster.broadcast.mock.calls.map((c: any) => c[0]);
			expect(broadcasts.some((m: any) => m.type === "clear")).toBe(false);
			// A system divider is surfaced instead so the user knows earlier turns were summarized.
			expect(broadcasts).toContainEqual(
				expect.objectContaining({ type: "system", message: expect.stringContaining("compacted") }),
			);
		});

		it("pre-turn auto-compaction also emits a divider, never {type:'clear'}", async () => {
			// shouldCompress true at the very start of streamLLMResponse (before the first LLM call).
			const agent = setupAgent([textResponse("Answer")]);
			mockCtx.shouldCompress.mockReturnValue(true);

			await agent.handleMessage("hello");

			expect(mockCtx.compress).toHaveBeenCalled();
			const broadcasts = mockBroadcaster.broadcast.mock.calls.map((c: any) => c[0]);
			expect(broadcasts.some((m: any) => m.type === "clear")).toBe(false);
			expect(broadcasts).toContainEqual(
				expect.objectContaining({ type: "system", message: expect.stringContaining("compacted") }),
			);
		});
	});

	describe("error recovery", () => {
		it("should recover to idle when handleMessage fails during executing", async () => {
			const agent = setupAgent([toolCallResponse("inspect_agent", { lines: 100 }, "tc1")]);
			agent.setPaneTarget("test:0.0");

			mockCtx.shouldRunMemoryFlush.mockReturnValueOnce(false).mockReturnValue(true);
			mockCtx.runMemoryFlush.mockRejectedValue(new Error("flush failed"));

			// dispatchNext catches and recovers from errors internally
			await agent.handleMessage("check status");
			expect(agent.state).toBe("idle");
			expect(mockBroadcaster.broadcast).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "state",
					state: "executing",
					queueSize: expect.any(Number),
				}),
			);
			expect(mockBroadcaster.broadcast).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "state",
					state: "idle",
					queueSize: expect.any(Number),
				}),
			);
			// MA-5: the failure must be surfaced to the user, not swallowed silently.
			expect(mockBroadcaster.broadcast).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "system",
					message: expect.stringContaining("flush failed"),
				}),
			);
		});

		it("records a paired tool result when a tool throws (prevents dangling function_call poison)", async () => {
			// exec_command with no `command` (simulates the model streaming truncated JSON
			// args) throws deep in the handler. The loop guard must still record a `tool`
			// message paired with the call id so the Responses API never sees a dangling call.
			const agent = setupAgent([toolCallResponse("exec_command", {}, "call_k28")]);

			await agent.handleMessage("run something");

			const toolMsg = mockCtx.addMessage.mock.calls
				.map((c: any) => c[0])
				.find((m: any) => m.role === "tool" && m.toolCallId === "call_k28");
			expect(toolMsg).toBeDefined();
			expect(toolMsg.content).toMatch(/failed/i);
			expect(agent.state).toBe("idle");
		});
	});

	describe("kill_agent tool", () => {
		it("should call adapter.exitAgent then kill tmux and return resume id", async () => {
			const agent = setupAgent([
				toolCallResponse("kill_agent", { summary: "Exiting to save session" }),
				textResponse("Agent exited successfully."),
			]);
			agent.setPaneTarget("test:0.0");

			mockAdapter.exitAgent = vi.fn().mockResolvedValue({
				content: "Resume this session with:\nclaude --resume abc-123",
				resumeId: "abc-123",
			});
			mockBridge.hasSession.mockResolvedValue(true);
			mockBridge.killSession = vi.fn().mockResolvedValue(undefined);

			await agent.handleMessage("exit agent");

			expect(mockAdapter.exitAgent).toHaveBeenCalledWith(mockBridge, "test:0.0");
			expect(mockBridge.killSession).toHaveBeenCalled();
			expect(agent.state).toBe("idle");
		});

		it("should return error when no active agent", async () => {
			const agent = setupAgent([
				toolCallResponse("kill_agent", { summary: "Exiting" }),
				textResponse("No session."),
			]);
			// Do NOT set paneTarget

			await agent.handleMessage("exit agent");

			// Should not crash, agent returns to idle via text response
			expect(agent.state).toBe("idle");
		});

		it("should succeed without exitAgent by falling back to tmux kill", async () => {
			const agent = setupAgent([toolCallResponse("kill_agent", { summary: "Exiting" }), textResponse("Killed.")]);
			agent.setPaneTarget("test:0.0");

			// Ensure no exitAgent on adapter
			delete mockAdapter.exitAgent;
			mockBridge.hasSession.mockResolvedValue(true);
			mockBridge.killSession = vi.fn().mockResolvedValue(undefined);

			await agent.handleMessage("exit agent");

			expect(mockBridge.killSession).toHaveBeenCalled();
			expect(agent.state).toBe("idle");
		});

		it("should succeed even if exitAgent throws", async () => {
			const agent = setupAgent([toolCallResponse("kill_agent", { summary: "Exiting" }), textResponse("Killed.")]);
			agent.setPaneTarget("test:0.0");

			mockAdapter.exitAgent = vi.fn().mockRejectedValue(new Error("agent crashed"));
			mockBridge.hasSession.mockResolvedValue(true);
			mockBridge.killSession = vi.fn().mockResolvedValue(undefined);

			await agent.handleMessage("exit agent");

			expect(mockBridge.killSession).toHaveBeenCalled();
			expect(agent.state).toBe("idle");
		});

		// ── MT-1: kill_agent "all" must respect the taken-over guard and not touch
		//     tmux sessions this process does not manage. ──
		it('kill_agent "all" must NOT kill human-taken-over agents and reports them skipped', async () => {
			const agent = setupAgent(
				[toolCallResponse("kill_agent", { agent_id: "all", summary: "kill all" }, "tc1"), textResponse("Done.")],
				{},
				{ withMonitor: true },
			);
			agent.restoreAgent("omux-free", { paneTarget: "free:0.0", workingDir: "/free" });
			agent.restoreAgent("omux-taken", { paneTarget: "taken:0.0", workingDir: "/taken" });
			agent.setTakenOver("omux-taken", true);

			mockAdapter.exitAgent = vi.fn().mockResolvedValue({ content: "exited", resumeId: null });
			mockBridge.listOmuxAgents.mockResolvedValue([
				{ name: "omux-free", windows: 1, attached: false },
				{ name: "omux-taken", windows: 1, attached: false },
			]);
			mockBridge.killSession = vi.fn().mockResolvedValue(undefined);

			await agent.handleMessage("kill everything");

			// The taken-over session must survive; only the free agent is killed.
			expect(mockBridge.killSession).toHaveBeenCalledWith("omux-free");
			expect(mockBridge.killSession).not.toHaveBeenCalledWith("omux-taken");
			expect(agent.isTakenOver("omux-taken")).toBe(true);
			// The taken-over agent is still in the registry (not cleaned up).
			expect(agent.getActiveAgents().map((a) => a.agentName)).toContain("omux-taken");

			// The tool result names the skipped agent.
			const toolResult = mockCtx.addMessage.mock.calls
				.map((c: any) => c[0])
				.find(
					(m: any) => m.role === "tool" && typeof m.content === "string" && m.content.includes("omux-taken"),
				);
			expect(toolResult).toBeTruthy();
			expect(toolResult.content).toMatch(/[Ss]kipped/);
		});

		it('kill_agent "all" must NOT kill unmanaged omux-* tmux sessions and lists them left untouched', async () => {
			const agent = setupAgent(
				[toolCallResponse("kill_agent", { agent_id: "all", summary: "kill all" }, "tc1"), textResponse("Done.")],
				{},
				{ withMonitor: true },
			);
			// Only omux-mine is managed; omux-other belongs to another omux instance.
			agent.restoreAgent("omux-mine", { paneTarget: "mine:0.0", workingDir: "/mine" });

			mockAdapter.exitAgent = vi.fn().mockResolvedValue({ content: "exited", resumeId: null });
			mockBridge.listOmuxAgents.mockResolvedValue([
				{ name: "omux-mine", windows: 1, attached: false },
				{ name: "omux-other", windows: 1, attached: false },
			]);
			mockBridge.killSession = vi.fn().mockResolvedValue(undefined);

			await agent.handleMessage("kill everything");

			expect(mockBridge.killSession).toHaveBeenCalledWith("omux-mine");
			expect(mockBridge.killSession).not.toHaveBeenCalledWith("omux-other");

			const toolResult = mockCtx.addMessage.mock.calls
				.map((c: any) => c[0])
				.find(
					(m: any) => m.role === "tool" && typeof m.content === "string" && m.content.includes("omux-other"),
				);
			expect(toolResult).toBeTruthy();
			expect(toolResult.content).toMatch(/[Ll]eft untouched/);
		});
	});

	describe("persistent_memory tool", () => {
		it("should read persistent memory file", async () => {
			const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
			const { tmpdir } = await import("node:os");
			const { join } = await import("node:path");
			const tempDir = await mkdtemp(join(tmpdir(), "pm-test-"));

			try {
				const globalDir = join(tempDir, "global");
				const { mkdir } = await import("node:fs/promises");
				await mkdir(globalDir, { recursive: true });
				await writeFile(join(globalDir, "MEMORY.md"), "# Memory\n\n## User Profile\n- Test user\n");

				const agent = setupAgent(
					[
						toolCallResponse("persistent_memory", { action: "read", scope: "global" }),
						textResponse("Here is your memory."),
					],
					{ globalDir, workspaceDir: tempDir },
				);

				await agent.handleMessage("show memory");

				// Tool result should contain the memory content
				const addMessageCalls = mockCtx.addMessage.mock.calls;
				const toolResultCall = addMessageCalls.find(
					(c: any) =>
						c[0].role === "tool" && typeof c[0].content === "string" && c[0].content.includes("Test user"),
				);
				expect(toolResultCall).toBeTruthy();
			} finally {
				await rm(tempDir, { recursive: true, force: true });
			}
		});

		it("should NOT hot-reload {{memory}} on global writes — write lands on disk, but the system prompt snapshot stays byte-stable for prompt-cache hits (refresh deferred to /clear, /compact, /reset)", async () => {
			const { mkdtemp, rm, mkdir, readFile } = await import("node:fs/promises");
			const { tmpdir } = await import("node:os");
			const { join } = await import("node:path");
			const tempDir = await mkdtemp(join(tmpdir(), "pm-test-"));

			try {
				const globalDir = join(tempDir, "global");
				const workspaceDir = join(tempDir, "workspace");
				await mkdir(globalDir, { recursive: true });
				await mkdir(join(workspaceDir, ".omux"), { recursive: true });

				const agent = setupAgent(
					[
						toolCallResponse("persistent_memory", {
							action: "update",
							scope: "global",
							section: "user_profile",
							operation: "append",
							content: "Remember this",
						}),
						textResponse("Remembered."),
					],
					{ globalDir, workspaceDir },
				);

				await agent.handleMessage("remember this");

				// Disk write must have happened — that's the source of truth.
				const onDisk = await readFile(join(globalDir, "MEMORY.md"), "utf8");
				expect(onDisk).toContain("Remember this");

				// But the {{memory}} module in the system prompt must NOT have been hot-reloaded.
				// (No call to updateModule with key "memory" anywhere in this turn.)
				const memoryModuleCalls = mockCtx.updateModule.mock.calls.filter((c: any) => c[0] === "memory");
				expect(memoryModuleCalls).toHaveLength(0);

				// The agent should have been told via the tool result that the snapshot is stale-by-design.
				const addMessageCalls = mockCtx.addMessage.mock.calls;
				const toolResultCall = addMessageCalls.find(
					(c: any) =>
						c[0].role === "tool" &&
						typeof c[0].content === "string" &&
						c[0].content.includes("snapshot is intentionally NOT refreshed"),
				);
				expect(toolResultCall).toBeTruthy();
			} finally {
				await rm(tempDir, { recursive: true, force: true });
			}
		});

		it("should NOT hot-reload {{memory}} on project-scope writes (even when project_dir matches launch workspace)", async () => {
			const { mkdtemp, rm, mkdir, writeFile } = await import("node:fs/promises");
			const { tmpdir } = await import("node:os");
			const { join } = await import("node:path");
			const tempDir = await mkdtemp(join(tmpdir(), "pm-test-"));

			try {
				const globalDir = join(tempDir, "global");
				const workspaceDir = join(tempDir, "workspace");
				await mkdir(globalDir, { recursive: true });
				await mkdir(join(workspaceDir, ".omux"), { recursive: true });
				// Project marker so validateProjectDir passes
				await writeFile(join(workspaceDir, "package.json"), "{}");

				const agent = setupAgent(
					[
						toolCallResponse("persistent_memory", {
							action: "update",
							scope: "project",
							project_dir: workspaceDir,
							section: "active_notes",
							operation: "append",
							content: "Project note",
						}),
						textResponse("Recorded."),
					],
					{ globalDir, workspaceDir },
				);

				await agent.handleMessage("remember this");

				const addMessageCalls = mockCtx.addMessage.mock.calls;
				const toolResultCall = addMessageCalls.find(
					(c: any) =>
						c[0].role === "tool" &&
						typeof c[0].content === "string" &&
						c[0].content.includes("current session memory not modified"),
				);
				expect(toolResultCall).toBeTruthy();
				// Project writes never refresh the always-on {{memory}} module.
				expect(mockCtx.updateModule).not.toHaveBeenCalled();
			} finally {
				await rm(tempDir, { recursive: true, force: true });
			}
		});

		it("should reject project scope without project_dir", async () => {
			const { mkdtemp, rm, mkdir } = await import("node:fs/promises");
			const { tmpdir } = await import("node:os");
			const { join } = await import("node:path");
			const tempDir = await mkdtemp(join(tmpdir(), "pm-test-"));

			try {
				const globalDir = join(tempDir, "global");
				const workspaceDir = join(tempDir, "workspace");
				await mkdir(join(workspaceDir, ".omux"), { recursive: true });

				const agent = setupAgent(
					[
						toolCallResponse("persistent_memory", {
							action: "update",
							scope: "project",
							section: "active_notes",
							operation: "append",
							content: "should fail",
						}),
						textResponse("Tried."),
					],
					{ globalDir, workspaceDir },
				);

				await agent.handleMessage("remember this");

				const addMessageCalls = mockCtx.addMessage.mock.calls;
				const toolResultCall = addMessageCalls.find(
					(c: any) =>
						c[0].role === "tool" &&
						typeof c[0].content === "string" &&
						c[0].content.includes("'project_dir' is required"),
				);
				expect(toolResultCall).toBeTruthy();
				// Hot-reload must not run on a rejected write
				expect(mockCtx.updateModule).not.toHaveBeenCalled();
			} finally {
				await rm(tempDir, { recursive: true, force: true });
			}
		});

		it("should write to a different project without polluting current session memory", async () => {
			const { mkdtemp, rm, mkdir, writeFile } = await import("node:fs/promises");
			const { tmpdir } = await import("node:os");
			const { join } = await import("node:path");
			const tempDir = await mkdtemp(join(tmpdir(), "pm-test-"));

			try {
				const globalDir = join(tempDir, "global");
				const workspaceDir = join(tempDir, "workspace");
				const otherProject = join(tempDir, "other-project");
				await mkdir(join(workspaceDir, ".omux"), { recursive: true });
				await mkdir(otherProject, { recursive: true });
				// Project marker so validation passes
				await writeFile(join(otherProject, "package.json"), "{}");

				const agent = setupAgent(
					[
						toolCallResponse("persistent_memory", {
							action: "update",
							scope: "project",
							project_dir: otherProject,
							section: "active_notes",
							operation: "append",
							content: "Cross-project note",
						}),
						textResponse("Recorded."),
					],
					{ globalDir, workspaceDir },
				);

				await agent.handleMessage("remember in other project");

				const addMessageCalls = mockCtx.addMessage.mock.calls;
				const toolResultCall = addMessageCalls.find(
					(c: any) =>
						c[0].role === "tool" &&
						typeof c[0].content === "string" &&
						c[0].content.includes("current session memory not modified"),
				);
				expect(toolResultCall).toBeTruthy();
				// Cross-project writes do not refresh the current {{memory}} module
				expect(mockCtx.updateModule).not.toHaveBeenCalled();
			} finally {
				await rm(tempDir, { recursive: true, force: true });
			}
		});

		it("should reject project_dir that lacks a project marker", async () => {
			const { mkdtemp, rm, mkdir } = await import("node:fs/promises");
			const { tmpdir } = await import("node:os");
			const { join } = await import("node:path");
			const tempDir = await mkdtemp(join(tmpdir(), "pm-test-"));

			try {
				const globalDir = join(tempDir, "global");
				const workspaceDir = join(tempDir, "workspace");
				const bareDir = join(tempDir, "bare");
				await mkdir(join(workspaceDir, ".omux"), { recursive: true });
				await mkdir(bareDir, { recursive: true });
				// Intentionally no project marker

				const agent = setupAgent(
					[
						toolCallResponse("persistent_memory", {
							action: "update",
							scope: "project",
							project_dir: bareDir,
							section: "active_notes",
							operation: "append",
							content: "should be rejected",
						}),
						textResponse("Done."),
					],
					{ globalDir, workspaceDir },
				);

				await agent.handleMessage("remember somewhere weird");

				const addMessageCalls = mockCtx.addMessage.mock.calls;
				const toolResultCall = addMessageCalls.find(
					(c: any) =>
						c[0].role === "tool" &&
						typeof c[0].content === "string" &&
						c[0].content.includes("no project marker"),
				);
				expect(toolResultCall).toBeTruthy();
				expect(mockCtx.updateModule).not.toHaveBeenCalled();
			} finally {
				await rm(tempDir, { recursive: true, force: true });
			}
		});
	});

	describe("exec_command tool_activity broadcasting", () => {
		it("should broadcast tool_activity on first exec_command call", async () => {
			const agent = setupAgent([
				toolCallResponse("exec_command", { command: "ls", summary: "查看目录" }),
				textResponse("Done."),
			]);

			await agent.handleMessage("check files");

			expect(mockBroadcaster.broadcast).toHaveBeenCalledWith({
				type: "tool_activity",
				summary: "查看目录",
			});
		});

		it("should throttle: only broadcast 1st of 3 consecutive exec_command calls", async () => {
			const agent = setupAgent([
				// 3 consecutive exec_command tool calls in one LLM response won't happen,
				// so we simulate 3 rounds: each round returns one exec_command
				toolCallResponse("exec_command", { command: "echo a", summary: "查看目录" }, "tc1"),
				toolCallResponse("exec_command", { command: "echo b", summary: "读取文件" }, "tc2"),
				toolCallResponse("exec_command", { command: "echo c", summary: "搜索代码" }, "tc3"),
				textResponse("All done."),
			]);

			await agent.handleMessage("investigate");

			const toolActivityCalls = mockBroadcaster.broadcast.mock.calls.filter(
				(c: any) => c[0].type === "tool_activity",
			);

			// Only the 1st call (count=1, 1%3===1) should broadcast
			expect(toolActivityCalls).toHaveLength(1);
			expect(toolActivityCalls[0][0].summary).toBe("查看目录");
		});

		it("should reset throttle counter on new executeToolLoop", async () => {
			// First handleMessage: triggers exec_command (count resets to 0, then 1 → broadcasts)
			const agent = setupAgent([
				toolCallResponse("exec_command", { command: "ls", summary: "第一轮查看" }, "tc1"),
				textResponse("Done"),
			]);

			await agent.handleMessage("first task");

			// Second handleMessage: new executeToolLoop, counter resets
			// We need a new LLM to feed responses for second call
			const secondResponses = [
				toolCallResponse("exec_command", { command: "pwd", summary: "第二轮查看" }, "tc3"),
				textResponse("Done again"),
			];
			let secondCallCount = 0;
			(agent as any).llmClient = {
				stream: vi.fn().mockImplementation(() => {
					const events = secondResponses[secondCallCount] ?? [];
					secondCallCount++;
					return (async function* () {
						for (const event of events) {
							yield event;
						}
					})();
				}),
				complete: vi.fn(),
			};

			await agent.handleMessage("second task");

			const toolActivityCalls = mockBroadcaster.broadcast.mock.calls.filter(
				(c: any) => c[0].type === "tool_activity",
			);

			// Both should have broadcast (each is the 1st in its own loop)
			expect(toolActivityCalls).toHaveLength(2);
			expect(toolActivityCalls[0][0].summary).toBe("第一轮查看");
			expect(toolActivityCalls[1][0].summary).toBe("第二轮查看");
		});
	});

	describe("multi-agent routing", () => {
		it("should register agent and set activeAgentId on create_agent", async () => {
			const agent = setupAgent([
				toolCallResponse("create_agent", { agent_name: "backend" }),
				textResponse("Session created."),
			]);

			await agent.handleMessage("create backend session");

			expect(mockAdapter.launch).toHaveBeenCalled();
			// Verify the return output contains the agent name
			const addMessageCalls = mockCtx.addMessage.mock.calls;
			const toolResultMsg = addMessageCalls.find(
				(c: any) =>
					c[0].role === "tool" && typeof c[0].content === "string" && c[0].content.includes("omux-backend"),
			);
			expect(toolResultMsg).toBeTruthy();
		});

		it("should return target project's MEMORY.md content in create_agent result", async () => {
			const { mkdtemp, rm, mkdir, writeFile } = await import("node:fs/promises");
			const { tmpdir } = await import("node:os");
			const { join } = await import("node:path");
			const tempDir = await mkdtemp(join(tmpdir(), "create-agent-mem-"));

			try {
				await mkdir(join(tempDir, ".omux"), { recursive: true });
				await writeFile(
					join(tempDir, ".omux", "MEMORY.md"),
					"# Memory\n\n## Project Conventions\n- Always use snake_case in DB columns\n",
				);

				const agent = setupAgent([
					toolCallResponse("create_agent", { agent_name: "withmem", working_dir: tempDir }),
					textResponse("Created."),
				]);

				await agent.handleMessage("create agent");

				const addMessageCalls = mockCtx.addMessage.mock.calls;
				const toolResultMsg = addMessageCalls.find(
					(c: any) =>
						c[0].role === "tool" &&
						typeof c[0].content === "string" &&
						c[0].content.includes("snake_case in DB columns") &&
						c[0].content.includes("Project memory at"),
				);
				expect(toolResultMsg).toBeTruthy();
			} finally {
				await rm(tempDir, { recursive: true, force: true });
			}
		});

		it("should pass resumeId to adapter.launch when resume_id is provided", async () => {
			const agent = setupAgent([
				toolCallResponse("create_agent", { agent_name: "resumed", resume_id: "abc-123" }),
				textResponse("Session resumed."),
			]);

			await agent.handleMessage("resume session");

			expect(mockAdapter.launch).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({
					sessionName: "omux-resumed",
					resumeId: "abc-123",
				}),
			);
		});

		it("should support multiple agents and route send_to_agent by agent_id", async () => {
			// Create two agents, then send to the first one by agent_id
			const agent = setupAgent(
				[
					toolCallResponse("create_agent", { agent_name: "backend" }, "tc1"),
					toolCallResponse("create_agent", { agent_name: "frontend" }, "tc2"),
					toolCallResponse(
						"send_to_agent",
						{ prompt: "test", summary: "test", agent_id: "omux-backend" },
						"tc3",
					),
					textResponse("Done."),
				],
				{},
				{ withMonitor: true },
			);

			// Adapter returns different pane targets for each agent
			mockAdapter.launch.mockResolvedValueOnce("omux-backend:0.0").mockResolvedValueOnce("omux-frontend:0.0");

			await agent.handleMessage("multi session task");

			// send_to_agent should have targeted omux-backend's pane
			expect(mockAdapter.sendPrompt).toHaveBeenCalledWith(mockBridge, "omux-backend:0.0", "test");
		});

		it("should route to active agent when agent_id is omitted", async () => {
			const agent = setupAgent(
				[
					toolCallResponse("create_agent", { agent_name: "backend" }, "tc1"),
					toolCallResponse("send_to_agent", { prompt: "test", summary: "test" }, "tc2"),
					textResponse("Done."),
				],
				{},
				{ withMonitor: true },
			);

			mockAdapter.launch.mockResolvedValueOnce("omux-backend:0.0");

			await agent.handleMessage("send to active");

			expect(mockAdapter.sendPrompt).toHaveBeenCalledWith(mockBridge, "omux-backend:0.0", "test");
		});

		it("should return error for non-existent agent_id", async () => {
			const agent = setupAgent(
				[
					toolCallResponse("create_agent", { agent_name: "backend" }, "tc1"),
					toolCallResponse("send_to_agent", { prompt: "test", summary: "test", agent_id: "nonexistent" }, "tc2"),
					textResponse("Error handled."),
				],
				{},
				{ withMonitor: true },
			);

			await agent.handleMessage("send to wrong session");

			// sendPrompt should NOT have been called for the second tool call
			expect(mockAdapter.sendPrompt).not.toHaveBeenCalled();
		});

		it("should return error when no active agent exists", async () => {
			const agent = setupAgent(
				[
					toolCallResponse("send_to_agent", { prompt: "test", summary: "test" }, "tc1"),
					textResponse("No session."),
				],
				{},
				{ withMonitor: true },
			);

			await agent.handleMessage("send without session");

			expect(mockAdapter.sendPrompt).not.toHaveBeenCalled();
		});

		it("should remove agent from registry on kill_agent", async () => {
			const agent = setupAgent(
				[
					toolCallResponse("create_agent", { agent_name: "backend" }, "tc1"),
					toolCallResponse("create_agent", { agent_name: "frontend" }, "tc2"),
					toolCallResponse("kill_agent", { summary: "exit frontend", agent_id: "omux-frontend" }, "tc3"),
					// After kill, send to remaining agent without agent_id
					toolCallResponse("send_to_agent", { prompt: "continue", summary: "continue" }, "tc4"),
					textResponse("Done."),
				],
				{},
				{ withMonitor: true },
			);

			mockAdapter.launch.mockResolvedValueOnce("omux-backend:0.0").mockResolvedValueOnce("omux-frontend:0.0");
			mockAdapter.exitAgent = vi.fn().mockResolvedValue({ content: "exited", resumeId: null });
			// create_agent x2 checks hasAgent (false), then kill_agent checks (true)
			mockBridge.hasSession.mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
			mockBridge.killSession = vi.fn().mockResolvedValue(undefined);

			await agent.handleMessage("exit and continue");

			expect(mockAdapter.exitAgent).toHaveBeenCalledWith(mockBridge, "omux-frontend:0.0");
			expect(mockBridge.killSession).toHaveBeenCalledWith("omux-frontend");
			// send_to_agent should route to backend (the remaining agent)
			expect(mockAdapter.sendPrompt).toHaveBeenCalledWith(mockBridge, "omux-backend:0.0", "continue");
		});

		it("should set activeAgentId to null when last agent is killed", async () => {
			const agent = setupAgent(
				[
					toolCallResponse("create_agent", { agent_name: "only" }, "tc1"),
					toolCallResponse("kill_agent", { summary: "exit only" }, "tc2"),
					// Now try send_to_agent — should fail with no active agent
					toolCallResponse("send_to_agent", { prompt: "test", summary: "test" }, "tc3"),
					textResponse("Done."),
				],
				{},
				{ withMonitor: true },
			);

			mockAdapter.exitAgent = vi.fn().mockResolvedValue({ content: "exited", resumeId: null });
			mockBridge.hasSession.mockResolvedValue(true);
			mockBridge.killSession = vi.fn().mockResolvedValue(undefined);

			await agent.handleMessage("exit all");

			// send_to_agent should not have been called since no agents remain
			expect(mockAdapter.sendPrompt).not.toHaveBeenCalled();
		});

		it("should not change activeAgentId when killing a non-active agent", async () => {
			const agent = setupAgent(
				[
					toolCallResponse("create_agent", { agent_name: "backend" }, "tc1"),
					toolCallResponse("create_agent", { agent_name: "frontend" }, "tc2"),
					// frontend is now active; kill backend
					toolCallResponse("kill_agent", { summary: "exit backend", agent_id: "omux-backend" }, "tc3"),
					// send without agent_id should still go to frontend (still active)
					toolCallResponse("send_to_agent", { prompt: "continue", summary: "continue" }, "tc4"),
					textResponse("Done."),
				],
				{},
				{ withMonitor: true },
			);

			mockAdapter.launch.mockResolvedValueOnce("omux-backend:0.0").mockResolvedValueOnce("omux-frontend:0.0");
			mockAdapter.exitAgent = vi.fn().mockResolvedValue({ content: "exited", resumeId: null });
			// create_agent x2 (false), kill_agent (true)
			mockBridge.hasSession.mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
			mockBridge.killSession = vi.fn().mockResolvedValue(undefined);

			await agent.handleMessage("exit non-active");

			expect(mockAdapter.exitAgent).toHaveBeenCalledWith(mockBridge, "omux-backend:0.0");
			expect(mockAdapter.sendPrompt).toHaveBeenCalledWith(mockBridge, "omux-frontend:0.0", "continue");
		});

		it("should update activeAgentId when using agent_id parameter", async () => {
			const agent = setupAgent(
				[
					toolCallResponse("create_agent", { agent_name: "backend" }, "tc1"),
					toolCallResponse("create_agent", { agent_name: "frontend" }, "tc2"),
					// Send to backend explicitly — should switch active
					toolCallResponse(
						"send_to_agent",
						{ prompt: "backend task", summary: "test", agent_id: "omux-backend" },
						"tc3",
					),
					// Now send without agent_id — should go to backend (newly active)
					toolCallResponse("send_to_agent", { prompt: "follow up", summary: "test" }, "tc4"),
					textResponse("Done."),
				],
				{},
				{ withMonitor: true },
			);

			mockAdapter.launch.mockResolvedValueOnce("omux-backend:0.0").mockResolvedValueOnce("omux-frontend:0.0");

			await agent.handleMessage("switch active");

			const sendCalls = mockAdapter.sendPrompt.mock.calls;
			expect(sendCalls).toHaveLength(2);
			expect(sendCalls[0]).toEqual([mockBridge, "omux-backend:0.0", "backend task"]);
			expect(sendCalls[1]).toEqual([mockBridge, "omux-backend:0.0", "follow up"]);
		});

		it("should work with setPaneTarget for backward compatibility", async () => {
			const agent = setupAgent([
				toolCallResponse("inspect_agent", { lines: 100 }, "tc1"),
				textResponse("Got content."),
			]);

			// Legacy setPaneTarget still works
			agent.setPaneTarget("legacy:0.0");

			await agent.handleMessage("fetch more");

			expect(mockBridge.capturePane).toHaveBeenCalledWith("legacy:0.0", { startLine: -100 });
		});
	});

	describe("multi-adapter routing", () => {
		function createCodexMockAdapter() {
			return {
				name: "codex-mock",
				displayName: "Codex Mock",
				defaultModel: "codex-default-model",
				launch: vi.fn().mockResolvedValue("codex-session:0.0"),
				sendPrompt: vi.fn().mockResolvedValue(undefined),
				sendResponse: vi.fn().mockResolvedValue(undefined),
				abort: vi.fn(),
				exitAgent: vi.fn().mockResolvedValue({ content: "[codex exited]", resumeId: "codex-resume" }),
				getCharacteristics: vi.fn().mockReturnValue({
					waitingPatterns: [],
					completionPatterns: [],
					errorPatterns: [],
					activePatterns: [],
				}),
			} as any;
		}

		function setupMultiAdapter(responses: LLMStreamEvent[][], { withMonitor = false } = {}) {
			const defaultAdapter = createMockAdapter();
			const codexAdapter = createCodexMockAdapter();
			const adapters = new Map<string, any>([
				[defaultAdapter.name, defaultAdapter],
				[codexAdapter.name, codexAdapter],
			]);
			const agent = setupAgent(
				responses,
				{ adapter: undefined, adapters, defaultAdapter: defaultAdapter.name },
				{ withMonitor },
			);
			return { agent, defaultAdapter, codexAdapter };
		}

		it("routes create_agent to the adapter named in the `adapter` param", async () => {
			const { agent, defaultAdapter, codexAdapter } = setupMultiAdapter([
				toolCallResponse("create_agent", { agent_name: "reviewer", adapter: "codex-mock" }),
				textResponse("Created."),
			]);

			await agent.handleMessage("create a codex reviewer");

			expect(codexAdapter.launch).toHaveBeenCalled();
			expect(defaultAdapter.launch).not.toHaveBeenCalled();
		});

		it("uses the default adapter when `adapter` is omitted", async () => {
			const { agent, defaultAdapter, codexAdapter } = setupMultiAdapter([
				toolCallResponse("create_agent", { agent_name: "impl" }),
				textResponse("Created."),
			]);

			await agent.handleMessage("create an agent");

			expect(defaultAdapter.launch).toHaveBeenCalled();
			expect(codexAdapter.launch).not.toHaveBeenCalled();
		});

		it("errors when `adapter` is not an active adapter", async () => {
			const { agent, defaultAdapter, codexAdapter } = setupMultiAdapter([
				toolCallResponse("create_agent", { agent_name: "x", adapter: "not-real" }),
				textResponse("ok"),
			]);

			await agent.handleMessage("create with bogus adapter");

			expect(defaultAdapter.launch).not.toHaveBeenCalled();
			expect(codexAdapter.launch).not.toHaveBeenCalled();
			const toolResultMsg = mockCtx.addMessage.mock.calls.find(
				(c: any) =>
					c[0].role === "tool" &&
					typeof c[0].content === "string" &&
					c[0].content.includes('adapter "not-real" is not active'),
			);
			expect(toolResultMsg).toBeTruthy();
		});

		it("routes send_to_agent through the agent's own adapter", async () => {
			const { agent, defaultAdapter, codexAdapter } = setupMultiAdapter(
				[
					toolCallResponse("create_agent", { agent_name: "reviewer", adapter: "codex-mock" }, "tc1"),
					toolCallResponse("send_to_agent", { prompt: "review the diff", summary: "Reviewing" }, "tc2"),
					textResponse("Dispatched."),
				],
				{ withMonitor: true },
			);

			await agent.handleMessage("review with codex");

			expect(codexAdapter.sendPrompt).toHaveBeenCalledWith(mockBridge, "codex-session:0.0", "review the diff");
			expect(defaultAdapter.sendPrompt).not.toHaveBeenCalled();
		});
	});

	describe("maintenance lock (compaction)", () => {
		it("queues user messages during maintenance and drains them after it completes", async () => {
			const agent = setupAgent([textResponse("processed after compaction")]);

			// Start an exclusive maintenance op we control via a gate (simulates /compact's compress()).
			let release!: () => void;
			const gate = new Promise<void>((r) => {
				release = r;
			});
			const maintenance = agent.runMaintenance(() => gate);

			// The lock is acquired synchronously, before the first await inside runMaintenance.
			expect(agent.isMaintenanceInProgress()).toBe(true);

			// A user message arriving mid-compaction must queue, not dispatch.
			await agent.handleMessage("hello mid-compaction");

			expect(agent.getPendingUserMessageCount()).toBe(1);
			const queuedNotice = mockBroadcaster.broadcast.mock.calls.find(
				(c: any) => c[0].type === "system" && String(c[0].message).includes("Message queued"),
			);
			expect(queuedNotice).toBeTruthy();
			// Must NOT have been processed yet — no assistant output while the lock is held.
			expect(mockBroadcaster.broadcast.mock.calls.some((c: any) => c[0].type === "assistant_done")).toBe(false);

			// Release the lock — the queued message should now drain and be processed.
			release();
			await maintenance;
			await new Promise((r) => setTimeout(r, 20));

			expect(agent.isMaintenanceInProgress()).toBe(false);
			expect(agent.getPendingUserMessageCount()).toBe(0);
			expect(mockBroadcaster.broadcast.mock.calls.some((c: any) => c[0].type === "assistant_done")).toBe(true);
		});

		it("reports executing state to clients while maintenance holds the lock", async () => {
			const agent = setupAgent([]);
			let release!: () => void;
			const gate = new Promise<void>((r) => {
				release = r;
			});
			const maintenance = agent.runMaintenance(() => gate);

			const stateCalls = mockBroadcaster.broadcast.mock.calls.filter((c: any) => c[0].type === "state");
			expect(stateCalls.at(-1)[0].state).toBe("executing");
			expect(agent.state).toBe("idle"); // internal state unchanged

			release();
			await maintenance;
		});
	});

	describe("list_agent_tasks removed", () => {
		it("returns 'Unknown tool' when the LLM calls list_agent_tasks", async () => {
			const agent = setupAgent([toolCallResponse("list_agent_tasks", {}, "tc1"), textResponse("ok")]);

			await agent.handleMessage("check agents");

			const calls = (mockCtx.addMessage as any).mock.calls;
			const toolResultMsg = calls.find(
				(c: any) =>
					c[0].role === "tool" &&
					typeof c[0].content === "string" &&
					c[0].content.includes("Unknown tool: list_agent_tasks"),
			);
			expect(toolResultMsg).toBeDefined();
		});
	});

	describe("messages queued during executing are processed after idle", () => {
		it("should queue messages during executing and process them as separate turns after idle", async () => {
			// Messages arriving during EXECUTING go into the unified WorkQueue
			// and are processed as independent user turns after execution completes.
			mockCtx = createMockContextManager();
			mockBroadcaster = createMockBroadcaster();
			mockAdapter = createMockAdapter();
			mockBridge = createMockBridge();
			mockDetector = createMockStateDetector();

			const firstStreamGate = createDeferred();
			let callCount = 0;

			const mockLLM = {
				stream: vi.fn().mockImplementation(() => {
					const currentCall = callCount++;

					if (currentCall === 0) {
						// First call: user message → tool call (enters executing)
						return (async function* () {
							await firstStreamGate.promise;
							for (const event of toolCallResponse("mark_failed", { reason: "test" })) {
								yield event;
							}
						})();
					}
					// Subsequent calls: process queued messages with text responses
					return (async function* () {
						for (const event of textResponse(`Reply to queued message ${currentCall}`)) {
							yield event;
						}
					})();
				}),
				complete: vi.fn(),
			};

			const agent = new MainAgent({
				contextManager: mockCtx,
				llmClient: mockLLM as any,
				adapter: mockAdapter,
				bridge: mockBridge,
				createAgentSettleMs: 0,
				stateDetector: mockDetector,
				broadcaster: mockBroadcaster,
			});

			// Start the first message — it will block on the gate
			const handlePromise = agent.handleMessage("do something");

			// Wait a tick for the first message to start dispatching
			await Promise.resolve();
			await Promise.resolve();

			// Queue messages while executing — they go to WorkQueue
			agent.handleMessage("Hey, how is it going?");
			agent.handleMessage("Another message");

			// Verify queued notification was broadcast
			const systemMsgs = mockBroadcaster.broadcast.mock.calls.filter(
				(c: any) => c[0].type === "system" && c[0].message.includes("Message queued"),
			);
			expect(systemMsgs.length).toBeGreaterThanOrEqual(1);

			// Unblock the first LLM call
			firstStreamGate.resolve();

			await handlePromise;

			// Give microtasks a chance to run (dispatchNext is triggered via queueMicrotask)
			await new Promise((resolve) => setTimeout(resolve, 50));

			// Queued messages should have been processed as regular user messages (no [HUMAN] prefix)
			const userMsgs = mockCtx.addMessage.mock.calls.filter(
				(c: any) =>
					c[0].role === "user" &&
					typeof c[0].content === "string" &&
					(c[0].content === "Hey, how is it going?" || c[0].content === "Another message"),
			);
			expect(userMsgs.length).toBe(2);
		});
	});

	describe("getActiveAgents", () => {
		it("should return empty array when no agents exist", () => {
			const agent = setupAgent([]);
			expect(agent.getActiveAgents()).toEqual([]);
		});

		it("should return agents with idle status when no tasks running", () => {
			const agent = setupAgent([]);
			agent.setPaneTarget("sess:0.0", "omux-auth");

			const sessions = agent.getActiveAgents();
			expect(sessions).toHaveLength(1);
			expect(sessions[0]).toEqual({
				agentName: "omux-auth",
				agentId: "omux-auth",
				paneTarget: "sess:0.0",
				workingDir: expect.any(String),
				status: "idle",
				takenOver: false,
				adapter: "Test Agent",
				model: "test-model",
			});
		});

		it("should map task status running to active", () => {
			const agent = setupAgent([], {}, { withMonitor: true });
			agent.setPaneTarget("sess:0.0", "omux-auth");

			// Inject a running task
			const fakeTask = {
				taskId: "task_1",
				agentId: "omux-auth",
				status: "running" as const,
				summary: "test",
				taskContext: "test",
				preHash: "abc",
				startedAt: Date.now(),
				abortController: new AbortController(),
			};
			(agent as any).agentMonitor.tasks.set("omux-auth", fakeTask);

			const sessions = agent.getActiveAgents();
			expect(sessions[0].status).toBe("active");
		});

		it("should map task status waiting_input correctly", () => {
			const agent = setupAgent([], {}, { withMonitor: true });
			agent.setPaneTarget("sess:0.0", "omux-auth");

			const fakeTask = {
				taskId: "task_1",
				agentId: "omux-auth",
				status: "waiting_input" as const,
				summary: "test",
				taskContext: "test",
				preHash: "abc",
				startedAt: Date.now(),
				abortController: new AbortController(),
			};
			(agent as any).agentMonitor.tasks.set("omux-auth", fakeTask);

			const sessions = agent.getActiveAgents();
			expect(sessions[0].status).toBe("waiting_input");
		});

		it("should return multiple agents with mixed states", () => {
			const agent = setupAgent([], {}, { withMonitor: true });
			agent.setPaneTarget("s1:0.0", "omux-a");
			agent.setPaneTarget("s2:0.0", "omux-b");
			agent.setPaneTarget("s3:0.0", "omux-c");

			(agent as any).agentMonitor.tasks.set("omux-a", {
				taskId: "t1",
				agentId: "omux-a",
				status: "running",
				summary: "",
				taskContext: "",
				preHash: "",
				startedAt: Date.now(),
				abortController: new AbortController(),
			});
			(agent as any).agentMonitor.tasks.set("omux-b", {
				taskId: "t2",
				agentId: "omux-b",
				status: "waiting_input",
				summary: "",
				taskContext: "",
				preHash: "",
				startedAt: Date.now(),
				abortController: new AbortController(),
			});

			const sessions = agent.getActiveAgents();
			expect(sessions).toHaveLength(3);
			const statusMap = new Map(sessions.map((s: any) => [s.agentId, s.status]));
			expect(statusMap.get("omux-a")).toBe("active");
			expect(statusMap.get("omux-b")).toBe("waiting_input");
			expect(statusMap.get("omux-c")).toBe("idle");
		});
	});

	describe("onAgentChange callback", () => {
		it("should call onAgentChange after create_agent", async () => {
			const callback = vi.fn();
			const agent = setupAgent([toolCallResponse("create_agent", { agent_name: "test" }), textResponse("Done.")]);
			agent.setOnAgentChange(callback);

			await agent.handleMessage("create session");

			expect(callback).toHaveBeenCalledTimes(1);
		});

		it("should call onAgentChange after kill_agent (with exitAgent)", async () => {
			const callback = vi.fn();
			const agent = setupAgent(
				[
					toolCallResponse("create_agent", { agent_name: "test" }, "tc1"),
					toolCallResponse("kill_agent", { summary: "exit" }, "tc2"),
					textResponse("Done."),
				],
				{},
				{ withMonitor: true },
			);
			mockAdapter.exitAgent = vi.fn().mockResolvedValue({ content: "exited", resumeId: null });
			// create_agent (false), kill_agent (true)
			mockBridge.hasSession.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
			mockBridge.killSession = vi.fn().mockResolvedValue(undefined);
			agent.setOnAgentChange(callback);

			await agent.handleMessage("create and exit");

			// Called twice: once for create_agent, once for kill_agent
			expect(callback).toHaveBeenCalledTimes(2);
		});

		it("should call onAgentChange after kill_agent (explicit agent_id)", async () => {
			const callback = vi.fn();
			const agent = setupAgent(
				[
					toolCallResponse("create_agent", { agent_name: "test" }, "tc1"),
					toolCallResponse("kill_agent", { agent_id: "omux-test", summary: "kill" }, "tc2"),
					textResponse("Done."),
				],
				{},
				{ withMonitor: true },
			);
			mockAdapter.exitAgent = vi.fn().mockResolvedValue({ content: "exited", resumeId: null });
			mockBridge.hasSession.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
			mockBridge.killSession = vi.fn().mockResolvedValue(undefined);
			agent.setOnAgentChange(callback);

			await agent.handleMessage("create and kill");

			expect(callback).toHaveBeenCalledTimes(2);
		});

		it("should not throw when no callback is registered", async () => {
			const agent = setupAgent([toolCallResponse("create_agent", { agent_name: "test" }), textResponse("Done.")]);

			// No setOnAgentChange — should not throw
			await expect(agent.handleMessage("create session")).resolves.toBeUndefined();
		});
	});

	describe("agent event processing after drainPendingUserMessages", () => {
		it("should process agent events that arrive during executeToolLoop", async () => {
			// Scenario: user message triggers send_to_agent → sub-agent returns quickly
			// while main agent is still in executeToolLoop → after returning to idle,
			// the agent event in the queue should be processed.

			mockCtx = createMockContextManager();
			mockBroadcaster = createMockBroadcaster();
			mockAdapter = createMockAdapter();
			mockBridge = createMockBridge();
			mockDetector = createMockStateDetector();

			let callCount = 0;
			const mockLLM = {
				stream: vi.fn().mockImplementation(() => {
					const current = callCount++;
					if (current === 0) {
						// First call: user message → LLM returns send_to_agent tool call
						return (async function* () {
							yield {
								type: "tool_call_delta" as const,
								index: 0,
								id: "tc_send",
								name: "send_to_agent",
								argumentsDelta: JSON.stringify({
									prompt: "do something",
									summary: "Asking agent to do something",
								}),
							};
							yield {
								type: "done" as const,
								response: {
									content: "",
									contentBlocks: [],
									usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
									stopReason: "tool_use",
									model: "test",
								},
							};
						})();
					}
					if (current === 1) {
						// Second call: after send_to_agent result → LLM says text only (no more tools)
						return (async function* () {
							yield { type: "text_delta" as const, delta: "Task dispatched." };
							yield {
								type: "done" as const,
								response: {
									content: "Task dispatched.",
									contentBlocks: [{ type: "text", text: "Task dispatched." }],
									usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
									stopReason: "end_turn",
									model: "test",
								},
							};
						})();
					}
					// Third call: processing the agent event from the queue
					return (async function* () {
						yield { type: "text_delta" as const, delta: "Agent finished successfully." };
						yield {
							type: "done" as const,
							response: {
								content: "Agent finished successfully.",
								contentBlocks: [{ type: "text", text: "Agent finished successfully." }],
								usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
								stopReason: "end_turn",
								model: "test",
							},
						};
					})();
				}),
				complete: vi.fn(),
			} as any;

			const agent = new MainAgent({
				contextManager: mockCtx,
				llmClient: mockLLM,
				adapter: mockAdapter,
				bridge: mockBridge,
				createAgentSettleMs: 0,
				stateDetector: mockDetector,
				broadcaster: mockBroadcaster,
			});
			agent.setupAgentMonitor();

			// Pre-register an agent so send_to_agent can dispatch
			agent.setPaneTarget("test-session:0.0", "omux-test-1");

			// Start handleMessage — this will enter drainPendingUserMessages
			const handlePromise = agent.handleMessage("please run the task");

			// Let the microtask queue flush so the LLM stream starts
			await Promise.resolve();
			await Promise.resolve();

			// The mock stateDetector resolves immediately with "completed",
			// so AgentMonitor will automatically enqueue an agent event
			// into the workQueue during the executeToolLoop.

			// Wait for handleMessage to fully complete
			await handlePromise;

			// Give microtasks a chance to run (processAgentEvent is async)
			await new Promise((resolve) => setTimeout(resolve, 50));

			// The agent event should have been processed — LLM called at least 3 times:
			// 1. User message → send_to_agent
			// 2. Tool result → text only (back to idle)
			// 3. Agent event → text response
			expect(mockLLM.stream.mock.calls.length).toBeGreaterThanOrEqual(3);

			// Verify the agent event was added as a user message with [AGENT_EVENT] prefix
			const agentEventMessages = mockCtx.addMessage.mock.calls.filter(
				(c: any) =>
					c[0].role === "user" && typeof c[0].content === "string" && c[0].content.includes("[AGENT_EVENT"),
			);
			expect(agentEventMessages.length).toBe(1);

			// Agent should be back to idle
			expect(agent.state).toBe("idle");
		});
	});

	describe("agent persistence (AgentStore integration)", () => {
		function createMockAgentStore() {
			return {
				saveAgent: vi.fn(),
				deleteAgent: vi.fn(),
				loadAgents: vi.fn().mockReturnValue([]),
			} as any;
		}

		it("should call agentStore.saveAgent on create_agent", async () => {
			const mockAgentStore = createMockAgentStore();
			const agent = setupAgent([toolCallResponse("create_agent", { agent_name: "test" }), textResponse("Done.")], {
				agentStore: mockAgentStore,
			});

			await agent.handleMessage("create session");

			expect(mockAgentStore.saveAgent).toHaveBeenCalledTimes(1);
			expect(mockAgentStore.saveAgent).toHaveBeenCalledWith("omux-test", {
				paneTarget: "test-session:0.0",
				workingDir: expect.any(String),
				model: "test-model",
				adapter: "test-agent",
			});
		});

		it("should call agentStore.deleteAgent on kill_agent", async () => {
			const mockAgentStore = createMockAgentStore();
			const agent = setupAgent(
				[
					toolCallResponse("create_agent", { agent_name: "test" }, "tc1"),
					toolCallResponse("kill_agent", { summary: "exit" }, "tc2"),
					textResponse("Done."),
				],
				{ agentStore: mockAgentStore },
				{ withMonitor: true },
			);
			mockAdapter.exitAgent = vi.fn().mockResolvedValue({ content: "exited", resumeId: null });
			// create_agent (false), kill_agent (true)
			mockBridge.hasSession.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
			mockBridge.killSession = vi.fn().mockResolvedValue(undefined);

			await agent.handleMessage("create and exit");

			expect(mockAgentStore.deleteAgent).toHaveBeenCalledWith("omux-test");
		});

		it("should call agentStore.deleteAgent on kill_agent (explicit agent_id)", async () => {
			const mockAgentStore = createMockAgentStore();
			const agent = setupAgent(
				[
					toolCallResponse("create_agent", { agent_name: "test" }, "tc1"),
					toolCallResponse("kill_agent", { agent_id: "omux-test", summary: "kill" }, "tc2"),
					textResponse("Done."),
				],
				{ agentStore: mockAgentStore },
				{ withMonitor: true },
			);
			mockAdapter.exitAgent = vi.fn().mockResolvedValue({ content: "exited", resumeId: null });
			mockBridge.hasSession.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
			mockBridge.killSession = vi.fn().mockResolvedValue(undefined);

			await agent.handleMessage("create and kill");

			expect(mockAgentStore.deleteAgent).toHaveBeenCalledWith("omux-test");
		});

		it("should call agentStore.deleteAgent for each agent on kill_agent all", async () => {
			const mockAgentStore = createMockAgentStore();
			const agent = setupAgent(
				[
					toolCallResponse("create_agent", { agent_name: "s1" }, "tc1"),
					toolCallResponse("create_agent", { agent_name: "s2" }, "tc2"),
					toolCallResponse("kill_agent", { agent_id: "all", summary: "kill all" }, "tc3"),
					textResponse("Done."),
				],
				{ agentStore: mockAgentStore },
			);
			mockAdapter.exitAgent = vi.fn().mockResolvedValue({ content: "exited", resumeId: null });
			mockBridge.listOmuxAgents.mockResolvedValue([
				{ name: "omux-s1", windows: 1, attached: false },
				{ name: "omux-s2", windows: 1, attached: false },
			]);
			mockBridge.killSession = vi.fn().mockResolvedValue(undefined);

			await agent.handleMessage("create two and kill all");

			expect(mockAgentStore.deleteAgent).toHaveBeenCalledWith("omux-s1");
			expect(mockAgentStore.deleteAgent).toHaveBeenCalledWith("omux-s2");
		});

		it("should not fail when agentStore is not provided", async () => {
			const agent = setupAgent([toolCallResponse("create_agent", { agent_name: "test" }), textResponse("Done.")]);
			// No agentStore — should not throw
			await expect(agent.handleMessage("create session")).resolves.toBeUndefined();
		});
	});

	describe("restoreAgent", () => {
		it("should restore an agent into the agents map", () => {
			const agent = setupAgent([]);
			agent.restoreAgent("omux-restored", { paneTarget: "omux-restored:0.0", workingDir: "/work" });

			const sessions = agent.getActiveAgents();
			expect(sessions).toHaveLength(1);
			expect(sessions[0].agentId).toBe("omux-restored");
			expect(sessions[0].paneTarget).toBe("omux-restored:0.0");
		});

		it("should set the restored agent as active (last wins)", () => {
			const agent = setupAgent([]);
			agent.restoreAgent("omux-a", { paneTarget: "a:0.0", workingDir: "/a" });
			agent.restoreAgent("omux-b", { paneTarget: "b:0.0", workingDir: "/b" });

			const sessions = agent.getActiveAgents();
			expect(sessions).toHaveLength(2);
			expect((agent as any).activeAgentId).toBe("omux-b");
		});

		it("should allow restored agents to be used by send_to_agent", async () => {
			// Restore an agent then try to send_to_agent — it should route to the restored agent
			const agent = setupAgent(
				[toolCallResponse("send_to_agent", { prompt: "hello", summary: "test" }), textResponse("Done.")],
				{},
				{ withMonitor: true },
			);
			agent.restoreAgent("omux-restored", { paneTarget: "omux-restored:0.0", workingDir: "/work" });

			await agent.handleMessage("send hello to agent");

			// sendPrompt should have been called on the restored agent's pane
			expect(mockAdapter.sendPrompt).toHaveBeenCalledWith(mockBridge, "omux-restored:0.0", expect.any(String));
		});

		it("should allow restored agents to be killed", async () => {
			const mockAgentStore = {
				saveAgent: vi.fn(),
				deleteAgent: vi.fn(),
				loadAgents: vi.fn().mockReturnValue([]),
			} as any;
			const agent = setupAgent(
				[toolCallResponse("kill_agent", { agent_id: "omux-restored", summary: "kill" }), textResponse("Done.")],
				{ agentStore: mockAgentStore },
				{ withMonitor: true },
			);
			agent.restoreAgent("omux-restored", { paneTarget: "omux-restored:0.0", workingDir: "/work" });
			mockBridge.hasSession.mockResolvedValueOnce(true);
			mockBridge.killSession = vi.fn().mockResolvedValue(undefined);

			await agent.handleMessage("kill the restored session");

			expect(mockBridge.killSession).toHaveBeenCalledWith("omux-restored");
			expect(mockAgentStore.deleteAgent).toHaveBeenCalledWith("omux-restored");
			expect(agent.getActiveAgents()).toHaveLength(0);
		});

		it("should not trigger onAgentChange during restore", () => {
			const callback = vi.fn();
			const agent = setupAgent([]);
			agent.setOnAgentChange(callback);

			agent.restoreAgent("omux-a", { paneTarget: "a:0.0", workingDir: "/a" });

			// restoreAgent is a cold restore — no broadcast needed
			expect(callback).not.toHaveBeenCalled();
		});
	});

	describe("agent persistence with real AgentStore", () => {
		let tmpDir: string;
		let realDb: any;
		let realAgentStore: any;

		beforeEach(async () => {
			const { mkdtemp } = await import("node:fs/promises");
			const { tmpdir } = await import("node:os");
			const { join } = await import("node:path");
			const Database = (await import("better-sqlite3")).default;

			tmpDir = await mkdtemp(join(tmpdir(), "omux-agent-store-test-"));
			realDb = new Database(join(tmpDir, "test.sqlite"));
			realDb.pragma("journal_mode = WAL");

			const { AgentStore } = await import("../../src/persistence/agent-store.js");
			realAgentStore = new AgentStore(realDb);
		});

		afterEach(async () => {
			realDb?.close();
			if (tmpDir) {
				const { rm } = await import("node:fs/promises");
				await rm(tmpDir, { recursive: true, force: true });
			}
		});

		it("should persist agent to real SQLite on create_agent", async () => {
			const agent = setupAgent(
				[toolCallResponse("create_agent", { agent_name: "real-test" }), textResponse("Done.")],
				{ agentStore: realAgentStore },
			);

			await agent.handleMessage("create session");

			const agents = realAgentStore.loadAgents();
			expect(agents).toHaveLength(1);
			expect(agents[0].agentId).toBe("omux-real-test");
			expect(agents[0].paneTarget).toBe("test-session:0.0");
		});

		it("should remove from real SQLite on kill_agent", async () => {
			const agent = setupAgent(
				[
					toolCallResponse("create_agent", { agent_name: "real-exit" }, "tc1"),
					toolCallResponse("kill_agent", { summary: "exit" }, "tc2"),
					textResponse("Done."),
				],
				{ agentStore: realAgentStore },
				{ withMonitor: true },
			);
			mockAdapter.exitAgent = vi.fn().mockResolvedValue({ content: "exited", resumeId: null });
			mockBridge.hasSession.mockResolvedValue(true);
			mockBridge.killSession = vi.fn().mockResolvedValue(undefined);

			await agent.handleMessage("create and exit");

			expect(realAgentStore.loadAgents()).toHaveLength(0);
		});

		it("full lifecycle: create → persist → simulate restart → restore", async () => {
			// Phase 1: create agents
			const agent1 = setupAgent(
				[
					toolCallResponse("create_agent", { agent_name: "svc-a" }, "tc1"),
					toolCallResponse("create_agent", { agent_name: "svc-b" }, "tc2"),
					textResponse("Done."),
				],
				{ agentStore: realAgentStore },
			);

			await agent1.handleMessage("create two sessions");

			// Verify persisted
			const persisted = realAgentStore.loadAgents();
			expect(persisted).toHaveLength(2);
			expect(persisted[0].agentId).toBe("omux-svc-a");
			expect(persisted[1].agentId).toBe("omux-svc-b");

			// Phase 2: simulate restart — new agent, load from store, restore alive ones
			const agent2 = setupAgent([], { agentStore: realAgentStore });
			const loaded = realAgentStore.loadAgents();

			// Simulate: svc-a is alive, svc-b is dead
			for (const s of loaded) {
				if (s.agentId === "omux-svc-a") {
					agent2.restoreAgent(s.agentId, { paneTarget: s.paneTarget, workingDir: s.workingDir });
				} else {
					realAgentStore.deleteAgent(s.agentId);
				}
			}

			// Verify in-memory state
			const restored = agent2.getActiveAgents();
			expect(restored).toHaveLength(1);
			expect(restored[0].agentId).toBe("omux-svc-a");

			// Verify SQLite state
			const remaining = realAgentStore.loadAgents();
			expect(remaining).toHaveLength(1);
			expect(remaining[0].agentId).toBe("omux-svc-a");
		});

		it("create → kill all → verify SQLite is empty", async () => {
			const agent = setupAgent(
				[
					toolCallResponse("create_agent", { agent_name: "k1" }, "tc1"),
					toolCallResponse("create_agent", { agent_name: "k2" }, "tc2"),
					toolCallResponse("kill_agent", { agent_id: "all", summary: "kill all" }, "tc3"),
					textResponse("Done."),
				],
				{ agentStore: realAgentStore },
			);
			mockBridge.listOmuxAgents.mockResolvedValue([
				{ name: "omux-k1", windows: 1, attached: false },
				{ name: "omux-k2", windows: 1, attached: false },
			]);
			mockBridge.killSession = vi.fn().mockResolvedValue(undefined);

			await agent.handleMessage("create two and kill all");

			expect(realAgentStore.loadAgents()).toHaveLength(0);
			expect(agent.getActiveAgents()).toHaveLength(0);
		});
	});

	describe("human takeover (takenOver)", () => {
		it("setTakenOver should mark agent and call agentStore", () => {
			const mockAgentStore = {
				saveAgent: vi.fn(),
				deleteAgent: vi.fn(),
				loadAgents: vi.fn().mockReturnValue([]),
				setTakenOver: vi.fn(),
			} as any;
			const agent = setupAgent([], { agentStore: mockAgentStore });
			agent.restoreAgent("omux-test", { paneTarget: "t:0.0", workingDir: "/t" });

			agent.setTakenOver("omux-test", true);

			expect(agent.isTakenOver("omux-test")).toBe(true);
			expect(mockAgentStore.setTakenOver).toHaveBeenCalledWith("omux-test", true);
		});

		it("setTakenOver(false) should release agent", () => {
			const mockAgentStore = {
				saveAgent: vi.fn(),
				deleteAgent: vi.fn(),
				loadAgents: vi.fn().mockReturnValue([]),
				setTakenOver: vi.fn(),
			} as any;
			const agent = setupAgent([], { agentStore: mockAgentStore });
			agent.restoreAgent("omux-test", { paneTarget: "t:0.0", workingDir: "/t" });

			agent.setTakenOver("omux-test", true);
			agent.setTakenOver("omux-test", false);

			expect(agent.isTakenOver("omux-test")).toBe(false);
		});

		it("setTakenOver should trigger onAgentChange", () => {
			const callback = vi.fn();
			const agent = setupAgent([]);
			agent.setOnAgentChange(callback);
			agent.restoreAgent("omux-test", { paneTarget: "t:0.0", workingDir: "/t" });

			agent.setTakenOver("omux-test", true);

			expect(callback).toHaveBeenCalledTimes(1);
		});

		it("setTakenOver should be no-op for non-existent agent", () => {
			const agent = setupAgent([]);
			agent.setTakenOver("omux-nonexistent", true);
			expect(agent.isTakenOver("omux-nonexistent")).toBe(false);
		});

		it("getActiveAgents should include takenOver field", () => {
			const agent = setupAgent([]);
			agent.restoreAgent("omux-a", { paneTarget: "a:0.0", workingDir: "/a" });
			agent.restoreAgent("omux-b", { paneTarget: "b:0.0", workingDir: "/b" });

			agent.setTakenOver("omux-a", true);

			const sessions = agent.getActiveAgents();
			const a = sessions.find((s: any) => s.agentId === "omux-a");
			const b = sessions.find((s: any) => s.agentId === "omux-b");
			expect(a!.takenOver).toBe(true);
			expect(b!.takenOver).toBe(false);
		});

		it("resolveAgent should block send_to_agent for taken-over agent", async () => {
			const agent = setupAgent(
				[toolCallResponse("send_to_agent", { prompt: "hello", summary: "test" }), textResponse("Done.")],
				{},
				{ withMonitor: true },
			);
			agent.restoreAgent("omux-taken", { paneTarget: "t:0.0", workingDir: "/t" });
			agent.setTakenOver("omux-taken", true);

			await agent.handleMessage("send hello");

			// send_to_agent should NOT have been called on the adapter
			expect(mockAdapter.sendPrompt).not.toHaveBeenCalled();
		});

		it("restoreAgent with takenOver=true should restore takeover state", () => {
			const agent = setupAgent([]);
			agent.restoreAgent("omux-tk", { paneTarget: "tk:0.0", workingDir: "/tk" }, true);

			expect(agent.isTakenOver("omux-tk")).toBe(true);
			const sessions = agent.getActiveAgents();
			expect(sessions[0].takenOver).toBe(true);
		});

		it("getAgentPaneTarget should return pane target for existing agent", () => {
			const agent = setupAgent([]);
			agent.restoreAgent("omux-pt", { paneTarget: "pt:0.0", workingDir: "/pt" });

			expect(agent.getAgentPaneTarget("omux-pt")).toBe("pt:0.0");
		});

		it("getAgentPaneTarget should return undefined for non-existent agent", () => {
			const agent = setupAgent([]);
			expect(agent.getAgentPaneTarget("omux-none")).toBeUndefined();
		});
	});

	describe("resumeMonitoringAfterRelease", () => {
		it("resumes monitoring when the released pane is still changing (human drove it via prompt)", async () => {
			const agent = setupAgent([], { releaseActivitySampleMs: 0 }, { withMonitor: true });
			agent.restoreAgent("omux-a", { paneTarget: "a:0.0", workingDir: "/a" });

			// Two different hashes across the sample window → content changed → agent is active.
			mockDetector.captureHash = vi.fn().mockResolvedValueOnce("h1").mockResolvedValueOnce("h2");
			const dispatchSpy = vi
				.spyOn((agent as any).agentMonitor, "dispatch")
				.mockReturnValue({ dispatched: true, task: { taskId: "task_x" } } as any);

			await agent.resumeMonitoringAfterRelease("omux-a");

			// A monitor task is registered with the latest hash as its baseline.
			expect(dispatchSpy).toHaveBeenCalledWith("omux-a", "a:0.0", expect.objectContaining({ preHash: "h2" }));
			// The UI is told monitoring resumed.
			expect(mockBroadcaster.broadcast).toHaveBeenCalledWith(
				expect.objectContaining({ type: "system", message: expect.stringContaining("omux-a") }),
			);
		});

		it("does nothing when the released pane is static (agent idle)", async () => {
			const agent = setupAgent([], { releaseActivitySampleMs: 0 }, { withMonitor: true });
			agent.restoreAgent("omux-a", { paneTarget: "a:0.0", workingDir: "/a" });

			mockDetector.captureHash = vi.fn().mockResolvedValue("same");
			const dispatchSpy = vi.spyOn((agent as any).agentMonitor, "dispatch");

			await agent.resumeMonitoringAfterRelease("omux-a");

			expect(dispatchSpy).not.toHaveBeenCalled();
		});

		it("does not sample or dispatch when the agent is still taken over", async () => {
			const agent = setupAgent([], { releaseActivitySampleMs: 0 }, { withMonitor: true });
			agent.restoreAgent("omux-a", { paneTarget: "a:0.0", workingDir: "/a" });
			agent.setTakenOver("omux-a", true);

			mockDetector.captureHash = vi.fn().mockResolvedValueOnce("h1").mockResolvedValueOnce("h2");
			const dispatchSpy = vi.spyOn((agent as any).agentMonitor, "dispatch");

			await agent.resumeMonitoringAfterRelease("omux-a");

			expect(dispatchSpy).not.toHaveBeenCalled();
			expect(mockDetector.captureHash).not.toHaveBeenCalled();
		});

		it("does nothing when the agent is already being monitored", async () => {
			const agent = setupAgent([], { releaseActivitySampleMs: 0 }, { withMonitor: true });
			agent.restoreAgent("omux-a", { paneTarget: "a:0.0", workingDir: "/a" });
			// Pretend a monitor task already exists for this agent.
			vi.spyOn((agent as any).agentMonitor, "isBusy").mockReturnValue(true);

			mockDetector.captureHash = vi.fn().mockResolvedValueOnce("h1").mockResolvedValueOnce("h2");
			const dispatchSpy = vi.spyOn((agent as any).agentMonitor, "dispatch");

			await agent.resumeMonitoringAfterRelease("omux-a");

			expect(dispatchSpy).not.toHaveBeenCalled();
			expect(mockDetector.captureHash).not.toHaveBeenCalled();
		});

		it("is a no-op for an unknown agent", async () => {
			const agent = setupAgent([], { releaseActivitySampleMs: 0 }, { withMonitor: true });
			const dispatchSpy = vi.spyOn((agent as any).agentMonitor, "dispatch");

			await agent.resumeMonitoringAfterRelease("omux-missing");

			expect(dispatchSpy).not.toHaveBeenCalled();
		});
	});

	describe("agent recovery across restart", () => {
		it("restoreAgent should make agents visible via list_agents tool", async () => {
			// Simulate startup recovery: restore an agent, then use list_agents
			const agent = setupAgent([toolCallResponse("list_agents", {}), textResponse("Found agents.")], {});

			// list_agents queries tmux via bridge.listOmuxAgents()
			mockBridge.listOmuxAgents.mockResolvedValue([
				{ name: "omux-recovered", windows: 1, created: 1000, attached: false },
			]);

			agent.restoreAgent("omux-recovered", {
				paneTarget: "omux-recovered:0.0",
				workingDir: "/project",
			});

			await agent.handleMessage("list agents");

			// list_agents queries tmux, so check the tool result mentions the agent
			const toolResults = mockCtx.addMessage.mock.calls.filter(
				(c: any) => c[0].role === "tool" && typeof c[0].content === "string",
			);
			const listResult = toolResults.find((c: any) => c[0].content.includes("omux-recovered"));
			expect(listResult).toBeTruthy();
		});

		it("restoreAgent should allow inspect_agent to work on recovered agent", async () => {
			const agent = setupAgent([toolCallResponse("inspect_agent", { lines: 50 }), textResponse("Got it.")], {});
			agent.restoreAgent("omux-recovered", {
				paneTarget: "omux-recovered:0.0",
				workingDir: "/project",
			});

			await agent.handleMessage("inspect agent");

			expect(mockBridge.capturePane).toHaveBeenCalledWith("omux-recovered:0.0", { startLine: -50 });
		});

		it("restoreAgent should allow send_to_agent to route to recovered agent", async () => {
			const agent = setupAgent(
				[
					toolCallResponse("send_to_agent", { prompt: "continue work", summary: "Resuming" }),
					textResponse("Done."),
				],
				{},
				{ withMonitor: true },
			);
			agent.restoreAgent("omux-recovered", {
				paneTarget: "omux-recovered:0.0",
				workingDir: "/project",
			});

			await agent.handleMessage("continue work on recovered agent");

			expect(mockAdapter.sendPrompt).toHaveBeenCalledWith(mockBridge, "omux-recovered:0.0", "continue work");
		});

		it("multiple restored agents should all be accessible", () => {
			const agent = setupAgent([]);
			agent.restoreAgent("omux-a", { paneTarget: "omux-a:0.0", workingDir: "/a" });
			agent.restoreAgent("omux-b", { paneTarget: "omux-b:0.0", workingDir: "/b" });
			agent.restoreAgent("omux-c", { paneTarget: "omux-c:0.0", workingDir: "/c" });

			const agents = agent.getActiveAgents();
			expect(agents).toHaveLength(3);
			expect(agents.map((a: any) => a.agentId).sort()).toEqual(["omux-a", "omux-b", "omux-c"]);
			// Last restored should be active
			expect((agent as any).activeAgentId).toBe("omux-c");
		});

		it("recovered agents should have idle status (no running task)", () => {
			const agent = setupAgent([], {}, { withMonitor: true });
			agent.restoreAgent("omux-recovered", {
				paneTarget: "omux-recovered:0.0",
				workingDir: "/project",
			});

			const agents = agent.getActiveAgents();
			expect(agents[0].status).toBe("idle");
		});
	});

	// ── MT-3: list_agents merges the actionable registry view with a separate
	//     "unmanaged" section so the LLM never tries to drive a session it can't. ──
	describe("list_agents merged view", () => {
		async function runListAgents(agent: MainAgent) {
			await agent.handleMessage("list agents");
			const call = mockCtx.addMessage.mock.calls
				.map((c: any) => c[0])
				.find((m: any) => m.role === "tool" && typeof m.content === "string");
			return call?.content as string;
		}

		it("shows managed agents with adapter, model, cwd, status and taken-over flag", async () => {
			const agent = setupAgent([toolCallResponse("list_agents", {}), textResponse("ok")], {}, { withMonitor: true });
			agent.restoreAgent("omux-mine", { paneTarget: "mine:0.0", workingDir: "/proj/mine" });
			agent.setTakenOver("omux-mine", true);
			mockBridge.listOmuxAgents.mockResolvedValue([{ name: "omux-mine", windows: 1, attached: false }]);

			const out = await runListAgents(agent);

			expect(out).toContain("Managed agents");
			expect(out).toContain("omux-mine");
			expect(out).toContain("/proj/mine");
			expect(out).toContain("Test Agent"); // adapter displayName
			expect(out).toContain("test-model"); // model
			expect(out).toMatch(/taken over/i);
		});

		it("lists omux-* sessions outside the registry in a separate unmanaged section", async () => {
			const agent = setupAgent([toolCallResponse("list_agents", {}), textResponse("ok")], {}, { withMonitor: true });
			agent.restoreAgent("omux-mine", { paneTarget: "mine:0.0", workingDir: "/mine" });
			mockBridge.listOmuxAgents.mockResolvedValue([
				{ name: "omux-mine", windows: 1, attached: false },
				{ name: "omux-other", windows: 1, attached: false },
			]);

			const out = await runListAgents(agent);

			expect(out).toContain("Managed agents");
			expect(out).toContain("omux-mine");
			expect(out).toMatch(/[Uu]nmanaged/);
			expect(out).toContain("omux-other");
			// The unmanaged section warns against driving those sessions.
			expect(out).toMatch(/NOT controllable|not controllable/);
		});

		it("reports the registry view even when the tmux query fails", async () => {
			const agent = setupAgent([toolCallResponse("list_agents", {}), textResponse("ok")], {}, { withMonitor: true });
			agent.restoreAgent("omux-mine", { paneTarget: "mine:0.0", workingDir: "/mine" });
			mockBridge.listOmuxAgents.mockRejectedValue(new Error("tmux gone"));

			const out = await runListAgents(agent);

			expect(out).toContain("Managed agents");
			expect(out).toContain("omux-mine");
		});

		it("returns 'No active agents found.' when there are neither managed nor unmanaged sessions", async () => {
			const agent = setupAgent([toolCallResponse("list_agents", {}), textResponse("ok")], {}, { withMonitor: true });
			mockBridge.listOmuxAgents.mockResolvedValue([]);

			const out = await runListAgents(agent);

			expect(out).toContain("No active agents found.");
		});
	});
});
