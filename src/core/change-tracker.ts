import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { logger } from "../utils/logger.js";
import type { DiffFileEntry, DiffResult } from "./learning-types.js";

const pexec = promisify(execFile);

export interface Baseline {
	baseRef: string;
	cwd: string;
}

export class ChangeTracker {
	private baselines = new Map<string, Baseline>();

	async registerAgent(sessionId: string, cwd: string): Promise<void> {
		const baseRef = await this.captureBaseline(cwd);
		if (!baseRef) return; // non-git cwd — silently skip
		this.baselines.set(sessionId, { baseRef, cwd });
	}

	async computeDiff(sessionId: string): Promise<DiffResult | null> {
		const b = this.baselines.get(sessionId);
		if (!b) return null;
		try {
			const rawDiff = await this.runDiff(b);
			if (!rawDiff.trim()) {
				return { rawDiff: "", filesChanged: 0, additions: 0, deletions: 0, filesList: [] };
			}
			const stats = this.parseStats(rawDiff);
			return { rawDiff, ...stats };
		} catch (err) {
			logger.warn("change-tracker", `diff failed for ${sessionId}: ${(err as Error).message}`);
			return null;
		}
	}

	async resolveHeadSha(cwd: string): Promise<string | null> {
		try {
			const { stdout } = await pexec("git", ["rev-parse", "HEAD"], { cwd });
			return stdout.trim();
		} catch {
			return null;
		}
	}

	getBaseline(sessionId: string): Baseline | undefined {
		return this.baselines.get(sessionId);
	}

	releaseAgent(sessionId: string): void {
		this.baselines.delete(sessionId);
	}

	private async captureBaseline(cwd: string): Promise<string | null> {
		try {
			await pexec("git", ["rev-parse", "--git-dir"], { cwd });
		} catch {
			return null;
		}
		const { stdout: status } = await pexec("git", ["status", "--porcelain"], { cwd });
		if (status.trim().length === 0) {
			const { stdout } = await pexec("git", ["rev-parse", "HEAD"], { cwd });
			return stdout.trim();
		}
		const { stdout } = await pexec("git", ["stash", "create"], { cwd });
		const sha = stdout.trim();
		if (!sha) {
			const head = await pexec("git", ["rev-parse", "HEAD"], { cwd });
			return head.stdout.trim();
		}
		return sha;
	}

	private async runDiff(b: Baseline): Promise<string> {
		// 50MB safety net; diffs beyond this throw ERR_CHILD_PROCESS_STDIO_MAXBUFFER
		// which is caught in computeDiff() and returns null (entry creation is skipped).
		const { stdout } = await pexec("git", ["diff", b.baseRef, "--"], {
			cwd: b.cwd,
			maxBuffer: 1024 * 1024 * 50,
		});
		// `git diff` does not list untracked files. Coding agents (Claude Code, Codex)
		// typically create new files without staging, so we synthesize new-file diff
		// fragments for each untracked file respecting .gitignore.
		const untrackedDiff = await this.buildUntrackedDiff(b.cwd);
		return stdout + untrackedDiff;
	}

	private async buildUntrackedDiff(cwd: string): Promise<string> {
		const { stdout } = await pexec("git", ["ls-files", "--others", "--exclude-standard"], { cwd });
		const files = stdout.split("\n").filter((f) => f.length > 0);
		const parts: string[] = [];
		for (const file of files) {
			try {
				const content = await readFile(join(cwd, file), "utf-8");
				// Skip binary files (contain null bytes).
				if (content.includes("\u0000")) continue;
				const lines =
					content.length > 0 && content.endsWith("\n") ? content.slice(0, -1).split("\n") : content.split("\n");
				const header = `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n`;
				const body = lines.map((l) => `+${l}`).join("\n");
				parts.push(header + body + "\n");
			} catch {
				// Unreadable file — skip silently.
			}
		}
		return parts.join("");
	}

	private parseStats(rawDiff: string): Omit<DiffResult, "rawDiff"> {
		const files: DiffFileEntry[] = [];
		let additions = 0;
		let deletions = 0;
		const lines = rawDiff.split("\n");
		let currentPath: string | null = null;
		let currentStatus: DiffFileEntry["status"] = "modified";
		let newFileFlag = false;
		let deletedFileFlag = false;
		let renameFlag = false;
		for (const line of lines) {
			if (line.startsWith("diff --git ")) {
				if (currentPath) files.push({ path: currentPath, status: currentStatus });
				const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
				currentPath = match ? match[2] : null;
				currentStatus = "modified";
				newFileFlag = false;
				deletedFileFlag = false;
				renameFlag = false;
			} else if (line.startsWith("new file mode")) {
				newFileFlag = true;
			} else if (line.startsWith("deleted file mode")) {
				deletedFileFlag = true;
			} else if (line.startsWith("rename from ") || line.startsWith("rename to ")) {
				renameFlag = true;
			} else if (line.startsWith("+") && !line.startsWith("+++")) {
				additions++;
			} else if (line.startsWith("-") && !line.startsWith("---")) {
				deletions++;
			}
			if (currentPath) {
				if (newFileFlag) currentStatus = "added";
				else if (deletedFileFlag) currentStatus = "deleted";
				else if (renameFlag) currentStatus = "renamed";
			}
		}
		if (currentPath) files.push({ path: currentPath, status: currentStatus });
		return { filesChanged: files.length, additions, deletions, filesList: files };
	}
}
