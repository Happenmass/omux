import { beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeCodeAdapter } from "../../src/agents/claude-code.js";
import type { TmuxBridge } from "../../src/tmux/bridge.js";

function createMockBridge(paneContent = "> "): TmuxBridge {
	return {
		sendKeys: vi.fn().mockResolvedValue(undefined),
		sendText: vi.fn().mockResolvedValue(undefined),
		sendEnter: vi.fn().mockResolvedValue(undefined),
		sendEscape: vi.fn().mockResolvedValue(undefined),
		capturePane: vi.fn().mockResolvedValue({
			content: paneContent,
			lines: paneContent.split("\n"),
			timestamp: Date.now(),
		}),
	} as any;
}

describe("ClaudeCodeAdapter.sendResponse", () => {
	let adapter: ClaudeCodeAdapter;
	let bridge: TmuxBridge;
	const pane = "test:0.0";

	beforeEach(() => {
		adapter = new ClaudeCodeAdapter();
		bridge = createMockBridge();
	});

	it('should only press Enter for "Enter" response', async () => {
		await adapter.sendResponse(bridge, pane, "Enter");

		expect(bridge.sendEnter).toHaveBeenCalledTimes(1);
		expect(bridge.sendEnter).toHaveBeenCalledWith(pane);
		expect(bridge.sendText).not.toHaveBeenCalled();
		expect(bridge.sendKeys).not.toHaveBeenCalled();
	});

	it('should only press Escape for "Escape" response', async () => {
		await adapter.sendResponse(bridge, pane, "Escape");

		expect(bridge.sendEscape).toHaveBeenCalledTimes(1);
		expect(bridge.sendEscape).toHaveBeenCalledWith(pane);
		expect(bridge.sendText).not.toHaveBeenCalled();
		expect(bridge.sendEnter).not.toHaveBeenCalled();
	});

	it("should send arrow keys then Enter for arrow: format", async () => {
		await adapter.sendResponse(bridge, pane, "arrow:down:2");

		// 2 Down keys + 1 Enter
		expect(bridge.sendKeys).toHaveBeenCalledTimes(2);
		expect(bridge.sendKeys).toHaveBeenNthCalledWith(1, pane, "Down");
		expect(bridge.sendKeys).toHaveBeenNthCalledWith(2, pane, "Down");
		expect(bridge.sendEnter).toHaveBeenCalledTimes(1);
	});

	it("should send generic key sequence for keys: format", async () => {
		await adapter.sendResponse(bridge, pane, "keys:Down,Down,Enter");

		expect(bridge.sendKeys).toHaveBeenCalledTimes(3);
		expect(bridge.sendKeys).toHaveBeenNthCalledWith(1, pane, "Down");
		expect(bridge.sendKeys).toHaveBeenNthCalledWith(2, pane, "Down");
		expect(bridge.sendKeys).toHaveBeenNthCalledWith(3, pane, "Enter");
	});

	it("should send single character as literal in keys: format", async () => {
		await adapter.sendResponse(bridge, pane, "keys:1,Enter");

		expect(bridge.sendKeys).toHaveBeenCalledTimes(2);
		// Single char "1" should be sent as literal
		expect(bridge.sendKeys).toHaveBeenNthCalledWith(1, pane, "1", { literal: true });
		expect(bridge.sendKeys).toHaveBeenNthCalledWith(2, pane, "Enter");
	});

	it("should auto-confirm (y/n) context with 'y' when response is affirmative", async () => {
		bridge = createMockBridge("Do you want to proceed? (y/n)");

		await adapter.sendResponse(bridge, pane, "y");

		expect(bridge.sendKeys).toHaveBeenCalledWith(pane, "y", { literal: true });
		expect(bridge.sendEnter).toHaveBeenCalledTimes(1);
	});

	it("should treat 'yes' as affirmative on a (y/n) prompt", async () => {
		bridge = createMockBridge("Do you want to proceed? (y/n)");

		await adapter.sendResponse(bridge, pane, "yes");

		expect(bridge.sendKeys).toHaveBeenCalledWith(pane, "y", { literal: true });
		expect(bridge.sendEnter).toHaveBeenCalledTimes(1);
		expect(bridge.sendText).not.toHaveBeenCalled();
	});

	// ADP-1: a negative response must NOT be hijacked into an approval.
	it("should send 'n' (NOT 'y') when responding 'n' to a (y/n) prompt", async () => {
		bridge = createMockBridge("Do you want to proceed? (y/n)");

		await adapter.sendResponse(bridge, pane, "n");

		expect(bridge.sendKeys).toHaveBeenCalledWith(pane, "n", { literal: true });
		expect(bridge.sendEnter).toHaveBeenCalledTimes(1);
		// Must never have auto-confirmed with 'y'
		const yCalls = (bridge.sendKeys as any).mock.calls.filter((c: any[]) => c[1] === "y");
		expect(yCalls).toHaveLength(0);
	});

	// ADP-1: "no" on a permission prompt must be sent as a rejection, not "y".
	it("should send 'n' (NOT 'y') when responding 'no' to an 'Allow' permission prompt", async () => {
		bridge = createMockBridge("Allow this action?");

		await adapter.sendResponse(bridge, pane, "no");

		expect(bridge.sendKeys).toHaveBeenCalledWith(pane, "n", { literal: true });
		expect(bridge.sendEnter).toHaveBeenCalledTimes(1);
		const yCalls = (bridge.sendKeys as any).mock.calls.filter((c: any[]) => c[1] === "y");
		expect(yCalls).toHaveLength(0);
	});

	it("should auto-confirm plain 'Allow' prompt without numbered menu when affirmative", async () => {
		bridge = createMockBridge("Allow this action?");

		await adapter.sendResponse(bridge, pane, "y");

		expect(bridge.sendKeys).toHaveBeenCalledWith(pane, "y", { literal: true });
		expect(bridge.sendEnter).toHaveBeenCalledTimes(1);
	});

	// ADP-1: a free-text answer must NOT be silently converted into "y" on a
	// permission prompt — it falls through to the literal-text path.
	it("should NOT convert free-text into 'y' on an 'Allow' prompt", async () => {
		bridge = createMockBridge("Allow this action?");

		await adapter.sendResponse(bridge, pane, "some text");

		expect(bridge.sendText).toHaveBeenCalledWith(pane, "some text");
		expect(bridge.sendEnter).toHaveBeenCalledTimes(1);
		const yCalls = (bridge.sendKeys as any).mock.calls.filter((c: any[]) => c[1] === "y");
		expect(yCalls).toHaveLength(0);
	});

	it("should NOT auto-confirm when numbered menu is present (even with 'Allow' in pane)", async () => {
		// This is the actual Claude Code permission menu — contains "Allow" but is a numbered menu
		bridge = createMockBridge(
			["  Allow tool?", "❯ 1. Yes", "  2. Yes, allow all edits during this session (shift+tab)", "  3. No"].join(
				"\n",
			),
		);

		await adapter.sendResponse(bridge, pane, "2");

		// Should fall through to text input: sendText('2') + Enter
		expect(bridge.sendText).toHaveBeenCalledWith(pane, "2");
		expect(bridge.sendEnter).toHaveBeenCalledTimes(1);
		// Should NOT have sent 'y'
		const sendKeysCalls = (bridge.sendKeys as any).mock.calls;
		const yCalls = sendKeysCalls.filter((c: any[]) => c[1] === "y");
		expect(yCalls).toHaveLength(0);
	});

	it("should pass through option '1' as text on numbered menu", async () => {
		bridge = createMockBridge(["❯ 1. Yes", "  2. No", "  3. Cancel"].join("\n"));

		await adapter.sendResponse(bridge, pane, "1");

		expect(bridge.sendText).toHaveBeenCalledWith(pane, "1");
		expect(bridge.sendEnter).toHaveBeenCalledTimes(1);
	});

	it("should send general text + Enter as fallback", async () => {
		await adapter.sendResponse(bridge, pane, "hello world");

		expect(bridge.sendText).toHaveBeenCalledWith(pane, "hello world");
		expect(bridge.sendEnter).toHaveBeenCalledTimes(1);
	});

	// ADP-3: malformed directives must throw actionable errors, never silently
	// degrade (e.g. "arrow:sideways" must NOT become "Down") or reach the pane
	// as literal text.
	it("should throw on a bad arrow direction instead of defaulting to Down", async () => {
		await expect(adapter.sendResponse(bridge, pane, "arrow:sideways:2")).rejects.toThrow(/arrow directive/i);
		expect(bridge.sendKeys).not.toHaveBeenCalled();
		expect(bridge.sendText).not.toHaveBeenCalled();
	});

	it("should throw on a non-integer arrow count", async () => {
		await expect(adapter.sendResponse(bridge, pane, "arrow:down:x")).rejects.toThrow(/arrow directive/i);
		expect(bridge.sendKeys).not.toHaveBeenCalled();
	});

	it("should throw on a zero arrow count", async () => {
		await expect(adapter.sendResponse(bridge, pane, "arrow:down:0")).rejects.toThrow(/arrow directive/i);
		expect(bridge.sendKeys).not.toHaveBeenCalled();
	});

	it("should throw on an unknown multi-char key name in keys: directive", async () => {
		await expect(adapter.sendResponse(bridge, pane, "keys:Down,Bogus")).rejects.toThrow(/Invalid key/i);
	});

	it("should accept a modifier key token like C-c in keys: directive", async () => {
		await adapter.sendResponse(bridge, pane, "keys:C-c");

		expect(bridge.sendKeys).toHaveBeenCalledWith(pane, "C-c");
	});

	it("should still handle a valid arrow:up:3 directive", async () => {
		await adapter.sendResponse(bridge, pane, "arrow:up:3");

		expect(bridge.sendKeys).toHaveBeenCalledTimes(3);
		expect(bridge.sendKeys).toHaveBeenNthCalledWith(1, pane, "Up");
		expect(bridge.sendEnter).toHaveBeenCalledTimes(1);
	});
});
