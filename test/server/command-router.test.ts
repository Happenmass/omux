import { describe, it, expect, vi, beforeEach } from "vitest";
import { CommandRouter } from "../../src/server/command-router.js";
import { CommandRegistry } from "../../src/server/command-registry.js";

function createMockMainAgent(state: "idle" | "executing" = "idle") {
	let autoContinue = false;
	return {
		state,
		handleMessage: vi.fn().mockResolvedValue(undefined),
		waitForIdle: vi.fn().mockResolvedValue(undefined),
		isAutoContinueEnabled: vi.fn(() => autoContinue),
		setAutoContinueEnabled: vi.fn((on: boolean) => {
			autoContinue = on;
			return autoContinue;
		}),
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

	describe("/tidy", () => {
		it("should broadcast unavailable message when dependencies are missing", async () => {
			setup();
			await commandRouter.handle("tidy");
			expect(mockBroadcaster.broadcast).toHaveBeenCalledWith(
				expect.objectContaining({ type: "system", message: expect.stringContaining("不可用") }),
			);
		});

		it("should broadcast empty message when no memory files exist", async () => {
			mockAgent = createMockMainAgent("idle");
			mockRouter = createMockSignalRouter();
			mockCtx = createMockContextManager();
			mockBroadcaster = createMockBroadcaster();
			commandRegistry = new CommandRegistry();

			const mockLlmClient = { completeJson: vi.fn() } as any;
			const mockPromptLoader = { resolve: vi.fn().mockReturnValue("prompt") } as any;
			const mockMemoryStore = {
				getStorageDir: vi.fn().mockReturnValue("/tmp/nonexistent-dir"),
				markDirty: vi.fn(),
			} as any;
			const mockSyncMemory = vi.fn().mockResolvedValue(undefined);

			commandRouter = new CommandRouter({
				mainAgent: mockAgent,
				signalRouter: mockRouter,
				contextManager: mockCtx,
				broadcaster: mockBroadcaster,
				commandRegistry,
				llmClient: mockLlmClient,
				promptLoader: mockPromptLoader,
				memoryStore: mockMemoryStore,
				syncMemory: mockSyncMemory,
			});

			await commandRouter.handle("tidy");

			const calls = mockBroadcaster.broadcast.mock.calls.map((c: any) => c[0]);
			expect(calls.some((c: any) => c.type === "system" && c.message.includes("正在整理"))).toBe(true);
			expect(calls.some((c: any) => c.type === "system" && c.message.includes("无需整理"))).toBe(true);
			// LLM should not have been called (all files skipped)
			expect(mockLlmClient.completeJson).not.toHaveBeenCalled();
		});

		it("should process existing memory files with LLM", async () => {
			const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
			const { tmpdir } = await import("node:os");
			const { join } = await import("node:path");

			const tmpDir = await mkdtemp(join(tmpdir(), "cliclaw-tidy-"));
			await mkdir(join(tmpDir, "memory"), { recursive: true });
			await writeFile(join(tmpDir, "memory/core.md"), "# Core\n- old decision\n- current decision");

			try {
				mockAgent = createMockMainAgent("idle");
				mockRouter = createMockSignalRouter();
				mockCtx = createMockContextManager();
				mockBroadcaster = createMockBroadcaster();
				commandRegistry = new CommandRegistry();

				const mockLlmClient = {
					completeJson: vi.fn().mockResolvedValue({
						retained: "# Core\n- current decision",
						archived: "- old decision",
						summary: "Archived 1 outdated decision",
					}),
				} as any;

				const mockPromptLoader = { resolve: vi.fn().mockReturnValue("prompt") } as any;
				const mockMemoryStore = {
					getStorageDir: vi.fn().mockReturnValue(tmpDir),
					write: vi.fn().mockResolvedValue({ success: true, path: "memory/core.md" }),
					markDirty: vi.fn(),
				} as any;
				const mockSyncMemory = vi.fn().mockResolvedValue(undefined);

				commandRouter = new CommandRouter({
					mainAgent: mockAgent,
					signalRouter: mockRouter,
					contextManager: mockCtx,
					broadcaster: mockBroadcaster,
					commandRegistry,
					llmClient: mockLlmClient,
					promptLoader: mockPromptLoader,
					memoryStore: mockMemoryStore,
					syncMemory: mockSyncMemory,
				});

				await commandRouter.handle("tidy");

				// LLM should have been called for core.md
				expect(mockLlmClient.completeJson).toHaveBeenCalledTimes(1);

				// Should write retained content (overwrite) and archived content (append)
				expect(mockMemoryStore.write).toHaveBeenCalledWith(
					expect.objectContaining({ path: "memory/core.md", mode: "overwrite" }),
				);
				expect(mockMemoryStore.write).toHaveBeenCalledWith(
					expect.objectContaining({ path: expect.stringMatching(/memory\/\d{4}-\d{2}-\d{2}\.md/) }),
				);

				// Should sync memory
				expect(mockSyncMemory).toHaveBeenCalled();

				// Should broadcast completion
				const calls = mockBroadcaster.broadcast.mock.calls.map((c: any) => c[0]);
				expect(calls.some((c: any) => c.type === "system" && c.message.includes("整理完成"))).toBe(true);
			} finally {
				await rm(tmpDir, { recursive: true, force: true });
			}
		});
	});

	describe("built-in command registration", () => {
		it("should register all built-in commands into CommandRegistry", () => {
			setup();
			expect(commandRegistry.has("stop")).toBe(true);
			expect(commandRegistry.has("clear")).toBe(true);
			expect(commandRegistry.has("reset")).toBe(true);
			expect(commandRegistry.has("compact")).toBe(true);
			expect(commandRegistry.has("context")).toBe(true);
			expect(commandRegistry.has("tidy")).toBe(true);
			expect(commandRegistry.has("autocontinue")).toBe(true);
			// /resume was removed: it had no remaining purpose once /stop's flag is checked
			// between tool-loop rounds and execution naturally returns to idle on text-only
			// turns. The /resume command also injected a synthetic [RESUME] user message,
			// which was bad for prompt-cache prefix stability.
			expect(commandRegistry.has("resume")).toBe(false);
			expect(commandRegistry.size).toBe(7);
		});
	});

	describe("/autocontinue", () => {
		it("toggles auto-continue on from off and reports it", async () => {
			setup("idle");
			await commandRouter.handle("autocontinue");
			expect(mockAgent.setAutoContinueEnabled).toHaveBeenCalledWith(true);
			expect(mockBroadcaster.broadcast).toHaveBeenCalledWith(
				expect.objectContaining({ type: "system", message: expect.stringContaining("已开启") }),
			);
		});

		it("toggles auto-continue off when already on", async () => {
			setup("idle");
			mockAgent.setAutoContinueEnabled(true); // pre-enable
			await commandRouter.handle("autocontinue");
			expect(mockAgent.setAutoContinueEnabled).toHaveBeenLastCalledWith(false);
			expect(mockBroadcaster.broadcast).toHaveBeenCalledWith(
				expect.objectContaining({ type: "system", message: expect.stringContaining("已关闭") }),
			);
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
