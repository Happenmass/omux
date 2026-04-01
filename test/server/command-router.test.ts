import { describe, it, expect, vi, beforeEach } from "vitest";
import { CommandRouter } from "../../src/server/command-router.js";
import { CommandRegistry } from "../../src/server/command-registry.js";

function createMockMainAgent(state: "idle" | "executing" = "idle") {
	return {
		state,
		handleMessage: vi.fn().mockResolvedValue(undefined),
		handleResume: vi.fn().mockResolvedValue(undefined),
		waitForIdle: vi.fn().mockResolvedValue(undefined),
	} as any;
}

function createMockSignalRouter() {
	return {
		stop: vi.fn(),
		resume: vi.fn(),
		isStopRequested: vi.fn().mockReturnValue(false),
	} as any;
}

function createMockContextManager(shouldCompress = true) {
	return {
		clear: vi.fn().mockResolvedValue(undefined),
		shouldCompress: vi.fn().mockReturnValue(shouldCompress),
		compress: vi.fn().mockResolvedValue(undefined),
		getCurrentTokenEstimate: vi.fn().mockReturnValue(50000),
		getContextWindowLimit: vi.fn().mockReturnValue(500000),
		getConversationLength: vi.fn().mockReturnValue(10),
	} as any;
}

function createMockBroadcaster() {
	return {
		broadcast: vi.fn(),
	} as any;
}

describe("CommandRouter", () => {
	let mockAgent: ReturnType<typeof createMockMainAgent>;
	let mockRouter: ReturnType<typeof createMockSignalRouter>;
	let mockCtx: ReturnType<typeof createMockContextManager>;
	let mockBroadcaster: ReturnType<typeof createMockBroadcaster>;
	let commandRouter: CommandRouter;
	let commandRegistry: CommandRegistry;

	function setup(agentState: "idle" | "executing" = "idle") {
		mockAgent = createMockMainAgent(agentState);
		mockRouter = createMockSignalRouter();
		mockCtx = createMockContextManager();
		mockBroadcaster = createMockBroadcaster();
		commandRegistry = new CommandRegistry();
		commandRouter = new CommandRouter({
			mainAgent: mockAgent,
			signalRouter: mockRouter,
			contextManager: mockCtx,
			broadcaster: mockBroadcaster,
			commandRegistry,
		});
	}

	describe("/stop", () => {
		it("should call signalRouter.stop() when executing", async () => {
			setup("executing");
			await commandRouter.handle("stop");
			expect(mockRouter.stop).toHaveBeenCalled();
		});

		it("should broadcast message when not executing", async () => {
			setup("idle");
			await commandRouter.handle("stop");
			expect(mockRouter.stop).not.toHaveBeenCalled();
			expect(mockBroadcaster.broadcast).toHaveBeenCalledWith(
				expect.objectContaining({ type: "system", message: "当前未在执行任务" }),
			);
		});
	});

	describe("/resume", () => {
		it("should call mainAgent.handleResume() when idle", async () => {
			setup("idle");
			await commandRouter.handle("resume");
			expect(mockAgent.handleResume).toHaveBeenCalled();
		});

		it("should broadcast message when already executing", async () => {
			setup("executing");
			await commandRouter.handle("resume");
			expect(mockAgent.handleResume).not.toHaveBeenCalled();
			expect(mockBroadcaster.broadcast).toHaveBeenCalledWith(
				expect.objectContaining({ type: "system", message: "当前已在执行中" }),
			);
		});
	});

	describe("/clear", () => {
		it("should clear context and broadcast clear event when idle", async () => {
			setup("idle");
			await commandRouter.handle("clear");
			expect(mockCtx.clear).toHaveBeenCalled();
			expect(mockBroadcaster.broadcast).toHaveBeenCalledWith({ type: "clear" });
		});

		it("should stop first then clear when executing", async () => {
			setup("executing");
			await commandRouter.handle("clear");
			expect(mockRouter.stop).toHaveBeenCalled();
			expect(mockAgent.waitForIdle).toHaveBeenCalled();
			expect(mockCtx.clear).toHaveBeenCalled();
			expect(mockBroadcaster.broadcast).toHaveBeenCalledWith({ type: "clear" });
		});
	});

	describe("/compact", () => {
		it("should compress context and broadcast when conversation is not empty", async () => {
			setup("idle");
			await commandRouter.handle("compact");
			expect(mockCtx.compress).toHaveBeenCalled();
			expect(mockBroadcaster.broadcast).toHaveBeenCalledWith(
				expect.objectContaining({ type: "system", message: "对话历史已压缩并注入系统提示词" }),
			);
		});

		it("should skip compression when conversation is empty", async () => {
			mockAgent = createMockMainAgent("idle");
			mockRouter = createMockSignalRouter();
			mockCtx = createMockContextManager(false);
			mockCtx.getConversationLength = vi.fn().mockReturnValue(0);
			mockBroadcaster = createMockBroadcaster();
			commandRegistry = new CommandRegistry();
			commandRouter = new CommandRouter({
				mainAgent: mockAgent,
				signalRouter: mockRouter,
				contextManager: mockCtx,
				broadcaster: mockBroadcaster,
				commandRegistry,
			});
			await commandRouter.handle("compact");
			expect(mockCtx.compress).not.toHaveBeenCalled();
			expect(mockBroadcaster.broadcast).toHaveBeenCalledWith(
				expect.objectContaining({ type: "system", message: "当前没有对话内容，无需压缩" }),
			);
		});

		it("should stop first then compress when executing", async () => {
			setup("executing");
			await commandRouter.handle("compact");
			expect(mockRouter.stop).toHaveBeenCalled();
			expect(mockAgent.waitForIdle).toHaveBeenCalled();
			expect(mockCtx.compress).toHaveBeenCalled();
		});
	});

	describe("built-in command registration", () => {
		it("should register stop, resume, clear, reset, compact into CommandRegistry", () => {
			setup();
			expect(commandRegistry.has("stop")).toBe(true);
			expect(commandRegistry.has("resume")).toBe(true);
			expect(commandRegistry.has("clear")).toBe(true);
			expect(commandRegistry.has("reset")).toBe(true);
			expect(commandRegistry.has("compact")).toBe(true);
			expect(commandRegistry.has("context")).toBe(true);
			expect(commandRegistry.size).toBe(6);
		});
	});

	describe("unknown command", () => {
		it("should broadcast unknown command message", async () => {
			setup("idle");
			await commandRouter.handle("unknown");
			expect(mockBroadcaster.broadcast).toHaveBeenCalledWith(
				expect.objectContaining({ type: "system", message: "未知指令: /unknown" }),
			);
		});
	});
});
