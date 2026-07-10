import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TmuxBridge } from "../tmux/bridge.js";
import { logger } from "../utils/logger.js";
import type { AgentCharacteristics, ExitAgentResult, LaunchOptions } from "./adapter.js";
import { BaseTuiAdapter, pollForExit } from "./base-tui-adapter.js";

export class CodexAdapter extends BaseTuiAdapter {
	readonly name = "codex";
	readonly displayName = "Codex";
	readonly defaultModel = "gpt-5.6-sol";

	constructor(opts?: { command?: string }) {
		super("codex", opts);
	}

	protected buildLaunchCommand(opts: LaunchOptions): string {
		// Codex uses subcommand style: `codex resume <id>` (not --resume flag)
		const model = opts.model?.trim() || this.defaultModel;
		// Codex 0.142 removed `--full-auto`. The equivalent autonomous, non-interactive posture is a
		// workspace-write sandbox with no approval prompts (Codex docs recommend `never` for automation,
		// `on-failure` is deprecated). This lets omux drive Codex without it stalling on approval prompts.
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
		return cmd;
	}

	getSkillsDir(): string {
		const thisDir = dirname(fileURLToPath(import.meta.url));
		return join(thisDir, "..", "agents", "codex-skills");
	}

	getCapabilitiesFile(): string {
		return "adapters/codex.md";
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
		};
	}
}

/** TOML basic string (double-quoted, backslash/quote-escaped) for use as a dotted-key segment. */
function tomlBasicString(s: string): string {
	return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Wrap a string in POSIX single quotes for safe inclusion in a shell command line. */
function shellSingleQuote(s: string): string {
	return `'${s.replace(/'/g, "'\\''")}'`;
}
