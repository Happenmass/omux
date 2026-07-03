import { describe, expect, it, vi } from "vitest";
import { CommandRegistry } from "../../src/server/command-registry.js";
import { CommandRouter } from "../../src/server/command-router.js";
import { loadConfig } from "../../src/utils/config.js";

// /autocontinue re-reads config from disk on each invocation; stub it so tests control maxConsecutive.
vi.mock("../../src/utils/config.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../src/utils/config.js")>()),
	loadConfig: vi.fn().mockResolvedValue({ autoContinue: { enabled: true, maxConsecutive: 20 } }),
}));

function createMockMainAgent(state: "idle" | "executing" = "idle") {
	let autoContinue = false;
	let autoContinueMax = 10;
	return {
		state,
		handleMessage: vi.fn().mockResolvedValue(undefined),
		requestStop: vi.fn(),
		waitForIdle: vi.fn().mockResolvedValue(undefined),
		runMaintenance: vi.fn(async (fn: () => Promise<unknown>) => fn()),
		isAutoContinueEnabled: vi.fn(() => autoContinue),
		setAutoContinueEnabled: vi.fn((on: boolean) => {
			autoContinue = on;
			return autoContinue;
		}),
		getAutoContinueMax: vi.fn(() => autoContinueMax),
		setAutoContinueMax: vi.fn((max: number) => {
			autoContinueMax = max;
			return autoContinueMax;
		}),
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
	let mockCtx: ReturnType<typeof createMockContextManager>;
	let mockBroadcaster: ReturnType<typeof createMockBroadcaster>;
	let commandRouter: CommandRouter;
	let commandRegistry: CommandRegistry;

	function setup(agentState: "idle" | "executing" = "idle") {
		mockAgent = createMockMainAgent(agentState);
		mockCtx = createMockContextManager();
		mockBroadcaster = createMockBroadcaster();
		commandRegistry = new CommandRegistry();
		commandRouter = new CommandRouter({
			mainAgent: mockAgent,
			contextManager: mockCtx,
			broadcaster: mockBroadcaster,
			commandRegistry,
		});
	}

	describe("/stop", () => {
		it("should call mainAgent.requestStop() when executing", async () => {
			setup("executing");
			await commandRouter.handle("stop");
			expect(mockAgent.requestStop).toHaveBeenCalled();
		});

		it("should broadcast message when not executing", async () => {
			setup("idle");
			await commandRouter.handle("stop");
			expect(mockAgent.requestStop).not.toHaveBeenCalled();
			expect(mockBroadcaster.broadcast).toHaveBeenCalledWith(
				expect.objectContaining({ type: "system", message: "No task is currently executing" }),
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
			expect(mockAgent.requestStop).toHaveBeenCalled();
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
				expect.objectContaining({
					type: "system",
					message: "Conversation history compressed and injected into the system prompt",
				}),
			);
		});

		it("should skip compression when conversation is empty", async () => {
			mockAgent = createMockMainAgent("idle");
			mockCtx = createMockContextManager(false);
			mockCtx.getConversationLength = vi.fn().mockReturnValue(0);
			mockBroadcaster = createMockBroadcaster();
			commandRegistry = new CommandRegistry();
			commandRouter = new CommandRouter({
				mainAgent: mockAgent,
				contextManager: mockCtx,
				broadcaster: mockBroadcaster,
				commandRegistry,
			});
			await commandRouter.handle("compact");
			expect(mockCtx.compress).not.toHaveBeenCalled();
			expect(mockBroadcaster.broadcast).toHaveBeenCalledWith(
				expect.objectContaining({ type: "system", message: "No conversation to compress" }),
			);
		});

		it("should stop first then compress when executing", async () => {
			setup("executing");
			await commandRouter.handle("compact");
			expect(mockAgent.requestStop).toHaveBeenCalled();
			expect(mockAgent.waitForIdle).toHaveBeenCalled();
			expect(mockCtx.compress).toHaveBeenCalled();
		});
	});

	describe("/tidy", () => {
		it("should broadcast unavailable message when dependencies are missing", async () => {
			setup();
			await commandRouter.handle("tidy");
			expect(mockBroadcaster.broadcast).toHaveBeenCalledWith(
				expect.objectContaining({ type: "system", message: expect.stringContaining("unavailable") }),
			);
		});

		it("should broadcast empty message when no memory files exist", async () => {
			mockAgent = createMockMainAgent("idle");
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
			expect(calls.some((c: any) => c.type === "system" && c.message.includes("Tidying memory files"))).toBe(true);
			expect(calls.some((c: any) => c.type === "system" && c.message.includes("nothing to tidy"))).toBe(true);
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

				// SRV-4: the original file must be backed up OUTSIDE the indexed memory/ tree
				// before it is overwritten.
				const { readFile: readFileFs } = await import("node:fs/promises");
				const backup = await readFileFs(
					join(tmpDir, "memory-backups", `${new Date().toISOString().slice(0, 10)}-core.md`),
					"utf-8",
				);
				expect(backup).toBe("# Core\n- old decision\n- current decision");

				// Should broadcast completion
				const calls = mockBroadcaster.broadcast.mock.calls.map((c: any) => c[0]);
				expect(calls.some((c: any) => c.type === "system" && c.message.includes("Memory tidy complete"))).toBe(
					true,
				);
			} finally {
				await rm(tmpDir, { recursive: true, force: true });
			}
		});

		it("SRV-4: skips overwrite when retained is empty against a non-empty original", async () => {
			const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
			const { tmpdir } = await import("node:os");
			const { join } = await import("node:path");

			const tmpDir = await mkdtemp(join(tmpdir(), "cliclaw-tidy-guard-"));
			await mkdir(join(tmpDir, "memory"), { recursive: true });
			await writeFile(join(tmpDir, "memory/core.md"), "# Core\n- important decision");

			try {
				mockAgent = createMockMainAgent("idle");
				mockCtx = createMockContextManager();
				mockBroadcaster = createMockBroadcaster();
				commandRegistry = new CommandRegistry();

				// A truncated/hallucinated response: retained is whitespace-only.
				const mockLlmClient = {
					completeJson: vi.fn().mockResolvedValue({ retained: "   ", archived: "", summary: "" }),
				} as any;
				const mockPromptLoader = { resolve: vi.fn().mockReturnValue("prompt") } as any;
				const mockMemoryStore = {
					getStorageDir: vi.fn().mockReturnValue(tmpDir),
					write: vi.fn().mockResolvedValue({ success: true }),
					markDirty: vi.fn(),
				} as any;

				commandRouter = new CommandRouter({
					mainAgent: mockAgent,
					contextManager: mockCtx,
					broadcaster: mockBroadcaster,
					commandRegistry,
					llmClient: mockLlmClient,
					promptLoader: mockPromptLoader,
					memoryStore: mockMemoryStore,
					syncMemory: vi.fn().mockResolvedValue(undefined),
				});

				await commandRouter.handle("tidy");

				// The file must NOT have been overwritten.
				expect(mockMemoryStore.write).not.toHaveBeenCalledWith(
					expect.objectContaining({ path: "memory/core.md", mode: "overwrite" }),
				);
				// The original content is intact on disk.
				const { readFile: readFileFs } = await import("node:fs/promises");
				const content = await readFileFs(join(tmpDir, "memory/core.md"), "utf-8");
				expect(content).toBe("# Core\n- important decision");
			} finally {
				await rm(tmpDir, { recursive: true, force: true });
			}
		});
	});

	describe("i18n (SRV-5)", () => {
		it("routes broadcasts through the zh-CN string table when locale is zh-CN", async () => {
			const mockAgentLocal = createMockMainAgent("idle");
			const mockCtxLocal = createMockContextManager();
			const mockBroadcasterLocal = createMockBroadcaster();
			const router = new CommandRouter({
				mainAgent: mockAgentLocal,
				contextManager: mockCtxLocal,
				broadcaster: mockBroadcasterLocal,
				commandRegistry: new CommandRegistry(),
				locale: "zh-CN",
			});
			await router.handle("stop");
			expect(mockBroadcasterLocal.broadcast).toHaveBeenCalledWith(
				expect.objectContaining({ type: "system", message: "当前未在执行任务" }),
			);
		});

		it("localizes built-in command descriptions per locale", () => {
			const zhRegistry = new CommandRegistry();
			new CommandRouter({
				mainAgent: createMockMainAgent(),
				contextManager: createMockContextManager(),
				broadcaster: createMockBroadcaster(),
				commandRegistry: zhRegistry,
				locale: "zh-CN",
			});
			expect(zhRegistry.get("stop")?.description).toBe("停止当前执行任务");

			const enRegistry = new CommandRegistry();
			new CommandRouter({
				mainAgent: createMockMainAgent(),
				contextManager: createMockContextManager(),
				broadcaster: createMockBroadcaster(),
				commandRegistry: enRegistry,
				locale: "en-US",
			});
			expect(enRegistry.get("stop")?.description).toBe("Stop the currently executing task");
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
				expect.objectContaining({ type: "system", message: expect.stringContaining("auto-continue enabled") }),
			);
		});

		it("toggles auto-continue off when already on", async () => {
			setup("idle");
			mockAgent.setAutoContinueEnabled(true); // pre-enable
			await commandRouter.handle("autocontinue");
			expect(mockAgent.setAutoContinueEnabled).toHaveBeenLastCalledWith(false);
			expect(mockBroadcaster.broadcast).toHaveBeenCalledWith(
				expect.objectContaining({ type: "system", message: expect.stringContaining("auto-continue disabled") }),
			);
		});

		it("re-reads config and applies maxConsecutive, surfacing the effective limit when turning on", async () => {
			setup("idle");
			await commandRouter.handle("autocontinue");
			expect(loadConfig).toHaveBeenCalled();
			expect(mockAgent.setAutoContinueMax).toHaveBeenCalledWith(20);
			expect(mockBroadcaster.broadcast).toHaveBeenCalledWith(
				expect.objectContaining({ type: "system", message: expect.stringContaining("cap 20") }),
			);
		});

		it("still toggles even if config reload fails", async () => {
			setup("idle");
			vi.mocked(loadConfig).mockRejectedValueOnce(new Error("bad json"));
			await commandRouter.handle("autocontinue");
			expect(mockAgent.setAutoContinueEnabled).toHaveBeenCalledWith(true);
			expect(mockBroadcaster.broadcast).toHaveBeenCalledWith(
				expect.objectContaining({ type: "system", message: expect.stringContaining("auto-continue enabled") }),
			);
		});
	});

	describe("unknown command", () => {
		it("should broadcast unknown command message", async () => {
			setup("idle");
			await commandRouter.handle("unknown");
			expect(mockBroadcaster.broadcast).toHaveBeenCalledWith(
				expect.objectContaining({ type: "system", message: "Unknown command: /unknown" }),
			);
		});
	});
});
