import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeCodeAdapter } from "../../src/agents/claude-code.js";
import type { TmuxBridge } from "../../src/tmux/bridge.js";

function createMockBridge(): TmuxBridge {
	return {
		hasSession: vi.fn().mockResolvedValue(false),
		createSession: vi.fn().mockResolvedValue(undefined),
		sendKeys: vi.fn().mockResolvedValue(undefined),
		sendText: vi.fn().mockResolvedValue(undefined),
		sendEnter: vi.fn().mockResolvedValue(undefined),
		sendEscape: vi.fn().mockResolvedValue(undefined),
		capturePane: vi.fn().mockResolvedValue({ content: "", lines: [], timestamp: Date.now() }),
	} as any;
}

describe("ClaudeCodeAdapter.launch", () => {
	let adapter: ClaudeCodeAdapter;
	let bridge: TmuxBridge;

	beforeEach(() => {
		vi.useFakeTimers();
		adapter = new ClaudeCodeAdapter();
		bridge = createMockBridge();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	/**
	 * Helper: call adapter.launch() and advance all timers so the internal sleeps resolve.
	 */
	async function launchWithTimers(opts: Parameters<typeof adapter.launch>[1]) {
		const promise = adapter.launch(bridge, opts);
		// Flush all pending timers (200ms + 10000ms sleeps)
		await vi.runAllTimersAsync();
		return promise;
	}

	it("launches with the default opus model and no mcp flags by default", async () => {
		await launchWithTimers({
			workingDir: "/tmp/test",
			sessionName: "cliclaw-test",
		});

		expect(bridge.sendText).toHaveBeenCalledWith(
			"cliclaw-test:0.0",
			"claude --permission-mode auto --model opus",
		);
	});

	it("uses the provided model in place of the default", async () => {
		await launchWithTimers({
			workingDir: "/tmp/test",
			sessionName: "cliclaw-test",
			model: "sonnet",
		});

		expect(bridge.sendText).toHaveBeenCalledWith(
			"cliclaw-test:0.0",
			"claude --permission-mode auto --model sonnet",
		);
	});

	it("appends --mcp-config and --strict-mcp-config when mcpConfigPath is provided", async () => {
		await launchWithTimers({
			workingDir: "/tmp/test",
			sessionName: "cliclaw-test",
			mcpConfigPath: "/home/user/.cliclaw/tmp/mcp-configs/cliclaw-test.json",
		});

		expect(bridge.sendText).toHaveBeenCalledWith(
			"cliclaw-test:0.0",
			"claude --permission-mode auto --model opus --mcp-config /home/user/.cliclaw/tmp/mcp-configs/cliclaw-test.json --strict-mcp-config",
		);
	});

	it("includes both --resume and --mcp-config flags", async () => {
		await launchWithTimers({
			workingDir: "/tmp/test",
			sessionName: "cliclaw-test",
			resumeId: "abc-123",
			mcpConfigPath: "/path/to/config.json",
		});

		expect(bridge.sendText).toHaveBeenCalledWith(
			"cliclaw-test:0.0",
			"claude --permission-mode auto --model opus --mcp-config /path/to/config.json --strict-mcp-config --resume abc-123",
		);
	});

	it("does not include mcp flags when mcpConfigPath is undefined", async () => {
		await launchWithTimers({
			workingDir: "/tmp/test",
			sessionName: "cliclaw-test",
			mcpConfigPath: undefined,
		});

		const sendTextCall = (bridge.sendText as any).mock.calls[0][1] as string;
		expect(sendTextCall).not.toContain("--mcp-config");
		expect(sendTextCall).not.toContain("--strict-mcp-config");
	});
});
