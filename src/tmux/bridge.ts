import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CaptureOptions, CaptureResult, SendKeysOptions, TmuxPane, TmuxSession, TmuxWindow } from "./types.js";
import { TmuxError } from "./types.js";

const execFileAsync = promisify(execFile);

const SEP = "|||";

export class TmuxBridge {
	private async exec(args: string[]): Promise<string> {
		try {
			const { stdout } = await execFileAsync("tmux", args, {
				timeout: 10000,
				maxBuffer: 1024 * 1024,
			});
			return stdout;
		} catch (err: any) {
			throw new TmuxError(
				`tmux ${args.join(" ")} failed: ${err.stderr || err.message}`,
				args.join(" "),
				err.code ?? null,
				err.stderr || "",
			);
		}
	}

	async checkInstalled(): Promise<boolean> {
		try {
			await execFileAsync("tmux", ["-V"]);
			return true;
		} catch {
			return false;
		}
	}

	async getVersion(): Promise<string> {
		const output = await this.exec(["-V"]);
		return output.trim();
	}

	// Session management

	async createSession(name: string, opts?: { cwd?: string; command?: string }): Promise<void> {
		const args = ["new-session", "-d", "-s", name];
		if (opts?.cwd) {
			args.push("-c", opts.cwd);
		}
		if (opts?.command) {
			args.push(opts.command);
		}
		await this.exec(args);
	}

	async killSession(name: string): Promise<void> {
		await this.exec(["kill-session", "-t", name]);
	}

	async hasSession(name: string): Promise<boolean> {
		try {
			await this.exec(["has-session", "-t", name]);
			return true;
		} catch {
			return false;
		}
	}

	async listSessions(): Promise<TmuxSession[]> {
		try {
			const output = await this.exec([
				"list-sessions",
				"-F",
				`#{session_name}${SEP}#{session_windows}${SEP}#{session_created}${SEP}#{session_attached}`,
			]);
			return output
				.trim()
				.split("\n")
				.filter((line) => line.length > 0)
				.map((line) => {
					const [name, windows, created, attached] = line.split(SEP);
					return {
						name,
						windows: parseInt(windows, 10),
						created: parseInt(created, 10),
						attached: attached === "1",
					};
				});
		} catch {
			return [];
		}
	}

	async listOmuxAgents(): Promise<TmuxSession[]> {
		const all = await this.listSessions();
		// Legacy cliclaw sessions are still recognized so agents created before
		// the omux rename can be adopted and managed.
		return all.filter((s) => s.name.startsWith("omux-") || s.name.startsWith("cliclaw-"));
	}

	// Window management

	async createWindow(session: string, name: string, opts?: { cwd?: string }): Promise<number> {
		const args = ["new-window", "-t", session, "-n", name, "-P", "-F", "#{window_index}"];
		if (opts?.cwd) {
			args.push("-c", opts.cwd);
		}
		const output = await this.exec(args);
		return parseInt(output.trim(), 10);
	}

	async listWindows(session: string): Promise<TmuxWindow[]> {
		const output = await this.exec([
			"list-windows",
			"-t",
			session,
			"-F",
			`#{window_index}${SEP}#{window_name}${SEP}#{window_active}${SEP}#{window_panes}`,
		]);
		return output
			.trim()
			.split("\n")
			.filter((line) => line.length > 0)
			.map((line) => {
				const [index, name, active, panes] = line.split(SEP);
				return {
					index: parseInt(index, 10),
					name,
					active: active === "1",
					panes: parseInt(panes, 10),
				};
			});
	}

	// Pane management

	async splitPane(
		target: string,
		direction: "horizontal" | "vertical" = "vertical",
		opts?: { cwd?: string; size?: string },
	): Promise<string> {
		const args = ["split-window", direction === "horizontal" ? "-h" : "-v", "-t", target, "-P", "-F", "#{pane_id}"];
		if (opts?.cwd) {
			args.push("-c", opts.cwd);
		}
		if (opts?.size) {
			args.push("-l", opts.size);
		}
		const output = await this.exec(args);
		return output.trim();
	}

	async listPanes(target: string): Promise<TmuxPane[]> {
		const output = await this.exec([
			"list-panes",
			"-t",
			target,
			"-F",
			`#{pane_id}${SEP}#{pane_index}${SEP}#{pane_width}${SEP}#{pane_height}${SEP}#{pane_active}${SEP}#{pane_pid}${SEP}#{pane_current_command}`,
		]);
		return output
			.trim()
			.split("\n")
			.filter((line) => line.length > 0)
			.map((line) => {
				const [id, index, width, height, active, pid, currentCommand] = line.split(SEP);
				return {
					id,
					index: parseInt(index, 10),
					width: parseInt(width, 10),
					height: parseInt(height, 10),
					active: active === "1",
					pid: parseInt(pid, 10),
					currentCommand: currentCommand || "",
				};
			});
	}

	async getPaneInfo(target: string): Promise<TmuxPane | undefined> {
		const panes = await this.listPanes(target);
		return panes[0];
	}

	async selectPane(target: string): Promise<void> {
		await this.exec(["select-pane", "-t", target]);
	}

	// Input: send keys to a pane

	async sendKeys(target: string, keys: string, opts?: SendKeysOptions): Promise<void> {
		const args = ["send-keys", "-t", target];
		if (opts?.literal) {
			args.push("-l");
		}
		args.push(keys);
		await this.exec(args);

		if (opts?.delay && opts.delay > 0) {
			await new Promise((resolve) => setTimeout(resolve, opts.delay));
		}
	}

	async sendText(target: string, text: string): Promise<void> {
		if (text.length <= 200 && !text.includes("\n")) {
			await this.sendKeys(target, text, { literal: true });
		} else {
			// For long text, or any text containing an embedded newline, use load-buffer +
			// paste-buffer. `send-keys -l` delivers an embedded "\n" as a real keypress,
			// which submits the input mid-string in the Claude Code/Codex TUIs — paste-buffer
			// inserts the newline as literal content instead.
			const { writeFile, unlink } = await import("node:fs/promises");
			const { randomUUID } = await import("node:crypto");
			const { join } = await import("node:path");
			const { tmpdir } = await import("node:os");

			const tmpFile = join(tmpdir(), `omux-${randomUUID()}.txt`);
			try {
				await writeFile(tmpFile, text);
				await this.exec(["load-buffer", tmpFile]);
				await this.exec(["paste-buffer", "-t", target, "-d"]);
			} finally {
				await unlink(tmpFile).catch(() => {});
			}
		}
	}

	async sendEnter(target: string): Promise<void> {
		await this.sendKeys(target, "Enter");
	}

	async sendCtrlC(target: string): Promise<void> {
		await this.sendKeys(target, "C-c");
	}

	async sendEscape(target: string): Promise<void> {
		await this.sendKeys(target, "Escape");
	}

	// Output: capture pane content

	async capturePane(target: string, opts?: CaptureOptions): Promise<CaptureResult> {
		const args = ["capture-pane", "-t", target, "-p"];

		if (!opts?.escapeSequences) {
			// -e includes escape sequences, omit for plain text
		} else {
			args.push("-e");
		}

		if (opts?.startLine !== undefined) {
			args.push("-S", opts.startLine.toString());
		}
		if (opts?.endLine !== undefined) {
			args.push("-E", opts.endLine.toString());
		}

		const output = await this.exec(args);

		// Trim trailing empty lines
		const lines = output.split("\n");
		while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
			lines.pop();
		}

		return {
			content: lines.join("\n"),
			lines,
			timestamp: Date.now(),
		};
	}

	// Run a command in a pane

	async runInPane(target: string, command: string): Promise<void> {
		await this.sendText(target, command);
		await this.sendEnter(target);
	}

	// Build a target string

	static target(session: string, window?: number, pane?: number): string {
		let t = session;
		if (window !== undefined) {
			t += `:${window}`;
			if (pane !== undefined) {
				t += `.${pane}`;
			}
		}
		return t;
	}
}
