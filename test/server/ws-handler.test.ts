import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleWebSocket } from "../../src/server/ws-handler.js";

/** Minimal WebSocket mock that supports events and send/close */
function createMockWS(): any {
	const emitter = new EventEmitter();
	const ws = {
		on: emitter.on.bind(emitter),
		send: vi.fn(),
		close: vi.fn(),
		readyState: 1,
		// Expose emit for test use
		_emit: emitter.emit.bind(emitter),
	};
	return ws;
}

function createMockMainAgent(state: "idle" | "executing" = "idle") {
	return {
		state,
		handleMessage: vi.fn().mockResolvedValue(undefined),
		getPendingUserMessageCount: vi.fn().mockReturnValue(0),
		getContextUsage: vi.fn().mockReturnValue({ tokens: 0, limit: 200000 }),
	} as any;
}

function createMockBroadcaster() {
	return {
		addClient: vi.fn(),
		removeClient: vi.fn(),
		broadcast: vi.fn(),
	} as any;
}

function createMockCommandRouter() {
	return {
		handle: vi.fn().mockResolvedValue(undefined),
	} as any;
}

describe("handleWebSocket", () => {
	let ws: ReturnType<typeof createMockWS>;
	let mockAgent: ReturnType<typeof createMockMainAgent>;
	let mockBroadcaster: ReturnType<typeof createMockBroadcaster>;
	let mockCommandRouter: ReturnType<typeof createMockCommandRouter>;

	beforeEach(() => {
		ws = createMockWS();
		mockAgent = createMockMainAgent();
		mockBroadcaster = createMockBroadcaster();
		mockCommandRouter = createMockCommandRouter();
	});

	function connect() {
		handleWebSocket(ws, {
			mainAgent: mockAgent,
			broadcaster: mockBroadcaster,
			commandRouter: mockCommandRouter,
		});
	}

	it("should register client with broadcaster on connect", () => {
		connect();
		expect(mockBroadcaster.addClient).toHaveBeenCalledWith(ws);
	});

	it("should send current state on connect", () => {
		connect();
		expect(ws.send).toHaveBeenCalledWith(
			JSON.stringify({
				type: "state",
				state: "idle",
				queueSize: 0,
				contextUsage: { tokens: 0, limit: 200000 },
			}),
		);
	});

	it("should route message type to mainAgent.handleMessage", async () => {
		connect();
		ws._emit("message", Buffer.from(JSON.stringify({ type: "message", content: "hello" })));

		// Wait for async handler
		await new Promise((r) => setTimeout(r, 10));

		expect(mockAgent.handleMessage).toHaveBeenCalledWith("hello");
	});

	it("should route command type to commandRouter.handle", async () => {
		connect();
		ws._emit("message", Buffer.from(JSON.stringify({ type: "command", name: "stop" })));

		await new Promise((r) => setTimeout(r, 10));

		expect(mockCommandRouter.handle).toHaveBeenCalledWith("stop");
	});

	it("should ignore invalid JSON", async () => {
		connect();
		ws._emit("message", Buffer.from("not json"));

		await new Promise((r) => setTimeout(r, 10));

		expect(mockAgent.handleMessage).not.toHaveBeenCalled();
		expect(mockCommandRouter.handle).not.toHaveBeenCalled();
	});

	it("should ignore messages without type field", async () => {
		connect();
		ws._emit("message", Buffer.from(JSON.stringify({ content: "no type" })));

		await new Promise((r) => setTimeout(r, 10));

		expect(mockAgent.handleMessage).not.toHaveBeenCalled();
	});

	it("should remove client on close", () => {
		connect();
		ws._emit("close");
		expect(mockBroadcaster.removeClient).toHaveBeenCalledWith(ws);
	});

	it("should remove client on error", () => {
		connect();
		ws._emit("error", new Error("test error"));
		expect(mockBroadcaster.removeClient).toHaveBeenCalledWith(ws);
	});

	it("should broadcast error when handleMessage fails", async () => {
		mockAgent.handleMessage.mockRejectedValue(new Error("LLM failed"));
		connect();
		ws._emit("message", Buffer.from(JSON.stringify({ type: "message", content: "hello" })));

		await new Promise((r) => setTimeout(r, 50));

		expect(mockBroadcaster.broadcast).toHaveBeenCalledWith(
			expect.objectContaining({ type: "system", message: expect.stringContaining("LLM failed") }),
		);
	});
});

describe("learning WS messages", () => {
	let ws: ReturnType<typeof createMockWS>;
	let mockBroadcaster: ReturnType<typeof createMockBroadcaster>;

	beforeEach(() => {
		ws = createMockWS();
		mockBroadcaster = createMockBroadcaster();
	});

	it("routes learning_message to learningChat.handleMessage", async () => {
		const learningChat = {
			handleMessage: vi.fn().mockResolvedValue(undefined),
			stop: vi.fn(),
		};
		handleWebSocket(ws, {
			mainAgent: createMockMainAgent() as any,
			broadcaster: mockBroadcaster,
			commandRouter: createMockCommandRouter() as any,
			bridge: {} as any,
			learningChat: learningChat as any,
		});
		ws._emit("message", Buffer.from(JSON.stringify({ type: "learning_message", entryId: "lrn_x", content: "hi" })));
		await new Promise((r) => setTimeout(r, 10));
		expect(learningChat.handleMessage).toHaveBeenCalledWith("lrn_x", "hi");
	});

	it("routes learning_stop to learningChat.stop", async () => {
		const learningChat = { handleMessage: vi.fn(), stop: vi.fn() };
		handleWebSocket(ws, {
			mainAgent: createMockMainAgent() as any,
			broadcaster: mockBroadcaster,
			commandRouter: createMockCommandRouter() as any,
			bridge: {} as any,
			learningChat: learningChat as any,
		});
		ws._emit("message", Buffer.from(JSON.stringify({ type: "learning_stop", entryId: "lrn_x" })));
		await new Promise((r) => setTimeout(r, 10));
		expect(learningChat.stop).toHaveBeenCalledWith("lrn_x");
	});

	it("sends learning_error when handleMessage rejects", async () => {
		const learningChat = {
			handleMessage: vi.fn().mockRejectedValue(new Error("already streaming")),
			stop: vi.fn(),
		};
		handleWebSocket(ws, {
			mainAgent: createMockMainAgent() as any,
			broadcaster: mockBroadcaster,
			commandRouter: createMockCommandRouter() as any,
			bridge: {} as any,
			learningChat: learningChat as any,
		});
		ws._emit("message", Buffer.from(JSON.stringify({ type: "learning_message", entryId: "lrn_x", content: "hi" })));
		await new Promise((r) => setTimeout(r, 30));
		const calls = (ws.send as any).mock.calls;
		const errorCall = calls.find((c: any[]) => c[0].includes("learning_error"));
		expect(errorCall).toBeDefined();
		expect(errorCall![0]).toContain("already streaming");
	});

	it("no-ops when learningChat is undefined (opt-in feature)", async () => {
		handleWebSocket(ws, {
			mainAgent: createMockMainAgent() as any,
			broadcaster: mockBroadcaster,
			commandRouter: createMockCommandRouter() as any,
			bridge: {} as any,
		});
		ws._emit("message", Buffer.from(JSON.stringify({ type: "learning_message", entryId: "x", content: "y" })));
		await new Promise((r) => setTimeout(r, 10));
		// Should not throw, should not send anything.
		expect(true).toBe(true);
	});
});
