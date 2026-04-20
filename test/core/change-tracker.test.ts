import { execSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChangeTracker } from "../../src/core/change-tracker.js";

function git(cwd: string, args: string): string {
	return execSync(`git ${args}`, { cwd, encoding: "utf-8" });
}

describe("ChangeTracker", () => {
	let tmpDir: string;
	let tracker: ChangeTracker;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "cliclaw-ct-"));
		git(tmpDir, "init -b main");
		git(tmpDir, "config user.email a@b.c");
		git(tmpDir, "config user.name t");
		await writeFile(join(tmpDir, "a.txt"), "hello\n");
		git(tmpDir, "add .");
		git(tmpDir, "commit -m init");
		tracker = new ChangeTracker();
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	it("returns null diff when cwd is not a git repo", async () => {
		const nonRepo = await mkdtemp(join(tmpdir(), "cliclaw-nongit-"));
		await tracker.registerAgent("s-nongit", nonRepo);
		expect(await tracker.computeDiff("s-nongit")).toBeNull();
		await rm(nonRepo, { recursive: true, force: true });
	});

	it("detects committed changes between base and head", async () => {
		await tracker.registerAgent("s1", tmpDir);
		await writeFile(join(tmpDir, "b.txt"), "world\n");
		git(tmpDir, "add .");
		git(tmpDir, "commit -m second");
		const diff = await tracker.computeDiff("s1");
		expect(diff).not.toBeNull();
		expect(diff!.filesChanged).toBe(1);
		expect(diff!.filesList[0].path).toBe("b.txt");
		expect(diff!.filesList[0].status).toBe("added");
		expect(diff!.rawDiff).toContain("+world");
	});

	it("detects unstaged changes on top of baseline", async () => {
		await tracker.registerAgent("s2", tmpDir);
		await writeFile(join(tmpDir, "a.txt"), "hello\nextra\n");
		const diff = await tracker.computeDiff("s2");
		expect(diff!.filesChanged).toBe(1);
		expect(diff!.additions).toBeGreaterThanOrEqual(1);
		expect(diff!.rawDiff).toContain("+extra");
	});

	it("baseline is dirty-tree-safe: does not push onto stash stack", async () => {
		await writeFile(join(tmpDir, "a.txt"), "dirty\n"); // uncommitted before registerAgent
		await tracker.registerAgent("s3", tmpDir);
		const stashBefore = git(tmpDir, "stash list").trim();
		const diff = await tracker.computeDiff("s3");
		expect(diff).not.toBeNull();
		const stashAfter = git(tmpDir, "stash list").trim();
		expect(stashAfter).toBe(stashBefore);
	});

	it("releaseAgent forgets the session", async () => {
		await tracker.registerAgent("s4", tmpDir);
		tracker.releaseAgent("s4");
		expect(await tracker.computeDiff("s4")).toBeNull();
	});

	it("captures untracked new files without requiring git add", async () => {
		await tracker.registerAgent("s5", tmpDir);
		await writeFile(join(tmpDir, "untracked.txt"), "fresh\ncontent\n");
		const diff = await tracker.computeDiff("s5");
		expect(diff).not.toBeNull();
		expect(diff!.filesChanged).toBe(1);
		expect(diff!.filesList[0].path).toBe("untracked.txt");
		expect(diff!.filesList[0].status).toBe("added");
		expect(diff!.rawDiff).toContain("+fresh");
		expect(diff!.rawDiff).toContain("+content");
	});

	it("respects .gitignore when listing untracked files", async () => {
		await writeFile(join(tmpDir, ".gitignore"), "ignored.txt\n");
		git(tmpDir, "add .gitignore");
		git(tmpDir, "commit -m gitignore");
		await tracker.registerAgent("s6", tmpDir);
		await writeFile(join(tmpDir, "ignored.txt"), "secret\n");
		await writeFile(join(tmpDir, "visible.txt"), "public\n");
		const diff = await tracker.computeDiff("s6");
		expect(diff!.filesChanged).toBe(1);
		expect(diff!.filesList[0].path).toBe("visible.txt");
	});
});
