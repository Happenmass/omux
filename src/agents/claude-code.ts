import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TmuxBridge } from "../tmux/bridge.js";
import { logger } from "../utils/logger.js";
import type { AgentCharacteristics, ExitAgentResult, LaunchOptions } from "./adapter.js";
import { BaseTuiAdapter, pollForExit, sleep } from "./base-tui-adapter.js";

export class ClaudeCodeAdapter extends BaseTuiAdapter {
	readonly name = "claude-code";
	readonly displayName = "Claude Code";
	readonly defaultModel = "opus";

	constructor(opts?: { command?: string }) {
		super("claude", opts);
	}

	protected buildLaunchCommand(opts: LaunchOptions): string {
		const model = opts.model?.trim() || this.defaultModel;
		let baseCmd = `${this.command} --permission-mode auto --model ${model}`;
		if (opts.mcpConfigPath) {
			baseCmd += ` --mcp-config ${opts.mcpConfigPath} --strict-mcp-config`;
		}
		let cmd = opts.resumeId ? `${baseCmd} --resume ${opts.resumeId}` : baseCmd;
		if (opts.preCommands && opts.preCommands.length > 0) {
			cmd = `${opts.preCommands.join(" && ")} && ${cmd}`;
		}
		return cmd;
	}

	protected async beforeSendPrompt(bridge: TmuxBridge, paneTarget: string): Promise<void> {
		// Auto-clear stuck "❯ (current)" state before sending prompt
		await this.clearStuckState(bridge, paneTarget);
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

	getSkillsDir(): string {
		const thisDir = dirname(fileURLToPath(import.meta.url));
		return join(thisDir, "..", "agents", "claude-code-skills");
	}

	getCapabilitiesFile(): string {
		return "adapters/claude-code.md";
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
				/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/, // Braille spinner (legacy frames)
				// NOTE: do NOT match the bare star glyph (✶✻✽…) — Claude Code reuses it
				// on the COMPLETED summary line too ("✻ Churned for 1m 9s"), so it cannot
				// distinguish busy from done. Rely on the two markers below instead, which
				// appear ONLY while actively processing.
				/\besc to interrupt\b/i, // Live status hint — present only while working (verb/glyph-agnostic, catches every whimsical working verb)
				/…\s*\(/, // Working verb + ellipsis before the status paren, e.g. "Pondering… (12s · esc to interrupt)"; the done line "Churned for 1m 9s" has no ellipsis
				/\.\.\.\s*$/m, // ASCII thinking dots (legacy)
				/Reading|Writing|Editing|Running/, // Capitalized live action labels (case-sensitive on purpose — lowercase forms appear in final summaries)
			],
		};
	}
}
