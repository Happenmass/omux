import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CodexAdapter } from "../../src/agents/codex.js";
import type { TmuxBridge } from "../../src/tmux/bridge.js";

function createMockBridge(captureContent: string): TmuxBridge {
	return {
		sendKeys: vi.fn().mockResolvedValue(undefined),
		sendText: vi.fn().mockResolvedValue(undefined),
		sendEnter: vi.fn().mockResolvedValue(undefined),
		sendEscape: vi.fn().mockResolvedValue(undefined),
		hasSession: vi.fn().mockResolvedValue(false),
		createSession: vi.fn().mockResolvedValue(undefined),
		capturePane: vi
			.fn()
			.mockResolvedValue({ content: captureContent, lines: captureContent.split("\n"), timestamp: Date.now() }),
	} as any;
}

describe("CodexAdapter.launch", () => {
	let adapter: CodexAdapter;

	beforeEach(() => {
		vi.useFakeTimers();
		adapter = new CodexAdapter();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("should launch with 'codex --full-auto' command for fresh session", async () => {
		const bridge = createMockBridge("");
		const launchPromise = adapter.launch(bridge, {
			workingDir: "/tmp/test",
			sessionName: "cliclaw-test",
		});
		await vi.advanceTimersByTimeAsync(11000);
		await launchPromise;

		expect(bridge.createSession).toHaveBeenCalledWith("cliclaw-test", { cwd: "/tmp/test" });
		expect(bridge.sendText).toHaveBeenCalledWith("cliclaw-test:0.0", "codex --full-auto");
		expect(bridge.sendEnter).toHaveBeenCalledWith("cliclaw-test:0.0");
	});

	it("should launch with 'codex resume <id> --full-auto' subcommand for resume", async () => {
		const bridge = createMockBridge("");
		const launchPromise = adapter.launch(bridge, {
			workingDir: "/tmp/test",
			sessionName: "cliclaw-test",
			resumeId: "019d41a7-3a10-7b73-90a6-62ee8fa056f6",
		});
		await vi.advanceTimersByTimeAsync(11000);
		await launchPromise;

		expect(bridge.sendText).toHaveBeenCalledWith(
			"cliclaw-test:0.0",
			"codex resume 019d41a7-3a10-7b73-90a6-62ee8fa056f6 --full-auto",
		);
	});
});

describe("CodexAdapter.exitAgent", () => {
	let adapter: CodexAdapter;
	const pane = "test:0.0";

	beforeEach(() => {
		adapter = new CodexAdapter();
	});

	it("should send single Ctrl+C and extract session id", async () => {
		const captureContent = [
			"Token usage: total=21,195 input=21,129 (+ 3,456 cached) output=66 (reasoning 51)",
			"To continue this session, run codex resume 019d41a7-3a10-7b73-90a6-62ee8fa056f6",
			"",
			"$",
		].join("\n");

		const bridge = createMockBridge(captureContent);
		const result = await adapter.exitAgent(bridge, pane);

		// Should send C-c only once (not double like Claude Code)
		expect(bridge.sendKeys).toHaveBeenCalledTimes(1);
		expect(bridge.sendKeys).toHaveBeenCalledWith(pane, "C-c");

		expect(bridge.capturePane).toHaveBeenCalledWith(pane);
		expect(result.resumeId).toBe("019d41a7-3a10-7b73-90a6-62ee8fa056f6");
		expect(result.content).toBe(captureContent);
	});

	it("should return undefined sessionId when no resume pattern found", async () => {
		const captureContent = "Some random output\n$";
		const bridge = createMockBridge(captureContent);

		const result = await adapter.exitAgent(bridge, pane);

		expect(result.resumeId).toBeUndefined();
		expect(result.content).toBe(captureContent);
	});
});

describe("CodexAdapter.getCharacteristics", () => {
	it("should use › as completion prompt pattern", () => {
		const adapter = new CodexAdapter();
		const chars = adapter.getCharacteristics();

		// Should match Codex idle prompt ›
		expect(chars.completionPatterns[0].test("›")).toBe(true);
		expect(chars.completionPatterns[0].test("› ")).toBe(true);

		// Should not match mid-line ›
		expect(chars.completionPatterns[0].test("some text › more text")).toBe(false);
	});
});

describe("CodexAdapter.getOpenSpecCommands", () => {
	it("should return $ prefixed OpenSpec commands", () => {
		const adapter = new CodexAdapter();
		const cmds = adapter.getOpenSpecCommands();

		expect(cmds.toolName).toBe("codex");
		expect(cmds.explore).toBe("$openspec-explore");
		expect(cmds.propose).toBe("$openspec-propose");
		expect(cmds.apply).toBe("$openspec-apply-change");
		expect(cmds.archive).toBe("$openspec-archive-change");
		expect(cmds.wildcard).toBe("$openspec-*");
	});
});

describe("CodexAdapter.getCapabilitiesFile", () => {
	it("should return the codex adapter capabilities file path", () => {
		const adapter = new CodexAdapter();
		expect(adapter.getCapabilitiesFile()).toBe("adapters/codex.md");
	});
});
