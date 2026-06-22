import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TmuxBridge } from "../tmux/bridge.js";
import { logger } from "../utils/logger.js";
import type {
	AgentAdapter,
	AgentCharacteristics,
	ExitAgentResult,
	LaunchOptions,
	OpenSpecCommands,
} from "./adapter.js";

export class ClaudeCodeAdapter implements AgentAdapter {
	readonly name = "claude-code";
	readonly displayName = "Claude Code";

	private command: string;

	constructor(opts?: { command?: string }) {
		this.command = opts?.command || "claude";
	}

	async launch(bridge: TmuxBridge, opts: LaunchOptions): Promise<string> {
		// Create session with a single window (no extra windows)
		const hasSession = await bridge.hasSession(opts.sessionName);
		if (!hasSession) {
			await bridge.createSession(opts.sessionName, { cwd: opts.workingDir });
		}

		// Use the default window (index 0) of the session
		const paneTarget = `${opts.sessionName}:0.0`;

		// Type launch command and press Enter
		const model = opts.model?.trim() || "opus";
		let baseCmd = `${this.command} --permission-mode auto --model ${model}`;
		if (opts.mcpConfigPath) {
			baseCmd += ` --mcp-config ${opts.mcpConfigPath} --strict-mcp-config`;
		}
		let cmd = opts.resumeId ? `${baseCmd} --resume ${opts.resumeId}` : baseCmd;
		if (opts.preCommands && opts.preCommands.length > 0) {
			cmd = `${opts.preCommands.join(" && ")} && ${cmd}`;
		}
		logger.info("claude-code", `Launching in ${paneTarget}: ${cmd}`);
		await bridge.sendText(paneTarget, cmd);
		await sleep(200);
		await bridge.sendEnter(paneTarget);

		// Wait a fixed 10 seconds for Claude Code to initialize
		logger.info("claude-code", "Waiting 10s for agent to initialize...");
		await sleep(10000);

		return paneTarget;
	}

	async sendPrompt(bridge: TmuxBridge, paneTarget: string, prompt: string): Promise<void> {
		logger.info("claude-code", `Sending prompt (${prompt.length} chars)`);

		// Auto-clear stuck "❯ (current)" state before sending prompt
		await this.clearStuckState(bridge, paneTarget);

		// Send the prompt text first
		await bridge.sendText(paneTarget, prompt);

		// Wait 0.2s before pressing Enter (text and Enter must be separate)
		await sleep(200);

		// Press Enter to submit
		await bridge.sendEnter(paneTarget);
	}

	/**
	 * Detect and auto-clear the stuck "❯ (current)" state.
	 * Claude Code sometimes lands on a resume-session picker showing "❯ (current)";
	 * pressing Enter dismisses it and returns to the normal input prompt.
	 * This is transparent to MainAgent and the user.
	 */
	private async clearStuckState(bridge: TmuxBridge, paneTarget: string): Promise<void> {
		try {
			const capture = await bridge.capturePane(paneTarget, { startLine: -5 });
			const tail = capture.content;
			if (/❯\s*\(current\)/i.test(tail)) {
				logger.info("claude-code", "Detected stuck '❯ (current)' state, sending Enter to clear");
				await bridge.sendEnter(paneTarget);
				await sleep(500);
			}
		} catch {
			// Pane may have been destroyed — ignore silently
		}
	}

	async sendResponse(bridge: TmuxBridge, paneTarget: string, response: string): Promise<void> {
		logger.info("claude-code", `Sending response: ${response}`);

		// Priority 1: "Enter" — just press Enter (confirm current selection)
		if (response === "Enter") {
			await bridge.sendEnter(paneTarget);
			return;
		}

		// Priority 2: "Escape" — just press Escape
		if (response === "Escape") {
			await bridge.sendEscape(paneTarget);
			return;
		}

		// Priority 3: "arrow:down:2" — arrow key selection then Enter
		if (response.startsWith("arrow:")) {
			const parts = response.split(":");
			const direction = parts[1] === "up" ? "Up" : "Down";
			const times = parseInt(parts[2] || "1", 10);
			for (let i = 0; i < times; i++) {
				await bridge.sendKeys(paneTarget, direction);
				await sleep(100);
			}
			await sleep(200);
			await bridge.sendEnter(paneTarget);
			return;
		}

		// Priority 4: "keys:Down,Down,Enter" — generic key sequence
		if (response.startsWith("keys:")) {
			const keyNames = response.slice(5).split(",");
			for (const key of keyNames) {
				const trimmed = key.trim();
				if (!trimmed) continue;
				await sendNamedKey(bridge, paneTarget, trimmed);
				await sleep(100);
			}
			return;
		}

		// Priority 5: Detect (y/n) context — auto-confirm with 'y' + Enter
		// Only triggers for genuine y/n prompts, NOT numbered menus.
		// Guard: skip when pane shows a numbered menu (lines like "1. ..." / "2. ...").
		const capture = await bridge.capturePane(paneTarget, { startLine: -5 });
		const lastLines = capture.content;
		const hasNumberedMenu = /^\s*[❯›>»]?\s*\d+[.)]\s/m.test(lastLines);
		if (!hasNumberedMenu && (/\(y\/n\)/i.test(lastLines) || /Allow/i.test(lastLines) || /approve/i.test(lastLines))) {
			await bridge.sendKeys(paneTarget, "y", { literal: true });
			await sleep(200);
			await bridge.sendEnter(paneTarget);
			return;
		}

		// Priority 6: General text input — sendText + Enter
		await bridge.sendText(paneTarget, response);
		await sleep(200);
		await bridge.sendEnter(paneTarget);
	}

	async shutdown(bridge: TmuxBridge, paneTarget: string): Promise<void> {
		logger.info("claude-code", "Shutting down agent");
		await bridge.sendText(paneTarget, "/exit");
		await sleep(200);
		await bridge.sendEnter(paneTarget);
		await sleep(1000);
	}

	async abort(bridge: TmuxBridge, paneTarget: string): Promise<void> {
		logger.info("claude-code", "Aborting current operation");
		await bridge.sendEscape(paneTarget);
		await sleep(200);
		// Double escape to ensure we're back to input
		await bridge.sendEscape(paneTarget);
	}

	getSkillsDir(): string {
		const thisDir = dirname(fileURLToPath(import.meta.url));
		return join(thisDir, "..", "agents", "claude-code-skills");
	}

	getCapabilitiesFile(): string {
		return "adapters/claude-code.md";
	}

	getOpenSpecCommands(): OpenSpecCommands {
		return {
			toolName: "claude",
			explore: "/opsx:explore",
			propose: "/opsx:propose",
			apply: "/opsx:apply",
			archive: "/opsx:archive",
			wildcard: "/opsx:*",
		};
	}

	async exitAgent(bridge: TmuxBridge, paneTarget: string): Promise<ExitAgentResult> {
		logger.info("claude-code", "Exiting agent with double Ctrl+C");

		// Double Ctrl+C with 20ms interval to ensure clean exit
		await bridge.sendKeys(paneTarget, "C-c");
		await sleep(20);
		await bridge.sendKeys(paneTarget, "C-c");

		// Poll for exit pattern instead of fixed sleep
		const exitPatterns = [
			/claude\s+--resume\s+[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
			/\$\s*$/m,
			/❯\s*$/m,
		];
		const content = await pollForExit(bridge, paneTarget, exitPatterns);

		// Extract resume id from "claude --resume <uuid>" pattern
		const match = content.match(/claude\s+--resume\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
		const resumeId = match?.[1];

		if (resumeId) {
			logger.info("claude-code", `Extracted resume id: ${resumeId}`);
		}

		return { content, resumeId };
	}

	getCharacteristics(): AgentCharacteristics {
		return {
			waitingPatterns: [
				/\(y\/n\)/i, // Yes/no prompt
				/\bAllow\b.*\?/i, // Permission prompt (word boundary + requires trailing ?)
				/❯\s*\d+[.)]\s/, // Numbered option menu (e.g. ❯ 1. Yes)
			],
			completionPatterns: [
				/❯\s*$/m, // Claude Code idle prompt (❯ at end of line, no digits after)
			],
			errorPatterns: [
				/^\s*Error:/m, // Error at start of line (avoids matching "No Error" or log mentions)
				/ENOENT/,
				/EACCES/,
				/Connection refused/i,
				/command not found/,
			],
			activePatterns: [
				/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/, // Spinner
				/\.\.\.\s*$/m, // Thinking dots
				/Reading|Writing|Editing|Running/, // Action words (case-sensitive)
			],
			confirmKey: "y",
			abortKey: "Escape",
		};
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll tmux pane until an exit pattern matches or timeout (5s). */
async function pollForExit(
	bridge: TmuxBridge,
	paneTarget: string,
	patterns: RegExp[],
	intervalMs = 200,
	timeoutMs = 5000,
): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	let content = "";
	while (Date.now() < deadline) {
		await sleep(intervalMs);
		const capture = await bridge.capturePane(paneTarget);
		content = capture.content;
		if (patterns.some((p) => p.test(content))) break;
	}
	return content;
}

/** Map a named key to tmux send-keys argument */
const NAMED_KEYS: Record<string, string> = {
	Enter: "Enter",
	Escape: "Escape",
	Up: "Up",
	Down: "Down",
	Left: "Left",
	Right: "Right",
	Tab: "Tab",
	Space: "Space",
	Backspace: "BSpace",
};

async function sendNamedKey(bridge: TmuxBridge, paneTarget: string, key: string): Promise<void> {
	const mapped = NAMED_KEYS[key];
	if (mapped) {
		await bridge.sendKeys(paneTarget, mapped);
	} else if (key.length === 1) {
		// Single character — send as literal
		await bridge.sendKeys(paneTarget, key, { literal: true });
	} else {
		// Multi-character key name (e.g. S-Tab, C-c) — send as tmux key name
		await bridge.sendKeys(paneTarget, key);
	}
}
