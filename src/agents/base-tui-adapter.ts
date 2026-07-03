import type { TmuxBridge } from "../tmux/bridge.js";
import { logger } from "../utils/logger.js";
import type { AgentAdapter, AgentCharacteristics, ExitAgentResult, LaunchOptions } from "./adapter.js";

/**
 * Shared base for TUI coding-agent adapters (Claude Code, Codex) that are driven
 * through a tmux pane. Hosts the genuinely-identical machinery — the response
 * mini-DSL, prompt/response send flow, generic key mapping, exit polling — and
 * leaves the agent-specific parts (launch command, prompt glyphs/patterns,
 * resume syntax, characteristics, exit specifics) to subclasses.
 *
 * The public {@link AgentAdapter} interface is implemented here so subclasses
 * only override what genuinely differs between agents.
 */
export abstract class BaseTuiAdapter implements AgentAdapter {
	abstract readonly name: string;
	abstract readonly displayName: string;
	abstract readonly defaultModel: string;

	protected command: string;

	constructor(defaultCommand: string, opts?: { command?: string }) {
		this.command = opts?.command || defaultCommand;
	}

	/**
	 * Launch the agent in a tmux pane. Subclasses supply the per-agent launch
	 * command via {@link buildLaunchCommand}; the create-session, send-and-enter,
	 * and 10s initialize wait are shared.
	 */
	async launch(bridge: TmuxBridge, opts: LaunchOptions): Promise<string> {
		const hasSession = await bridge.hasSession(opts.sessionName);
		if (!hasSession) {
			await bridge.createSession(opts.sessionName, { cwd: opts.workingDir });
		}

		// Use the default window (index 0) of the session
		const paneTarget = `${opts.sessionName}:0.0`;

		const cmd = this.buildLaunchCommand(opts);
		logger.info(this.name, `Launching in ${paneTarget}: ${cmd}`);
		await bridge.sendText(paneTarget, cmd);
		await sleep(200);
		await bridge.sendEnter(paneTarget);

		// Wait a fixed 10 seconds for the agent to initialize
		logger.info(this.name, "Waiting 10s for agent to initialize...");
		await sleep(10000);

		return paneTarget;
	}

	/**
	 * Build the shell command that launches the agent (including resume / MCP /
	 * pre-command handling). One line per adapter's flag conventions.
	 */
	protected abstract buildLaunchCommand(opts: LaunchOptions): string;

	async sendPrompt(bridge: TmuxBridge, paneTarget: string, prompt: string): Promise<void> {
		logger.info(this.name, `Sending prompt (${prompt.length} chars)`);

		// Adapter-specific pre-send cleanup (e.g. clearing a stuck picker state).
		await this.beforeSendPrompt(bridge, paneTarget);

		// Send the prompt text first
		await bridge.sendText(paneTarget, prompt);

		// Wait 0.2s before pressing Enter (text and Enter must be separate)
		await sleep(200);

		// Press Enter to submit
		await bridge.sendEnter(paneTarget);
	}

	/**
	 * Hook run right before the prompt text is sent. Default is a no-op; Claude
	 * Code overrides it to clear the stuck "❯ (current)" resume-picker state.
	 */
	protected async beforeSendPrompt(_bridge: TmuxBridge, _paneTarget: string): Promise<void> {
		// no-op by default
	}

	async sendResponse(bridge: TmuxBridge, paneTarget: string, response: string): Promise<void> {
		logger.info(this.name, `Sending response: ${response}`);

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

		// Priority 3: "arrow:up|down[:N]" — arrow key selection then Enter.
		// Strictly validated: a malformed directive THROWS so the LLM gets
		// actionable feedback instead of the sub-agent receiving garbage input.
		if (response.startsWith("arrow:")) {
			const { direction, times } = parseArrowDirective(response);
			for (let i = 0; i < times; i++) {
				await bridge.sendKeys(paneTarget, direction);
				await sleep(100);
			}
			await sleep(200);
			await bridge.sendEnter(paneTarget);
			return;
		}

		// Priority 4: "keys:Down,Down,Enter" — generic key sequence.
		// Each key name is validated against NAMED_KEYS or a conservative tmux
		// key-token regex; an unknown name THROWS rather than being sent raw.
		if (response.startsWith("keys:")) {
			const keyNames = parseKeysDirective(response);
			for (const key of keyNames) {
				await sendNamedKey(bridge, paneTarget, key);
				await sleep(100);
			}
			return;
		}

		// Priority 5: affirmative/negative confirmation on a genuine y/n or
		// permission prompt — honor the LLM's intent. Only "y"/"yes" auto-confirms;
		// "n"/"no" is sent literally as "n". Any other value falls through to the
		// literal-text path below — we NEVER silently convert a non-affirmative
		// response into "y".
		// Guard: skip when the pane shows a numbered menu (lines like "1. ..." / "2. ...").
		const affirmative = /^(y|yes)$/i.test(response);
		const negative = /^(n|no)$/i.test(response);
		if (affirmative || negative) {
			const capture = await bridge.capturePane(paneTarget, { startLine: -5 });
			const lastLines = capture.content;
			const hasNumberedMenu = /^\s*[❯›>»]?\s*\d+[.)]\s/m.test(lastLines);
			const isConfirmPrompt = /\(y\/n\)/i.test(lastLines) || /Allow/i.test(lastLines) || /approve/i.test(lastLines);
			if (!hasNumberedMenu && isConfirmPrompt) {
				await bridge.sendKeys(paneTarget, negative ? "n" : "y", { literal: true });
				await sleep(200);
				await bridge.sendEnter(paneTarget);
				return;
			}
		}

		// Priority 6: General text input — sendText + Enter
		await bridge.sendText(paneTarget, response);
		await sleep(200);
		await bridge.sendEnter(paneTarget);
	}

	async shutdown(bridge: TmuxBridge, paneTarget: string): Promise<void> {
		logger.info(this.name, "Shutting down agent");
		await bridge.sendText(paneTarget, "/exit");
		await sleep(200);
		await bridge.sendEnter(paneTarget);
		await sleep(1000);
	}

	async abort(bridge: TmuxBridge, paneTarget: string): Promise<void> {
		logger.info(this.name, "Aborting current operation");
		await bridge.sendEscape(paneTarget);
		await sleep(200);
		// Double escape to ensure we're back to input
		await bridge.sendEscape(paneTarget);
	}

	abstract getCharacteristics(): AgentCharacteristics;
	abstract getSkillsDir(): string;
	abstract getCapabilitiesFile(): string;
	abstract exitAgent(bridge: TmuxBridge, paneTarget: string): Promise<ExitAgentResult>;
}

/** Sleep helper shared by the base and its subclasses. */
export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse an "arrow:<direction>[:<count>]" directive. Grammar is strict:
 *   - direction MUST be exactly "up" or "down"
 *   - count, if present, MUST be a positive integer
 * A directive like "arrow:sideways:2" (bad direction) or "arrow:down:x" (bad
 * count) THROWS with an explanatory message — it must never silently degrade to
 * "Down" or become literal sub-agent input.
 */
function parseArrowDirective(response: string): { direction: "Up" | "Down"; times: number } {
	const parts = response.split(":");
	// parts[0] === "arrow"; expect 2 or 3 parts total.
	const dir = parts[1];
	if (parts.length < 2 || parts.length > 3 || (dir !== "up" && dir !== "down")) {
		throw new Error(
			`Invalid arrow directive "${response}". Expected "arrow:up" or "arrow:down" ` +
				`with an optional positive integer count, e.g. "arrow:down:2".`,
		);
	}
	let times = 1;
	if (parts.length === 3) {
		const countStr = parts[2];
		if (!/^[1-9]\d*$/.test(countStr)) {
			throw new Error(
				`Invalid arrow directive "${response}". The count must be a positive integer, e.g. "arrow:down:2".`,
			);
		}
		times = parseInt(countStr, 10);
	}
	return { direction: dir === "up" ? "Up" : "Down", times };
}

/**
 * Parse a "keys:<name>,<name>,..." directive into a list of validated key names.
 * Each name must be a known {@link NAMED_KEYS} entry or a plausible tmux key
 * token (a single printable char, or a modifier/named token like "C-c", "S-Tab",
 * "F5"). An unknown or malformed name THROWS so the LLM gets actionable feedback.
 */
function parseKeysDirective(response: string): string[] {
	const raw = response.slice(5).split(",");
	const keys: string[] = [];
	for (const key of raw) {
		const trimmed = key.trim();
		if (!trimmed) continue;
		if (!isValidKeyToken(trimmed)) {
			throw new Error(
				`Invalid key "${trimmed}" in directive "${response}". Each key must be a known name ` +
					`(${Object.keys(NAMED_KEYS).join(", ")}), a single character, or a tmux key token ` +
					`such as "C-c", "S-Tab", or "F5".`,
			);
		}
		keys.push(trimmed);
	}
	if (keys.length === 0) {
		throw new Error(`Invalid keys directive "${response}". Expected at least one key, e.g. "keys:Down,Enter".`);
	}
	return keys;
}

/**
 * Conservative validation of a tmux key token. Accepts:
 *   - a known named key (Enter, Up, Tab, …), case-insensitively via NAMED_KEYS
 *   - a single printable character (sent literally)
 *   - a function key like "F1".."F12"
 *   - a modifier-prefixed token like "C-c", "S-Tab", "M-x" (one or more of
 *     C-/S-/M- followed by a single char or a known named key)
 */
function isValidKeyToken(key: string): boolean {
	if (NAMED_KEYS[key]) return true;
	if (key.length === 1) return true;
	if (/^F([1-9]|1[0-2])$/.test(key)) return true;
	const modMatch = key.match(/^((?:[CSM]-)+)(.+)$/);
	if (modMatch) {
		const base = modMatch[2];
		if (base.length === 1) return true;
		if (NAMED_KEYS[base]) return true;
		if (/^F([1-9]|1[0-2])$/.test(base)) return true;
	}
	return false;
}

/**
 * Poll tmux pane until an exit pattern matches or timeout (5s). Shared by every
 * TUI adapter's exitAgent implementation.
 */
export async function pollForExit(
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
export const NAMED_KEYS: Record<string, string> = {
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

export async function sendNamedKey(bridge: TmuxBridge, paneTarget: string, key: string): Promise<void> {
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
