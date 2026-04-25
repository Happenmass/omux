import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { MainAgent } from "../../src/core/main-agent.js";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Tests for memory tool execution (search, get, write) in MainAgent.
 * Task 6.7
 */

// Use a real temporary workspace for file-based tests
let tmpDir: string;

function createMockContextManager() {
	return {
		addMessage: vi.fn(),
		getMessages: vi.fn().mockReturnValue([]),
		getSystemPrompt: vi.fn().mockReturnValue("system prompt"),
		updateModule: vi.fn(),
		shouldCompress: vi.fn().mockReturnValue(false),
		compress: vi.fn(),
		getConversationLength: vi.fn().mockReturnValue(0),
		prepareForLLM: vi.fn().mockReturnValue({ system: "system prompt", messages: [] }),
		reportUsage: vi.fn(),
		shouldRunMemoryFlush: vi.fn().mockReturnValue(false),
		runMemoryFlush: vi.fn(),
		getCurrentTokenEstimate: vi.fn().mockReturnValue(0),
	} as any;
}

function createMockSignalRouter() {
	return {
		onSignal: vi.fn(),
		startMonitoring: vi.fn(),
		stopMonitoring: vi.fn(),
		notifyPromptSent: vi.fn(),
		resetCaptureExpansion: vi.fn(),
		isPaused: vi.fn().mockReturnValue(false),
		isAborted: vi.fn().mockReturnValue(false),
		emit: vi.fn(),
		on: vi.fn(),
	} as any;
}

function createMockLLMClient() {
	return {
		complete: vi.fn().mockResolvedValue({
			content: "ok",
			contentBlocks: [{ type: "text", text: "ok" }],
			usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
			stopReason: "end_turn",
			model: "test",
		}),
	} as any;
}

function createMinimalMocks() {
	return {
		adapter: { sendPrompt: vi.fn(), sendResponse: vi.fn(), abort: vi.fn(), getCharacteristics: vi.fn().mockReturnValue({}) } as any,
		bridge: { capturePane: vi.fn() } as any,
		stateDetector: { setCooldown: vi.fn(), startMonitoring: vi.fn(), stopMonitoring: vi.fn(), onStateChange: vi.fn() } as any,
	};
}

function createMockMemoryStore(workspaceDir: string) {
	return {
		getWorkspaceDir: vi.fn().mockReturnValue(workspaceDir),
		getStorageDir: vi.fn().mockReturnValue(workspaceDir),
		getTrackedFilePaths: vi.fn().mockReturnValue([]),
		isFtsAvailable: vi.fn().mockReturnValue(true),
		edit: vi.fn().mockResolvedValue({ success: true, path: "memory/core.md" }),
		write: vi.fn().mockResolvedValue({ success: true, path: "memory/core.md" }),
		close: vi.fn(),
	} as any;
}

function createAgent(opts: { memoryStore?: any; embeddingProvider?: any } = {}) {
	const mocks = createMinimalMocks();
	const broadcaster = { broadcast: vi.fn(), addClient: vi.fn(), removeClient: vi.fn(), getClientCount: vi.fn() } as any;

	return new MainAgent({
		contextManager: createMockContextManager(),
		signalRouter: createMockSignalRouter(),
		llmClient: createMockLLMClient(),
		adapter: mocks.adapter,
		bridge: mocks.bridge,
		stateDetector: mocks.stateDetector,
		broadcaster,
		memoryStore: opts.memoryStore,
		syncMemory: (opts as any).syncMemory,
		embeddingProvider: opts.embeddingProvider,
	});
}

describe("MainAgent memory tools", () => {
	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "cliclaw-memtest-"));
		await mkdir(join(tmpDir, "memory"), { recursive: true });
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	describe("memory_search", () => {
		it("should return 'not available' when no memoryStore", async () => {
			const agent = createAgent();
			const result = await (agent as any).executeTool({
				type: "tool_call",
				id: "tc1",
				name: "memory_search",
				arguments: { query: "test" },
			});
			expect(result.output).toBe("Memory store not available.");
			expect(result.terminal).toBe(false);
		});

		it("should return no results for empty store", async () => {
			const mockStore = createMockMemoryStore(tmpDir);
			const agent = createAgent({ memoryStore: mockStore });

			// Mock searchMemory to return empty
			const result = await (agent as any).executeTool({
				type: "tool_call",
				id: "tc1",
				name: "memory_search",
				arguments: { query: "nonexistent topic" },
			});

			// With FTS available but no data, will return no results
			expect(result.terminal).toBe(false);
		});

		it("should be a non-terminal tool", async () => {
			const mockStore = createMockMemoryStore(tmpDir);
			const agent = createAgent({ memoryStore: mockStore });

			const result = await (agent as any).executeTool({
				type: "tool_call",
				id: "tc1",
				name: "memory_search",
				arguments: { query: "test" },
			});

			expect(result.terminal).toBe(false);
		});
	});

	describe("memory_get", () => {
		it("should return 'not available' when no memoryStore", async () => {
			const agent = createAgent();
			const result = await (agent as any).executeTool({
				type: "tool_call",
				id: "tc1",
				name: "memory_get",
				arguments: { path: "memory/core.md" },
			});
			expect(result.output).toBe("Memory store not available.");
			expect(result.terminal).toBe(false);
		});

		it("should read a memory file successfully", async () => {
			await writeFile(join(tmpDir, "memory", "core.md"), "# Core Preferences\n- Use TypeScript\n- Prefer vitest\n");

			const mockStore = createMockMemoryStore(tmpDir);
			const agent = createAgent({ memoryStore: mockStore });

			const result = await (agent as any).executeTool({
				type: "tool_call",
				id: "tc1",
				name: "memory_get",
				arguments: { path: "memory/core.md" },
			});

			expect(result.output).toContain("# Core Preferences");
			expect(result.output).toContain("Use TypeScript");
			expect(result.terminal).toBe(false);
		});

		it("should handle line range slicing (from + lines)", async () => {
			const lines = Array.from({ length: 10 }, (_, i) => `Line ${i + 1}`);
			await writeFile(join(tmpDir, "memory", "core.md"), lines.join("\n"));

			const mockStore = createMockMemoryStore(tmpDir);
			const agent = createAgent({ memoryStore: mockStore });

			const result = await (agent as any).executeTool({
				type: "tool_call",
				id: "tc1",
				name: "memory_get",
				arguments: { path: "memory/core.md", from: 3, lines: 2 },
			});

			expect(result.output).toBe("Line 3\nLine 4");
			expect(result.terminal).toBe(false);
		});

		it("should handle file-not-found", async () => {
			const mockStore = createMockMemoryStore(tmpDir);
			const agent = createAgent({ memoryStore: mockStore });

			const result = await (agent as any).executeTool({
				type: "tool_call",
				id: "tc1",
				name: "memory_get",
				arguments: { path: "memory/nonexistent.md" },
			});

			expect(result.output).toContain("File not found");
			expect(result.terminal).toBe(false);
		});

		it("should reject path traversal attempts (../) and not read outside memory/", async () => {
			// Place a sensitive file next to the workspace's memory dir; ensure memory_get
			// can't reach it via "../" path components.
			await writeFile(join(tmpDir, "secret.txt"), "TOP-SECRET");

			const mockStore = createMockMemoryStore(tmpDir);
			const agent = createAgent({ memoryStore: mockStore });

			for (const path of ["../secret.txt", "memory/../secret.txt", "../../etc/passwd"]) {
				const result = await (agent as any).executeTool({
					type: "tool_call",
					id: "tc1",
					name: "memory_get",
					arguments: { path },
				});
				expect(result.output).toContain("Memory get error");
				expect(result.output).not.toContain("TOP-SECRET");
				expect(result.terminal).toBe(false);
			}
		});

		it("should reject non-.md and non-memory-prefixed paths", async () => {
			const mockStore = createMockMemoryStore(tmpDir);
			const agent = createAgent({ memoryStore: mockStore });

			for (const path of ["config.json", "memory/data.bin", "src/main.ts"]) {
				const result = await (agent as any).executeTool({
					type: "tool_call",
					id: "tc1",
					name: "memory_get",
					arguments: { path },
				});
				expect(result.output).toContain("Memory get error");
			}
		});
	});

	describe("memory_write", () => {
		it("should return 'not available' when no memoryStore", async () => {
			const agent = createAgent();
			const result = await (agent as any).executeTool({
				type: "tool_call",
				id: "tc1",
				name: "memory_write",
				arguments: { path: "memory/core.md", content: "test" },
			});
			expect(result.output).toBe("Memory store not available.");
			expect(result.terminal).toBe(false);
		});

		it("should edit memory file via store.edit()", async () => {
			const mockStore = createMockMemoryStore(tmpDir);
			const agent = createAgent({ memoryStore: mockStore });

			const result = await (agent as any).executeTool({
				type: "tool_call",
				id: "tc1",
				name: "memory_edit",
				arguments: { path: "memory/core.md", content: "\n- New preference" },
			});

			expect(mockStore.edit).toHaveBeenCalledWith({
				path: "memory/core.md",
				content: "\n- New preference",
				mode: "append",
				match: undefined,
			});
			expect(result.output).toContain("Edited");
			expect(result.terminal).toBe(false);
		});

		it("should trigger sync after a successful memory write", async () => {
			const mockStore = createMockMemoryStore(tmpDir);
			const syncMemory = vi.fn().mockResolvedValue(undefined);
			const agent = createAgent({ memoryStore: mockStore, syncMemory });

			await (agent as any).executeTool({
				type: "tool_call",
				id: "tc1",
				name: "memory_write",
				arguments: { path: "memory/core.md", content: "\n- New preference" },
			});

			expect(syncMemory).toHaveBeenCalledOnce();
		});

		it("should handle edit errors gracefully", async () => {
			const mockStore = createMockMemoryStore(tmpDir);
			mockStore.edit.mockRejectedValue(new Error("Only .md files under memory/ directory"));
			const agent = createAgent({ memoryStore: mockStore });

			const result = await (agent as any).executeTool({
				type: "tool_call",
				id: "tc1",
				name: "memory_write",
				arguments: { path: "src/evil.ts", content: "bad stuff" },
			});

			expect(result.output).toContain("Memory edit error");
			expect(result.terminal).toBe(false);
		});

		it("should be a non-terminal tool", async () => {
			const mockStore = createMockMemoryStore(tmpDir);
			const agent = createAgent({ memoryStore: mockStore });

			const result = await (agent as any).executeTool({
				type: "tool_call",
				id: "tc1",
				name: "memory_write",
				arguments: { path: "memory/core.md", content: "test" },
			});

			expect(result.terminal).toBe(false);
		});
	});

	describe("path security", () => {
		it("should reject writes to paths outside memory/ via store validation", async () => {
			const mockStore = createMockMemoryStore(tmpDir);
			mockStore.edit.mockRejectedValue(new Error("Only .md files under memory/ directory are allowed"));
			const agent = createAgent({ memoryStore: mockStore });

			const result = await (agent as any).executeTool({
				type: "tool_call",
				id: "tc1",
				name: "memory_write",
				arguments: { path: "src/config.ts", content: "malicious" },
			});

			expect(result.output).toContain("Memory edit error");
		});

		it("should reject writes to non-.md files via store validation", async () => {
			const mockStore = createMockMemoryStore(tmpDir);
			mockStore.edit.mockRejectedValue(new Error("Only .md files under memory/ directory are allowed"));
			const agent = createAgent({ memoryStore: mockStore });

			const result = await (agent as any).executeTool({
				type: "tool_call",
				id: "tc1",
				name: "memory_write",
				arguments: { path: "memory/data.json", content: "{}" },
			});

			expect(result.output).toContain("Memory edit error");
		});

		it("should reject path traversal attempts", async () => {
			const mockStore = createMockMemoryStore(tmpDir);
			mockStore.edit.mockRejectedValue(new Error("Only .md files under memory/ directory are allowed"));
			const agent = createAgent({ memoryStore: mockStore });

			const result = await (agent as any).executeTool({
				type: "tool_call",
				id: "tc1",
				name: "memory_write",
				arguments: { path: "../../../etc/passwd", content: "evil" },
			});

			expect(result.output).toContain("Memory edit error");
		});
	});
});
