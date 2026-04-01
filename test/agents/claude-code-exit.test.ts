import { describe, it, expect, vi, beforeEach } from "vitest";
import { ClaudeCodeAdapter } from "../../src/agents/claude-code.js";
import type { TmuxBridge } from "../../src/tmux/bridge.js";

function createMockBridge(captureContent: string): TmuxBridge {
	return {
		sendKeys: vi.fn().mockResolvedValue(undefined),
		sendText: vi.fn().mockResolvedValue(undefined),
		sendEnter: vi.fn().mockResolvedValue(undefined),
		sendEscape: vi.fn().mockResolvedValue(undefined),
		capturePane: vi.fn().mockResolvedValue({ content: captureContent, lines: captureContent.split("\n"), timestamp: Date.now() }),
	} as any;
}

describe("ClaudeCodeAdapter.exitAgent", () => {
	let adapter: ClaudeCodeAdapter;
	const pane = "test:0.0";

	beforeEach(() => {
		adapter = new ClaudeCodeAdapter();
	});

	it("should send double Ctrl+C and extract session id", async () => {
		const captureContent = [
			"⏺ Some output here",
			"",
			"Resume this session with:",
			"claude --resume 008fa0b2-bc5a-4aa0-94b0-865a67205615",
			"",
			"$",
		].join("\n");

		const bridge = createMockBridge(captureContent);
		const result = await adapter.exitAgent(bridge, pane);

		// Should send C-c twice
		expect(bridge.sendKeys).toHaveBeenCalledTimes(2);
		expect(bridge.sendKeys).toHaveBeenNthCalledWith(1, pane, "C-c");
		expect(bridge.sendKeys).toHaveBeenNthCalledWith(2, pane, "C-c");

		// Should capture pane
		expect(bridge.capturePane).toHaveBeenCalledWith(pane);

		// Should extract session id
		expect(result.resumeId).toBe("008fa0b2-bc5a-4aa0-94b0-865a67205615");
		expect(result.content).toBe(captureContent);
	});

	it("should return undefined sessionId when no resume pattern found", async () => {
		const captureContent = "Some random output\n$";
		const bridge = createMockBridge(captureContent);

		const result = await adapter.exitAgent(bridge, pane);

		expect(result.resumeId).toBeUndefined();
		expect(result.content).toBe(captureContent);
	});

	it("should handle various session id formats", async () => {
		const captureContent = "claude --resume a1b2c3d4-e5f6-7890-abcd-ef1234567890\n$";
		const bridge = createMockBridge(captureContent);

		const result = await adapter.exitAgent(bridge, pane);

		expect(result.resumeId).toBe("a1b2c3d4-e5f6-7890-abcd-ef1234567890");
	});
});

describe("ClaudeCodeAdapter.getCapabilitiesFile", () => {
	it("should return the adapter capabilities file path", () => {
		const adapter = new ClaudeCodeAdapter();
		expect(adapter.getCapabilitiesFile()).toBe("adapters/claude-code.md");
	});
});
