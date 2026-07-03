import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { t } from "../../server/messages.js";
import { logger } from "../../utils/logger.js";
import type { ToolContext, ToolHandler } from "./types.js";

export const readSkill: ToolHandler = {
	definition: {
		name: "read_skill",
		description:
			"Read the full instructions of a skill by name. Use this when you need detailed guidance on how to use a specific skill (e.g., command usage, workflow, tips).",
		parameters: {
			type: "object",
			properties: {
				name: { type: "string", description: 'The skill name (e.g. "commit")' },
			},
			required: ["name"],
		},
	},
	async execute(args: Record<string, any>, ctx: ToolContext) {
		if (!ctx.skillRegistry) {
			return { output: "Skill registry not available.", terminal: false };
		}
		const skillName = args.name as string;
		const skill = ctx.skillRegistry.getByName(skillName);
		if (!skill) {
			return { output: `Skill not found: ${skillName}`, terminal: false };
		}
		return { output: skill.body, terminal: false };
	},
};

export const markFailed: ToolHandler = {
	definition: {
		name: "mark_failed",
		description:
			"Mark the current task as failed and return to idle state. Use when the task cannot be accomplished.",
		parameters: {
			type: "object",
			properties: {
				reason: { type: "string", description: "Why the task failed" },
			},
			required: ["reason"],
		},
	},
	async execute(args: Record<string, any>, ctx: ToolContext) {
		const reason = args.reason as string;
		ctx.emitLog(`Task failed: ${reason}`);
		ctx.broadcaster.broadcast({ type: "system", message: t("task_failed", ctx.locale, { reason }) });
		return { output: `Task marked as failed: ${reason}`, terminal: true };
	},
};

export const escalateToHuman: ToolHandler = {
	definition: {
		name: "escalate_to_human",
		description:
			"Escalate the current situation to the human operator and return to idle state. Use when proceeding autonomously would be riskier than pausing: destructive/irreversible operations, ambiguous user intent, major architectural trade-offs, scope expansion beyond the original request, security-sensitive changes, or production/shared resource modifications.",
		parameters: {
			type: "object",
			properties: {
				reason: { type: "string", description: "Why human intervention is needed" },
			},
			required: ["reason"],
		},
	},
	async execute(args: Record<string, any>, ctx: ToolContext) {
		const reason = args.reason as string;
		ctx.emitLog(`Escalated to human: ${reason}`);
		ctx.broadcaster.broadcast({ type: "system", message: t("human_intervention_needed", ctx.locale, { reason }) });
		return { output: `Escalated to human: ${reason}`, terminal: true };
	},
};

export const execCommand: ToolHandler = {
	definition: {
		name: "exec_command",
		description:
			"Execute a bash command directly for read-only reconnaissance. Use for reading files, browsing directories, searching code, and checking environment info. NEVER use for modifications, tests, builds, git operations, or any command with side effects — those MUST go through send_to_agent.\n\nLarge-file pre-flight: bare reads such as `cat <file>` / `less <file>` / `more <file>` / `bat <file>` / `view <file>` / `nl <file>` are intercepted before execution. If the target exceeds 500 lines or 50 KB, the command is REFUSED and you receive file metadata plus paging hints (head/tail/sed). Add an output limiter (`| head -200`, `head -n 200 file`, `sed -n '1,200p' file`, etc.) to bypass the check. For memory/ files, prefer memory_get which pages natively.",
		parameters: {
			type: "object",
			properties: {
				command: { type: "string", description: "The bash command to execute (read-only operations only)" },
				summary: {
					type: "string",
					description:
						"Very brief summary of the action for chat UI, max 20 chars (e.g., '查看目录结构', '搜索配置文件', 'Check deps')",
				},
				cwd: {
					type: "string",
					description:
						"Working directory for execution. Defaults to agent working directory if an agent exists, otherwise process.cwd().",
				},
				timeout: {
					type: "number",
					description: "Timeout in milliseconds (default: 30000)",
				},
			},
			required: ["command", "summary"],
		},
	},
	async execute(args: Record<string, any>, ctx: ToolContext) {
		const command = args.command as string;
		const execSummary = args.summary as string;
		const rawCwd = (args.cwd as string | undefined) ?? ctx.getAgentWorkingDir();
		const cwd = rawCwd.startsWith("~/")
			? join(homedir(), rawCwd.slice(2))
			: rawCwd.startsWith("~")
				? homedir()
				: rawCwd;
		const timeout = (args.timeout as number | undefined) ?? 30000;
		const MAX_OUTPUT = 10000;
		const PREFLIGHT_LINE_LIMIT = 500;
		const PREFLIGHT_BYTE_LIMIT = 50 * 1024;

		// Throttled broadcast: emit tool_activity on 1st, 4th, 7th, ... call
		const execCommandBroadcastCount = ctx.incExecCommandBroadcastCount();
		if (execCommandBroadcastCount % 3 === 1) {
			ctx.emitUiEvent("tool_activity", execSummary);
		}

		// Mutation guard: exec_command is documented as read-only, but "read-only" was
		// previously enforced only by the prompt. Reject commands carrying obvious
		// side-effect tokens BEFORE execution so a slip (or a jailbroken prompt) can't
		// mutate the workspace. Conservative & best-effort — not a bash parser.
		const mutationReason = detectMutation(command);
		if (mutationReason) {
			return {
				output: `exec_command refused: ${mutationReason}. exec_command is read-only reconnaissance — route side effects (writes, installs, tests, builds, git mutations, tmux) through send_to_agent so a sub-agent performs them.`,
				terminal: false,
			};
		}

		// Preflight: refuse to dump huge files into the LLM context.
		// Identifies bare `cat/less/more/...` reads with no output limiter and
		// returns metadata + paging suggestions instead of executing.
		const preflightTarget = preflightReadTarget(command);
		if (preflightTarget) {
			const resolvedTarget = isAbsolute(preflightTarget)
				? preflightTarget
				: preflightTarget.startsWith("~/")
					? join(homedir(), preflightTarget.slice(2))
					: join(cwd, preflightTarget);
			try {
				const st = await stat(resolvedTarget);
				if (st.isFile() && st.size > 0) {
					const buf = await readFile(resolvedTarget);
					const lineCount = countLines(buf);
					if (lineCount > PREFLIGHT_LINE_LIMIT || st.size > PREFLIGHT_BYTE_LIMIT) {
						return {
							output: formatPreflightHint(preflightTarget, lineCount, st.size, {
								lineLimit: PREFLIGHT_LINE_LIMIT,
								byteLimit: PREFLIGHT_BYTE_LIMIT,
							}),
							terminal: false,
						};
					}
				}
			} catch {
				// stat / read failed (file missing, perms, etc.) — fall through
				// to the normal exec path so the shell reports the real error.
			}
		}

		logger.debug("main-agent", `exec_command cwd="${cwd}" cmd=${JSON.stringify(command)}`);
		try {
			const execFileAsync = promisify(execFile);
			const { stdout, stderr } = await execFileAsync("bash", ["-c", command], {
				cwd,
				timeout,
				maxBuffer: 1024 * 1024,
			});
			let output = stdout + (stderr ? `\n${stderr}` : "");
			if (output.length > MAX_OUTPUT) {
				const totalLen = output.length;
				output = `${output.slice(0, MAX_OUTPUT)}\n\n[Output truncated: ${totalLen} chars total, showing first ${MAX_OUTPUT}]`;
			}
			return { output: output || "(no output)", terminal: false };
		} catch (err: any) {
			if (err.killed || err.signal === "SIGTERM") {
				return {
					output: `[exec_command timeout after ${timeout}ms]\nCommand: ${command}`,
					terminal: false,
				};
			}
			if (err.code === "ENOENT") {
				const pathEnv = process.env.PATH ?? "(unset)";
				logger.error("main-agent", `exec_command ENOENT: bash not found. PATH=${pathEnv}`);
				return {
					output: `exec_command error: bash not found (ENOENT). PATH=${pathEnv}`,
					terminal: false,
				};
			}
			if (err.code !== undefined && typeof err.code === "number") {
				let output = `[exit code: ${err.code}]\n${err.stderr || ""}${err.stdout || ""}`.trim();
				if (output.length > MAX_OUTPUT) {
					const totalLen = output.length;
					output = `${output.slice(0, MAX_OUTPUT)}\n\n[Output truncated: ${totalLen} chars total, showing first ${MAX_OUTPUT}]`;
				}
				return { output, terminal: false };
			}
			logger.error("main-agent", `exec_command unexpected error: ${err.message} ${JSON.stringify(err)}`);
			return { output: `exec_command error: ${err.message}`, terminal: false };
		}
	},
};

// ─── exec_command preflight ─────────────────────────────
//
// Pick out unguarded "dump-the-whole-file" reads (e.g. `cat src/foo.ts`) so we
// can stat the target before execution and refuse to spill thousands of lines
// into the LLM context. Returns the candidate file path, or null when the
// command is either not a read or already has its own output limiter.
//
// Rules — kept deliberately simple, no bash AST:
//   • Command verb is one of cat/less/more/bat/view/nl.
//   • Command string does NOT contain any control hint: | > head tail sed awk wc.
//     (Pipe / redirect / known limiters all imply "agent knows what it's doing".)
//   • Command string does NOT chain via ; && || — those go straight to fallback.
// stat()-level failures (file missing, process substitution, stdin, etc.) make
// the caller fall through to the normal execFile path so the shell can report
// the real error naturally.
const READ_VERBS = new Set(["cat", "less", "more", "bat", "view", "nl"]);
const CONTROL_HINT_RE = /\||>|\bhead\b|\btail\b|\bsed\b|\bawk\b|\bwc\b/;
const CHAIN_RE = /;|&&|\|\|/;

function preflightReadTarget(command: string): string | null {
	if (CHAIN_RE.test(command)) return null;
	if (CONTROL_HINT_RE.test(command)) return null;
	const trimmed = command.trim();
	const match = trimmed.match(/^(\S+)\s+(.+)$/);
	if (!match) return null;
	const verb = match[1];
	if (!READ_VERBS.has(verb)) return null;
	const tokens = match[2].split(/\s+/).filter((t) => t.length > 0 && !t.startsWith("-"));
	const target = tokens[0];
	if (!target || target === "-") return null;
	return target;
}

function countLines(buf: Buffer): number {
	let n = 0;
	for (let i = 0; i < buf.length; i++) {
		if (buf[i] === 0x0a) n++;
	}
	// Match `wc -l` semantics: trailing newline = N lines, missing = N+1 "logical" lines.
	if (buf.length > 0 && buf[buf.length - 1] !== 0x0a) n++;
	return n;
}

function formatPreflightHint(
	target: string,
	lines: number,
	bytes: number,
	limits: { lineLimit: number; byteLimit: number },
): string {
	const kb = (bytes / 1024).toFixed(1);
	const limitKb = (limits.byteLimit / 1024).toFixed(0);
	return [
		`[exec_command pre-flight: file too large]`,
		`${target}: ${lines} lines, ${bytes} bytes (${kb} KB) — limit ${limits.lineLimit} lines / ${limitKb} KB`,
		``,
		`This file would flood your context. Re-issue exec_command with one of:`,
		`  • head -n 200 ${target}                 # first 200 lines`,
		`  • tail -n 200 ${target}                 # last 200 lines`,
		`  • sed -n '1,200p' ${target}             # explicit range`,
		`  • cat ${target} | head -200             # pipe through head`,
		``,
		`If this file lives under memory/, prefer memory_get(path, from, lines) — it pages natively.`,
	].join("\n");
}

// ─── exec_command mutation guard ────────────────────────
//
// exec_command is contractually read-only. This best-effort denylist blocks the
// most common side-effecting commands BEFORE the shell runs them. It is NOT a bash
// parser — it works on a de-quoted view of the command so mutating tokens buried
// inside quoted string literals (e.g. `grep "rm -rf"`) don't false-positive, while
// real invocations (unquoted) are caught. On any match `detectMutation` returns a
// short human-readable reason; `null` means "looks read-only, allow".
//
// Heuristic (documented so future edits know the boundaries):
//   • We strip single- and double-quoted spans first, then scan the remainder.
//   • Redirections `>` / `>>` are rejected (writing to files). Bare comparison in
//     `[ ]`/`(( ))` is uncommon in reconnaissance and not worth special-casing.
//   • Mutating binaries (rm/rmdir/mv/dd/chmod/chown/kill/pkill/tee/tmux/…) match as
//     whole words. `cp` and `sed` are only rejected with their mutating flags
//     (`cp … -f`, `sed -i`), since `cp`-less reads don't exist but `sed -n`/`sed 's///'`
//     to stdout are legitimately read-only.
//   • `git` is allowed only for read subcommands (status/log/diff/show/branch/
//     rev-parse/ls-files/blame/…); any other git subcommand is rejected.
//   • Package managers (npm/pnpm/yarn/pip/pip3/uv) are rejected on install/add/remove/
//     uninstall/update/run and, for npm-likes, `npm run` (build/test belong to sub-agents).
//   • curl/wget are rejected when they carry a mutating method or a request body.
//   • `mkdir -p` stays explicitly allowed (sanctioned for seeding new project roots);
//     any other `mkdir` form is rejected.
function stripQuoted(command: string): string {
	// Remove '...' and "..." spans so tokens inside string literals don't trip the denylist.
	return command.replace(/'[^']*'/g, " ").replace(/"[^"]*"/g, " ");
}

function detectMutation(command: string): string | null {
	if (typeof command !== "string" || command.trim() === "") return null;
	const scan = stripQuoted(command);

	// Output redirection to a file (write / append). Ignore `2>&1`-style fd dups.
	if (/(^|[^0-9&>])>>?(?!&)/.test(scan)) {
		return "output redirection (> / >>) writes to a file";
	}

	// mkdir: only `mkdir -p …` is sanctioned; everything else is a mutation.
	if (/\bmkdir\b/.test(scan) && !/\bmkdir\s+-p\b/.test(scan)) {
		return "mkdir without -p mutates the filesystem (only `mkdir -p` is allowed)";
	}

	// Whole-word mutating binaries.
	const banned: Array<[RegExp, string]> = [
		[/\brm\b/, "rm deletes files"],
		[/\brmdir\b/, "rmdir removes directories"],
		[/\bmv\b/, "mv moves/renames files"],
		[/\bdd\b/, "dd writes raw data"],
		[/\bchmod\b/, "chmod changes permissions"],
		[/\bchown\b/, "chown changes ownership"],
		[/\bkill\b/, "kill signals processes"],
		[/\bpkill\b/, "pkill signals processes"],
		[/\btee\b/, "tee writes to files"],
		[/\btmux\b/, "tmux mutates terminal sessions (drive agents via send_to_agent)"],
		[/\btouch\b/, "touch creates/updates files"],
		[/\bln\b/, "ln creates links"],
	];
	for (const [re, reason] of banned) {
		if (re.test(scan)) return reason;
	}

	// cp is only a mutation when actually copying; a forced copy is the clearest signal.
	if (/\bcp\b/.test(scan)) return "cp copies files";

	// sed -i edits files in place; sed to stdout is read-only.
	if (/\bsed\b/.test(scan) && /\bsed\b[^|;&]*\s-i\b/.test(scan)) {
		return "sed -i edits files in place";
	}

	// git: allow read subcommands only.
	const gitMatch = scan.match(/\bgit\s+(-[^\s]+\s+)*([a-z-]+)/);
	if (gitMatch) {
		const sub = gitMatch[2];
		const readOnlyGit = new Set([
			"status",
			"log",
			"diff",
			"show",
			"branch",
			"rev-parse",
			"ls-files",
			"blame",
			"describe",
			"remote",
			"config",
			"cat-file",
			"shortlog",
			"reflog",
			"tag",
			"whatchanged",
		]);
		if (!readOnlyGit.has(sub)) {
			return `git ${sub} may mutate the repo (only read-only git subcommands are allowed)`;
		}
	}

	// Package managers.
	if (/\b(npm|pnpm|yarn)\s+(install|add|remove|uninstall|update|run|ci|exec|dlx)\b/.test(scan)) {
		return "package-manager install/run has side effects";
	}
	if (/\b(pip|pip3|uv)\s+(install|add|remove|uninstall|sync|pip)\b/.test(scan)) {
		return "package-manager install/remove has side effects";
	}

	// curl / wget with a mutating method or request body.
	if (/\b(curl|wget)\b/.test(scan)) {
		if (
			/(-X|--request)\s+(POST|PUT|DELETE|PATCH)\b/i.test(scan) ||
			/(--data|--data-raw|--data-binary|-d)\b/.test(scan)
		) {
			return "curl/wget with a write method or request body has side effects";
		}
	}

	return null;
}
