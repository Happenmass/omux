import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

	it("should launch with the default gpt-5.5 model for fresh session", async () => {
		const bridge = createMockBridge("");
		const launchPromise = adapter.launch(bridge, {
			workingDir: "/tmp/test",
			sessionName: "omux-test",
		});
		await vi.advanceTimersByTimeAsync(11000);
		await launchPromise;

		expect(bridge.createSession).toHaveBeenCalledWith("omux-test", { cwd: "/tmp/test" });
		expect(bridge.sendText).toHaveBeenCalledWith(
			"omux-test:0.0",
			`codex --sandbox workspace-write --ask-for-approval never -c 'projects."/tmp/test".trust_level="trusted"' -c check_for_update_on_startup=false --model gpt-5.5`,
		);
		expect(bridge.sendEnter).toHaveBeenCalledWith("omux-test:0.0");
	});

	it("should use the provided model in place of the default", async () => {
		const bridge = createMockBridge("");
		const launchPromise = adapter.launch(bridge, {
			workingDir: "/tmp/test",
			sessionName: "omux-test",
			model: "gpt-5-codex",
		});
		await vi.advanceTimersByTimeAsync(11000);
		await launchPromise;

		expect(bridge.sendText).toHaveBeenCalledWith(
			"omux-test:0.0",
			`codex --sandbox workspace-write --ask-for-approval never -c 'projects."/tmp/test".trust_level="trusted"' -c check_for_update_on_startup=false --model gpt-5-codex`,
		);
	});

	it("should launch with 'codex resume <id>' subcommand + auto flags for resume", async () => {
		const bridge = createMockBridge("");
		const launchPromise = adapter.launch(bridge, {
			workingDir: "/tmp/test",
			sessionName: "omux-test",
			resumeId: "019d41a7-3a10-7b73-90a6-62ee8fa056f6",
		});
		await vi.advanceTimersByTimeAsync(11000);
		await launchPromise;

		expect(bridge.sendText).toHaveBeenCalledWith(
			"omux-test:0.0",
			`codex resume 019d41a7-3a10-7b73-90a6-62ee8fa056f6 --sandbox workspace-write --ask-for-approval never -c 'projects."/tmp/test".trust_level="trusted"' -c check_for_update_on_startup=false --model gpt-5.5`,
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

describe("CodexAdapter.getCapabilitiesFile", () => {
	it("should return the codex adapter capabilities file path", () => {
		const adapter = new CodexAdapter();
		expect(adapter.getCapabilitiesFile()).toBe("adapters/codex.md");
	});
});

describe("CodexAdapter.sendResponse", () => {
	const pane = "test:0.0";

	// ADP-1: shared base — a negative response must not be hijacked into approval.
	it("should send 'n' (NOT 'y') when responding 'n' to a (y/n) prompt", async () => {
		const adapter = new CodexAdapter();
		const bridge = createMockBridge("Do you want to proceed? (y/n)");

		await adapter.sendResponse(bridge, pane, "n");

		expect(bridge.sendKeys).toHaveBeenCalledWith(pane, "n", { literal: true });
		const yCalls = (bridge.sendKeys as any).mock.calls.filter((c: any[]) => c[1] === "y");
		expect(yCalls).toHaveLength(0);
	});

	it("should auto-confirm with 'y' when responding 'y' to a (y/n) prompt", async () => {
		const adapter = new CodexAdapter();
		const bridge = createMockBridge("Do you want to proceed? (y/n)");

		await adapter.sendResponse(bridge, pane, "y");

		expect(bridge.sendKeys).toHaveBeenCalledWith(pane, "y", { literal: true });
		expect(bridge.sendEnter).toHaveBeenCalledWith(pane);
	});

	// ADP-3: shared base — malformed directives throw for codex too.
	it("should throw on a malformed arrow directive", async () => {
		const adapter = new CodexAdapter();
		const bridge = createMockBridge("");

		await expect(adapter.sendResponse(bridge, pane, "arrow:sideways")).rejects.toThrow(/arrow directive/i);
		expect(bridge.sendKeys).not.toHaveBeenCalled();
	});

	it("should throw on an unknown keys: name", async () => {
		const adapter = new CodexAdapter();
		const bridge = createMockBridge("");

		await expect(adapter.sendResponse(bridge, pane, "keys:Bogus")).rejects.toThrow(/Invalid key/i);
	});
});
