import { execSync } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	addWorktree,
	deleteBranch,
	ensureExcluded,
	hasUnmergedCommits,
	isGitRepo,
	isWorktreeDirty,
	removeWorktree,
	repoRoot,
} from "../../src/utils/git.js";

function git(cwd: string, args: string): string {
	return execSync(`git ${args}`, { cwd, encoding: "utf-8" });
}

async function exists(path: string): Promise<boolean> {
	return stat(path).then(
		() => true,
		() => false,
	);
}

describe("git worktree helpers", () => {
	let repo: string;
	let wt: string;

	beforeEach(async () => {
		repo = await mkdtemp(join(tmpdir(), "omux-git-"));
		git(repo, "init -b main");
		git(repo, "config user.email a@b.c");
		git(repo, "config user.name t");
		await writeFile(join(repo, "a.txt"), "hello\n");
		git(repo, "add .");
		git(repo, "commit -m init");
		wt = join(await mkdtemp(join(tmpdir(), "omux-wt-")), "checkout");
	});

	afterEach(async () => {
		await rm(repo, { recursive: true, force: true });
		await rm(join(wt, ".."), { recursive: true, force: true });
	});

	it("isGitRepo distinguishes repos from plain dirs", async () => {
		expect(await isGitRepo(repo)).toBe(true);
		const plain = await mkdtemp(join(tmpdir(), "omux-plain-"));
		expect(await isGitRepo(plain)).toBe(false);
		await rm(plain, { recursive: true, force: true });
	});

	it("repoRoot returns an absolute path inside the repo", async () => {
		const root = await repoRoot(repo);
		expect(root.startsWith("/")).toBe(true);
		expect(await isGitRepo(root)).toBe(true);
		// Resolves to the same tree (macOS /var → /private/var symlink tolerated).
		expect(root.endsWith(repo.replace(/^\/private/, ""))).toBe(true);
	});

	it("addWorktree creates a checkout on a fresh branch", async () => {
		await addWorktree(repo, wt, "omux/feat");
		expect(await exists(join(wt, "a.txt"))).toBe(true);
		const branches = git(repo, "branch --list omux/feat");
		expect(branches).toContain("omux/feat");
		// A freshly-added worktree is clean and has no unmerged commits.
		expect(await isWorktreeDirty(wt)).toBe(false);
		expect(await hasUnmergedCommits(repo, "omux/feat")).toBe(false);
	});

	it("isWorktreeDirty detects uncommitted and untracked changes", async () => {
		await addWorktree(repo, wt, "omux/feat");
		await writeFile(join(wt, "new.txt"), "x\n");
		expect(await isWorktreeDirty(wt)).toBe(true);
	});

	it("hasUnmergedCommits flags committed-but-unmerged branch work", async () => {
		await addWorktree(repo, wt, "omux/feat");
		await writeFile(join(wt, "b.txt"), "world\n");
		git(wt, "add .");
		git(wt, "commit -m work");
		// Committed on the branch but never merged into main's HEAD.
		expect(await isWorktreeDirty(wt)).toBe(false);
		expect(await hasUnmergedCommits(repo, "omux/feat")).toBe(true);
		// After merging into main, it is no longer unmerged.
		git(repo, "merge omux/feat");
		expect(await hasUnmergedCommits(repo, "omux/feat")).toBe(false);
	});

	it("ensureExcluded keeps an in-repo worktree out of the main checkout's status", async () => {
		const inRepoWt = join(repo, ".omux", "worktrees", "omux-foo");
		await ensureExcluded(repo, ".omux/worktrees/");
		await addWorktree(repo, inRepoWt, "omux/foo");
		// Main checkout stays clean despite a worktree living inside its working tree.
		expect(git(repo, "status --porcelain").trim()).toBe("");
		// Idempotent: a second call does not duplicate the exclude line.
		await ensureExcluded(repo, ".omux/worktrees/");
		const excl = git(repo, "rev-parse --git-common-dir").trim();
		const exclFile = execSync(`cat "${join(repo, excl, "info", "exclude")}"`, { encoding: "utf-8" });
		expect(exclFile.match(/\.omux\/worktrees\//g)).toHaveLength(1);
		await removeWorktree(repo, inRepoWt, true);
	});

	it("removeWorktree without force refuses a dirty worktree, force succeeds", async () => {
		await addWorktree(repo, wt, "omux/feat");
		await writeFile(join(wt, "dirty.txt"), "x\n");
		await expect(removeWorktree(repo, wt, false)).rejects.toBeTruthy();
		expect(await exists(wt)).toBe(true);
		await removeWorktree(repo, wt, true);
		expect(await exists(wt)).toBe(false);
	});

	it("removeWorktree + deleteBranch cleanly tear down a merged worktree", async () => {
		await addWorktree(repo, wt, "omux/feat");
		await writeFile(join(wt, "b.txt"), "world\n");
		git(wt, "add .");
		git(wt, "commit -m work");
		git(repo, "merge omux/feat");
		await removeWorktree(repo, wt, false);
		expect(await exists(wt)).toBe(false);
		await deleteBranch(repo, "omux/feat", false); // -d succeeds because merged
		expect(git(repo, "branch --list omux/feat").trim()).toBe("");
	});
});
