import { execFile } from "node:child_process";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const pexec = promisify(execFile);

/**
 * Thin, testable wrappers around the git CLI used by the worktree-isolation path
 * (create_agent `isolation: "worktree"` and kill_agent cleanup). Kept in one place
 * so tests can mock a single module instead of scattering child_process mocks.
 *
 * Every call runs `git -C <dir> …`; callers pass the directory explicitly. Errors
 * from git surface as thrown exceptions (non-zero exit) unless noted otherwise.
 */

async function git(cwd: string, args: string[]): Promise<string> {
	const { stdout } = await pexec("git", ["-C", cwd, ...args], { maxBuffer: 32 * 1024 * 1024 });
	return stdout;
}

/**
 * Ensure `pattern` (a gitignore-style line, relative to the repo root) is present in the
 * repo's local `info/exclude`. This is uncommitted and repo-local — it never touches the
 * tracked `.gitignore` — so a worktree placed inside the working tree (e.g. under
 * `.omux/worktrees/`) doesn't show up as untracked in the main checkout's `git status`.
 * Idempotent; writes to the common git dir so it applies across all linked worktrees.
 */
export async function ensureExcluded(repo: string, pattern: string): Promise<void> {
	const commonDir = (await git(repo, ["rev-parse", "--git-common-dir"])).trim();
	const gitDir = isAbsolute(commonDir) ? commonDir : join(repo, commonDir);
	const infoDir = join(gitDir, "info");
	const excludePath = join(infoDir, "exclude");
	let current = "";
	try {
		current = await readFile(excludePath, "utf-8");
	} catch {
		// info/exclude may not exist yet — ensure the directory, then create it below.
		await mkdir(infoDir, { recursive: true });
	}
	const has = current.split(/\r?\n/).some((line) => line.trim() === pattern);
	if (!has) {
		const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
		await appendFile(excludePath, `${prefix}${pattern}\n`);
	}
}

/** True when `dir` is inside a git working tree. Never throws. */
export async function isGitRepo(dir: string): Promise<boolean> {
	try {
		const out = await git(dir, ["rev-parse", "--is-inside-work-tree"]);
		return out.trim() === "true";
	} catch {
		return false;
	}
}

/** Absolute path to the top level of the working tree containing `dir`. */
export async function repoRoot(dir: string): Promise<string> {
	const out = await git(dir, ["rev-parse", "--show-toplevel"]);
	return out.trim();
}

/**
 * Create a new worktree at `path` on a fresh branch `branch` cut from the current
 * HEAD of `repo`. Throws if the path or branch already exists.
 */
export async function addWorktree(repo: string, path: string, branch: string): Promise<void> {
	await git(repo, ["worktree", "add", path, "-b", branch]);
}

/**
 * Remove the worktree at `path`. Without `force`, git refuses when the worktree has
 * uncommitted or untracked changes (which is exactly the guard we want). With
 * `force`, the worktree is removed regardless.
 */
export async function removeWorktree(repo: string, path: string, force = false): Promise<void> {
	const args = ["worktree", "remove"];
	if (force) args.push("--force");
	args.push(path);
	await git(repo, args);
}

/** Delete a local branch. `force` uses `-D` (drops even unmerged branches). */
export async function deleteBranch(repo: string, branch: string, force = false): Promise<void> {
	await git(repo, ["branch", force ? "-D" : "-d", branch]);
}

/** True when the worktree has any uncommitted or untracked changes. */
export async function isWorktreeDirty(path: string): Promise<boolean> {
	const out = await git(path, ["status", "--porcelain"]);
	return out.trim().length > 0;
}

/**
 * True when `branch` has commits not reachable from `repo`'s current HEAD — i.e. the
 * branch has work that hasn't been merged back. Returns false when every commit on
 * the branch is already in HEAD (fully merged, or the branch never diverged).
 */
export async function hasUnmergedCommits(repo: string, branch: string): Promise<boolean> {
	const out = await git(repo, ["rev-list", branch, "--not", "HEAD"]);
	return out.trim().length > 0;
}
