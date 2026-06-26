import { beforeEach, describe, expect, it, vi } from "vitest";
import { MainAgent } from "../../src/core/main-agent.js";

function createAgent(opts: { enabled?: boolean; max?: number } = {}) {
	const broadcaster = { broadcast: vi.fn(), addClient: vi.fn(), removeClient: vi.fn(), getClientCount: vi.fn() } as any;
	const complete = vi.fn();
	const llmClient = { complete } as any;
	const promptLoader = { resolve: vi.fn().mockReturnValue("GATE PROMPT") } as any;
	const signalRouter = {
		on: vi.fn(), emit: vi.fn(),
		isStopRequested: vi.fn().mockReturnValue(false),
	} as any;
	const agent = new MainAgent({
		contextManager: {
			addMessage: vi.fn(), getMessages: vi.fn().mockReturnValue([]),
			getCurrentTokenEstimate: vi.fn().mockReturnValue(0),
			getContextWindowLimit: vi.fn().mockReturnValue(200000),
			setCompactTuning: vi.fn(),
		} as any,
		signalRouter,
		llmClient,
		adapter: { getCharacteristics: vi.fn().mockReturnValue({}) } as any,
		bridge: { capturePane: vi.fn() } as any,
		createAgentSettleMs: 0,
		stateDetector: { onStateChange: vi.fn() } as any,
		broadcaster,
		promptLoader,
		autoContinue: { enabled: opts.enabled ?? false, maxConsecutive: opts.max ?? 10 },
	});
	return { agent, broadcaster, complete, signalRouter };
}

function gateResponse(decision: object) {
	return { content: JSON.stringify(decision), usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, stopReason: "end_turn", model: "test" };
}

const run = (agent: MainAgent, text = "done for now") => (agent as any).maybeAutoContinue(text);
const queueSize = (agent: MainAgent) => (agent as any).workQueue.size();

describe("maybeAutoContinue", () => {
	it("returns false and makes no LLM call when the mode is disabled", async () => {
		const { agent, complete } = createAgent({ enabled: false });
		expect(await run(agent)).toBe(false);
		expect(complete).not.toHaveBeenCalled();
		expect(queueSize(agent)).toBe(0);
	});

	it("continues: enqueues driverText, increments the counter, broadcasts", async () => {
		const { agent, complete, broadcaster } = createAgent({ enabled: true });
		complete.mockResolvedValue(gateResponse({ continue: true, reason: "tests not run", driverText: "Run the test suite" }));
		expect(await run(agent)).toBe(true);
		expect((agent as any).autoContinueCount).toBe(1);
		expect(queueSize(agent)).toBe(1);
		expect((agent as any).workQueue.dequeue()).toEqual({ kind: "user_message", content: "Run the test suite" });
		expect(broadcaster.broadcast).toHaveBeenCalledWith(
			expect.objectContaining({ type: "system", message: expect.stringContaining("自动继续 (1/") }),
		);
	});

	it("stops when the gate says continue:false", async () => {
		const { agent, complete } = createAgent({ enabled: true });
		complete.mockResolvedValue(gateResponse({ continue: false, reason: "done", driverText: "" }));
		expect(await run(agent)).toBe(false);
		expect(queueSize(agent)).toBe(0);
	});

	it("treats continue:true with empty driverText as stop", async () => {
		const { agent, complete } = createAgent({ enabled: true });
		complete.mockResolvedValue(gateResponse({ continue: true, reason: "x", driverText: "   " }));
		expect(await run(agent)).toBe(false);
		expect(queueSize(agent)).toBe(0);
	});

	it("does not call the gate once the consecutive cap is reached", async () => {
		const { agent, complete } = createAgent({ enabled: true, max: 3 });
		(agent as any).autoContinueCount = 3;
		expect(await run(agent)).toBe(false);
		expect(complete).not.toHaveBeenCalled();
	});

	it("does not run when a stop was requested", async () => {
		const { agent, complete, signalRouter } = createAgent({ enabled: true });
		signalRouter.isStopRequested.mockReturnValue(true);
		expect(await run(agent)).toBe(false);
		expect(complete).not.toHaveBeenCalled();
	});

	it("defers when a real user message is already queued", async () => {
		const { agent, complete } = createAgent({ enabled: true });
		(agent as any).workQueue.enqueueUserMessage("user typed something");
		expect(await run(agent)).toBe(false);
		expect(complete).not.toHaveBeenCalled();
	});

	it("fails safe (false) when the gate returns non-JSON twice", async () => {
		const { agent, complete } = createAgent({ enabled: true });
		complete.mockResolvedValue({ content: "not json", usage: {}, stopReason: "end_turn", model: "test" });
		expect(await run(agent)).toBe(false);
		expect(complete).toHaveBeenCalledTimes(2);
		expect(queueSize(agent)).toBe(0);
	});

	it("handleMessage resets the consecutive counter", async () => {
		const { agent } = createAgent({ enabled: true });
		(agent as any).state = "executing"; // makes handleMessage enqueue+return without dispatching
		(agent as any).autoContinueCount = 5;
		await agent.handleMessage("hi");
		expect((agent as any).autoContinueCount).toBe(0);
	});

	it("setAutoContinueEnabled / isAutoContinueEnabled toggle the flag", () => {
		const { agent } = createAgent({ enabled: false });
		expect(agent.isAutoContinueEnabled()).toBe(false);
		expect(agent.setAutoContinueEnabled(true)).toBe(true);
		expect(agent.isAutoContinueEnabled()).toBe(true);
	});

	it("setAutoContinueMax updates the cap at runtime and getAutoContinueMax reflects it", () => {
		const { agent } = createAgent({ enabled: true, max: 10 });
		expect(agent.getAutoContinueMax()).toBe(10);
		expect(agent.setAutoContinueMax(20)).toBe(20);
		expect(agent.getAutoContinueMax()).toBe(20);
	});

	it("setAutoContinueMax ignores non-positive / non-integer values and keeps the current cap", () => {
		const { agent } = createAgent({ enabled: true, max: 10 });
		expect(agent.setAutoContinueMax(0)).toBe(10);
		expect(agent.setAutoContinueMax(-5)).toBe(10);
		expect(agent.setAutoContinueMax(3.5)).toBe(10);
		expect(agent.getAutoContinueMax()).toBe(10);
	});

	it("a runtime-raised cap lets the gate continue past the old limit", async () => {
		const { agent, complete } = createAgent({ enabled: true, max: 1 });
		(agent as any).autoContinueCount = 1; // at the old cap of 1 → would stop
		agent.setAutoContinueMax(5); // raise the cap at runtime
		complete.mockResolvedValue(gateResponse({ continue: true, reason: "more to do", driverText: "keep going" }));
		expect(await run(agent)).toBe(true);
		expect((agent as any).autoContinueCount).toBe(2);
	});
});
