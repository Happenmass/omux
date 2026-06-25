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

export class CodexAdapter implements AgentAdapter {
	readonly name = "codex";
	readonly displayName = "Codex";
	readonly defaultModel = "gpt-5.5";

	private command: string;

	constructor(opts?: { command?: string }) {
		this.command = opts?.command || "codex";
	}

	async launch(bridge: TmuxBridge, opts: LaunchOptions): Promise<string> {
		const hasSession = await bridge.hasSession(opts.sessionName);
		if (!hasSession) {
			await bridge.createSession(opts.sessionName, { cwd: opts.workingDir });
		}

		const paneTarget = `${opts.sessionName}:0.0`;

		// Codex uses subcommand style: `codex resume <id>` (not --resume flag)
		const model = opts.model?.trim() || this.defaultModel;
		// Codex 0.142 removed `--full-auto`. The equivalent autonomous, non-interactive posture is a
		// workspace-write sandbox with no approval prompts (Codex docs recommend `never` for automation,
		// `on-failure` is deprecated). This lets cliclaw drive Codex without it stalling on approval prompts.
		//
		// Pre-empt the interactive *startup* prompts too, so an unattended launch never blocks on them.
		// These `-c` keys were verified against `codex debug models` (they validate into the real config schema):
		//   - trust dialog ("trust this folder?")  → mark this workspace trusted for the run
		//   - update-on-startup nag                → disable the check
		//   - "try the new model" migration nudge  → sidestepped by pinning --model below
		const trustOverride = `-c ${shellSingleQuote(`projects.${tomlBasicString(opts.workingDir)}.trust_level="trusted"`)}`;
		const autoFlags = `--sandbox workspace-write --ask-for-approval never ${trustOverride} -c check_for_update_on_startup=false`;
		const baseCmd = `${this.command} ${autoFlags} --model ${model}`;
		let cmd = opts.resumeId ? `${this.command} resume ${opts.resumeId} ${autoFlags} --model ${model}` : baseCmd;
		if (opts.preCommands && opts.preCommands.length > 0) {
			cmd = `${opts.preCommands.join(" && ")} && ${cmd}`;
		}
		logger.info("codex", `Launching in ${paneTarget}: ${cmd}`);
		await bridge.sendText(paneTarget, cmd);
		await sleep(200);
		await bridge.sendEnter(paneTarget);

		// Wait a fixed 10 seconds for Codex to initialize
		logger.info("codex", "Waiting 10s for agent to initialize...");
		await sleep(10000);

		return paneTarget;
	}

	async sendPrompt(bridge: TmuxBridge, paneTarget: string, prompt: string): Promise<void> {
		logger.info("codex", `Sending prompt (${prompt.length} chars)`);

		await bridge.sendText(paneTarget, prompt);
		await sleep(200);
		await bridge.sendEnter(paneTarget);
	}

	async sendResponse(bridge: TmuxBridge, paneTarget: string, response: string): Promise<void> {
		logger.info("codex", `Sending response: ${response}`);

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
		logger.info("codex", "Shutting down agent");
		await bridge.sendText(paneTarget, "/exit");
		await sleep(200);
		await bridge.sendEnter(paneTarget);
		await sleep(1000);
	}

	async abort(bridge: TmuxBridge, paneTarget: string): Promise<void> {
		logger.info("codex", "Aborting current operation");
		await bridge.sendEscape(paneTarget);
		await sleep(200);
		await bridge.sendEscape(paneTarget);
	}

	getSkillsDir(): string {
		const thisDir = dirname(fileURLToPath(import.meta.url));
		return join(thisDir, "..", "agents", "codex-skills");
	}

	getCapabilitiesFile(): string {
		return "adapters/codex.md";
	}

	getOpenSpecCommands(): OpenSpecCommands {
		return {
			toolName: "codex",
			explore: "$openspec-explore",
			propose: "$openspec-propose",
			apply: "$openspec-apply-change",
			archive: "$openspec-archive-change",
			wildcard: "$openspec-*",
		};
	}

	async exitAgent(bridge: TmuxBridge, paneTarget: string): Promise<ExitAgentResult> {
		logger.info("codex", "Exiting agent with single Ctrl+C");

		// Single Ctrl+C to exit Codex
		await bridge.sendKeys(paneTarget, "C-c");

		// Poll for exit pattern instead of fixed sleep
		const exitPatterns = [
			/codex\s+resume\s+[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
			/\$\s*$/m,
			/❯\s*$/m,
		];
		const content = await pollForExit(bridge, paneTarget, exitPatterns);

		// Extract resume id from "codex resume <uuid>" pattern
		const match = content.match(/codex\s+resume\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
		const resumeId = match?.[1];

		if (resumeId) {
			logger.info("codex", `Extracted resume id: ${resumeId}`);
		}

		return { content, resumeId };
	}

	getCharacteristics(): AgentCharacteristics {
		return {
			waitingPatterns: [
				/\(y\/n\)/i, // Yes/no prompt
				/\bAllow\b.*\?/i, // Permission prompt (word boundary + requires trailing ?)
				/›\s*\d+[.)]\s/, // Numbered option menu (› 1. Yes)
			],
			completionPatterns: [
				/›\s*$/m, // Codex idle prompt (› at end of line)
			],
			errorPatterns: [
				/^\s*Error:/m, // Error at start of line
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

/** TOML basic string (double-quoted, backslash/quote-escaped) for use as a dotted-key segment. */
function tomlBasicString(s: string): string {
	return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Wrap a string in POSIX single quotes for safe inclusion in a shell command line. */
function shellSingleQuote(s: string): string {
	return `'${s.replace(/'/g, "'\\''")}'`;
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
		await bridge.sendKeys(paneTarget, key, { literal: true });
	} else {
		await bridge.sendKeys(paneTarget, key);
	}
}
