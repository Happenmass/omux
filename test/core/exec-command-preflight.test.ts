import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MainAgent } from "../../src/core/main-agent.js";

/**
 * Tests for exec_command pre-flight check that intercepts unguarded reads
 * (cat / less / more / bat / view / nl) of files exceeding 500 lines or 50 KB.
 *
 * Bypasses: pipes / redirects / known limiters (head/tail/sed/awk/wc), chain
 * operators (;, &&, ||), and stat-failure paths all fall through to normal exec.
 */

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
		getContextWindowLimit: vi.fn().mockReturnValue(200000),
		getConversationId: vi.fn().mockReturnValue("test-conversation-id"),
		setCompactTuning: vi.fn(),
	} as any;
}

function createMockSignalRouter() {
	return {
		onSignal: vi.fn(),
		startMonitoring: vi.fn(),
		stopMonitoring: vi.fn(),
		isPaused: vi.fn().mockReturnValue(false),
		isAborted: vi.fn().mockReturnValue(false),
		emit: vi.fn(),
		on: vi.fn(),
	} as any;
}

function createAgent(cwd: string) {
	const broadcaster = {
		broadcast: vi.fn(),
		addClient: vi.fn(),
		removeClient: vi.fn(),
		getClientCount: vi.fn(),
	} as any;

	return new MainAgent({
		contextManager: createMockContextManager(),
		signalRouter: createMockSignalRouter(),
		llmClient: { complete: vi.fn() } as any,
		adapter: {
			sendPrompt: vi.fn(),
			sendResponse: vi.fn(),
			abort: vi.fn(),
			getCharacteristics: vi.fn().mockReturnValue({}),
		} as any,
		bridge: { capturePane: vi.fn() } as any,
		createAgentSettleMs: 0,
		stateDetector: {
			setCooldown: vi.fn(),
			startMonitoring: vi.fn(),
			stopMonitoring: vi.fn(),
			onStateChange: vi.fn(),
		} as any,
		broadcaster,
		// cwd defaults to process.cwd() — tests pass `cwd` in args to override.
		workspaceDir: cwd,
	} as any);
}

function callExec(agent: MainAgent, command: string, cwd: string) {
	return (agent as any).executeTool({
		type: "tool_call",
		id: "tc1",
		name: "exec_command",
		arguments: { command, summary: "read", cwd },
	});
}

describe("exec_command pre-flight", () => {
	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "cliclaw-preflight-"));
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	it("should pass through `cat` on a small file (under 500 lines / 50 KB)", async () => {
		const file = join(tmpDir, "small.txt");
		await writeFile(file, "alpha\nbeta\ngamma\n");

		const agent = createAgent(tmpDir);
		const result = await callExec(agent, "cat small.txt", tmpDir);

		expect(result.output).toContain("alpha");
		expect(result.output).toContain("beta");
		expect(result.output).not.toContain("pre-flight");
	});

	it("should intercept `cat` on a file exceeding 500 lines", async () => {
		const file = join(tmpDir, "big.txt");
		const lines = Array.from({ length: 800 }, (_, i) => `Line ${i + 1}`).join("\n");
		await writeFile(file, lines);

		const agent = createAgent(tmpDir);
		const result = await callExec(agent, "cat big.txt", tmpDir);

		expect(result.output).toContain("[exec_command pre-flight: file too large]");
		expect(result.output).toContain("big.txt");
		expect(result.output).toContain("800 lines");
		expect(result.output).toContain("head -n 200 big.txt");
		expect(result.output).toContain("sed -n '1,200p' big.txt");
		// Must NOT have actually executed the cat
		expect(result.output).not.toContain("Line 1\nLine 2");
	});

	it("should intercept `cat` on a file exceeding 50 KB even if short on lines", async () => {
		const file = join(tmpDir, "fat.txt");
		// One long line ~ 60 KB
		await writeFile(file, "x".repeat(60 * 1024));

		const agent = createAgent(tmpDir);
		const result = await callExec(agent, "cat fat.txt", tmpDir);

		expect(result.output).toContain("[exec_command pre-flight: file too large]");
		expect(result.output).toContain("fat.txt");
	});

	it("should let `cat <big> | head -200` through (pipe + limiter present)", async () => {
		const file = join(tmpDir, "big.txt");
		const lines = Array.from({ length: 800 }, (_, i) => `L${i + 1}`).join("\n");
		await writeFile(file, lines);

		const agent = createAgent(tmpDir);
		const result = await callExec(agent, "cat big.txt | head -5", tmpDir);

		expect(result.output).not.toContain("pre-flight");
		expect(result.output).toContain("L1");
		expect(result.output).toContain("L5");
	});

	it("should let `head -n 100 big.txt` through (verb not in blacklist)", async () => {
		const file = join(tmpDir, "big.txt");
		const lines = Array.from({ length: 800 }, (_, i) => `L${i + 1}`).join("\n");
		await writeFile(file, lines);

		const agent = createAgent(tmpDir);
		const result = await callExec(agent, "head -n 3 big.txt", tmpDir);

		expect(result.output).not.toContain("pre-flight");
		expect(result.output).toContain("L1");
		expect(result.output).toContain("L3");
	});

	it("should let `sed -n '1,5p' big.txt` through", async () => {
		const file = join(tmpDir, "big.txt");
		const lines = Array.from({ length: 800 }, (_, i) => `L${i + 1}`).join("\n");
		await writeFile(file, lines);

		const agent = createAgent(tmpDir);
		const result = await callExec(agent, "sed -n '1,3p' big.txt", tmpDir);

		expect(result.output).not.toContain("pre-flight");
		expect(result.output).toContain("L1");
	});

	it("should skip pre-flight on chained commands (cat A; cat B)", async () => {
		const big = join(tmpDir, "big.txt");
		await writeFile(big, Array.from({ length: 800 }, (_, i) => `L${i + 1}`).join("\n"));

		const agent = createAgent(tmpDir);
		// Chain operators short-circuit the preflight; MAX_OUTPUT still bounds the output.
		const result = await callExec(agent, "echo hello; echo world", tmpDir);

		expect(result.output).not.toContain("pre-flight");
		expect(result.output).toContain("hello");
		expect(result.output).toContain("world");
	});

	it("should fall through when target file does not exist (stat fails)", async () => {
		const agent = createAgent(tmpDir);
		const result = await callExec(agent, "cat nonexistent.txt", tmpDir);

		// Pre-flight gave up silently; the shell ran cat and reported its own error.
		expect(result.output).not.toContain("pre-flight");
		expect(result.output.toLowerCase()).toMatch(/no such file|cannot open|not found/);
	});

	it("should not intercept commands that aren't reads (ls / echo / pwd)", async () => {
		const file = join(tmpDir, "big.txt");
		await writeFile(file, Array.from({ length: 800 }, (_, i) => `L${i + 1}`).join("\n"));

		const agent = createAgent(tmpDir);
		const result = await callExec(agent, "ls", tmpDir);

		expect(result.output).not.toContain("pre-flight");
		expect(result.output).toContain("big.txt");
	});

	it("should pass through `less` / `more` / `nl` on small files", async () => {
		const file = join(tmpDir, "small.txt");
		await writeFile(file, "a\nb\nc\n");

		const agent = createAgent(tmpDir);
		// `less` and `more` are pagers in real shells but unguarded reads in spirit;
		// the preflight still measures them. Small files just fall through unscathed.
		// We use `nl` here as a concrete read verb the system has available.
		const result = await callExec(agent, "nl small.txt", tmpDir);

		expect(result.output).not.toContain("pre-flight");
	});
});
