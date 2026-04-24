import { execSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChangeTracker } from "../../src/core/change-tracker.js";
import { LearningPipeline } from "../../src/core/learning-pipeline.js";
import { LearningStore } from "../../src/core/learning-store.js";
import { ConversationStore } from "../../src/persistence/conversation-store.js";

function g(cwd: string, a: string) {
	return execSync(`git ${a}`, { cwd, encoding: "utf-8" });
}

describe("LearningPipeline", () => {
	let tmpDir: string;
	let db: Database.Database;
	let store: LearningStore;
	let tracker: ChangeTracker;
	let summarizer: any;
	let memoryStore: any;
	let broadcaster: any;
	let pipeline: LearningPipeline;
	let repoDir: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "cliclaw-lp-"));
		db = new Database(join(tmpDir, "x.sqlite"));
		db.pragma("journal_mode = WAL");
		db.pragma("foreign_keys = ON");
		new ConversationStore(db);
		store = new LearningStore(db, join(tmpDir, "diffs"));
		tracker = new ChangeTracker();
		summarizer = {
			generate: vi.fn().mockResolvedValue({
				title: "S",
				what_changed: "w",
				why: "y",
				key_files: [],
				design_points: [],
				learning_hooks: [],
			}),
		};
		memoryStore = { edit: vi.fn().mockResolvedValue({ success: true, path: "memory/learning/x.md" }) };
		broadcaster = { broadcast: vi.fn() };
		pipeline = new LearningPipeline({
			store,
			tracker,
			summarizer,
			memoryStore,
			broadcaster,
			promptLoader: { resolve: vi.fn(() => "MD") } as any,
		});

		repoDir = join(tmpDir, "repo");
		await mkdir(repoDir);
		g(repoDir, "init -b main");
		g(repoDir, "config user.email a@b.c");
		g(repoDir, "config user.name t");
		await writeFile(join(repoDir, "a.txt"), "base\n");
		g(repoDir, "add .");
		g(repoDir, "commit -m init");
	});

	afterEach(async () => {
		db.close();
		await rm(tmpDir, { recursive: true, force: true });
	});

	it("ingestAgentKill creates entry on non-empty diff", async () => {
		await tracker.registerAgent("s1", repoDir);
		await writeFile(join(repoDir, "b.txt"), "new\n");
		g(repoDir, "add .");
		const entry = await pipeline.ingestAgentKill({
			sessionId: "s1",
			sessionName: "cliclaw-a",
			cwd: repoDir,
			agentPrompts: ["make b"],
		});
		expect(entry).not.toBeNull();
		expect(entry!.sourceType).toBe("agent");
		expect(broadcaster.broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: "learning_entry_created" }));
	});

	it("ingestAgentKill skips on empty diff", async () => {
		await tracker.registerAgent("s2", repoDir);
		const entry = await pipeline.ingestAgentKill({
			sessionId: "s2",
			sessionName: "n",
			cwd: repoDir,
			agentPrompts: [],
		});
		expect(entry).toBeNull();
		expect(broadcaster.broadcast).not.toHaveBeenCalled();
	});

	it("ingestAgentKill isolates LLM errors (still creates entry with skeleton)", async () => {
		summarizer.generate.mockResolvedValueOnce({
			title: "Untitled (LLM error)",
			what_changed: "",
			why: "",
			key_files: [],
			design_points: [],
			learning_hooks: [],
		});
		await tracker.registerAgent("s3", repoDir);
		await writeFile(join(repoDir, "c.txt"), "c\n");
		g(repoDir, "add .");
		const entry = await pipeline.ingestAgentKill({
			sessionId: "s3",
			sessionName: "n",
			cwd: repoDir,
			agentPrompts: [],
		});
		expect(entry).not.toBeNull();
		expect(entry!.title).toBe("Untitled (LLM error)");
	});

	it("merge archives originals and creates merged entry", async () => {
		await tracker.registerAgent("sA", repoDir);
		await writeFile(join(repoDir, "a1.txt"), "1\n");
		g(repoDir, "add .");
		const eA = await pipeline.ingestAgentKill({
			sessionId: "sA",
			sessionName: "A",
			cwd: repoDir,
			agentPrompts: ["A"],
		});
		await tracker.registerAgent("sB", repoDir);
		await writeFile(join(repoDir, "a2.txt"), "2\n");
		g(repoDir, "add .");
		const eB = await pipeline.ingestAgentKill({
			sessionId: "sB",
			sessionName: "B",
			cwd: repoDir,
			agentPrompts: ["B"],
		});

		const merged = await pipeline.merge([eA!.id, eB!.id]);
		expect(merged.sourceType).toBe("merged");
		expect(merged.sourceAgents).toHaveLength(2);
		expect((await store.loadEntry(eA!.id))!.status).toBe("archived");
		expect((await store.loadEntry(eB!.id))!.status).toBe("archived");
	});

	it("merge refuses archived inputs", async () => {
		await tracker.registerAgent("sX", repoDir);
		await writeFile(join(repoDir, "x.txt"), "x\n");
		g(repoDir, "add .");
		const e = await pipeline.ingestAgentKill({
			sessionId: "sX",
			sessionName: "X",
			cwd: repoDir,
			agentPrompts: [],
		});
		await store.setStatus(e!.id, "archived");
		// Create a second entry so merge has 2 ids (precondition for "needs at least 2")
		await tracker.registerAgent("sY", repoDir);
		await writeFile(join(repoDir, "y.txt"), "y\n");
		g(repoDir, "add .");
		const e2 = await pipeline.ingestAgentKill({
			sessionId: "sY",
			sessionName: "Y",
			cwd: repoDir,
			agentPrompts: [],
		});
		await expect(pipeline.merge([e!.id, e2!.id])).rejects.toThrow(/archived/);
	});

	it("regenerate replaces summary_json", async () => {
		await tracker.registerAgent("sR", repoDir);
		await writeFile(join(repoDir, "r.txt"), "r\n");
		g(repoDir, "add .");
		const e = await pipeline.ingestAgentKill({
			sessionId: "sR",
			sessionName: "R",
			cwd: repoDir,
			agentPrompts: [],
		});
		summarizer.generate.mockResolvedValueOnce({
			title: "New",
			what_changed: "nw",
			why: "",
			key_files: [],
			design_points: [],
			learning_hooks: [],
		});
		const after = await pipeline.regenerate(e!.id);
		expect(after.title).toBe("New");
	});

	it("flushToMemory writes memory file and marks flushed", async () => {
		await tracker.registerAgent("sF", repoDir);
		await writeFile(join(repoDir, "f.txt"), "f\n");
		g(repoDir, "add .");
		const e = await pipeline.ingestAgentKill({
			sessionId: "sF",
			sessionName: "F",
			cwd: repoDir,
			agentPrompts: [],
		});
		await pipeline.flushToMemory(e!.id);
		expect(memoryStore.edit).toHaveBeenCalledWith(
			expect.objectContaining({
				mode: "overwrite",
				path: `memory/learning/${e!.id}.md`,
			}),
		);
		const reloaded = await store.loadEntry(e!.id);
		expect(reloaded!.memoryFlushedAt).not.toBeNull();
	});

	it("dedup: same cwd + same diff skips second ingest", async () => {
		// First agent: create file and ingest
		await tracker.registerAgent("sD1", repoDir);
		await writeFile(join(repoDir, "dup.txt"), "content\n");
		g(repoDir, "add .");
		const first = await pipeline.ingestAgentKill({
			sessionId: "sD1",
			sessionName: "D1",
			cwd: repoDir,
			agentPrompts: [],
		});
		expect(first).not.toBeNull();

		// Second agent: same file, same content (identical diff from same baseline)
		// Reset repo fully so next agent gets a clean baseline
		g(repoDir, "reset HEAD -- .");
		g(repoDir, "checkout -- .");
		g(repoDir, "clean -fd");
		await tracker.registerAgent("sD2", repoDir);
		await writeFile(join(repoDir, "dup.txt"), "content\n");
		g(repoDir, "add .");
		const second = await pipeline.ingestAgentKill({
			sessionId: "sD2",
			sessionName: "D2",
			cwd: repoDir,
			agentPrompts: [],
		});
		expect(second).toBeNull(); // deduped

		// Only one entry in store
		const all = await store.list({ status: "active" });
		expect(all).toHaveLength(1);
	});

	it("dedup: different cwd + same diff creates both entries", async () => {
		// Create a second repo with identical content
		const repoDir2 = join(tmpDir, "repo2");
		await mkdir(repoDir2);
		g(repoDir2, "init -b main");
		g(repoDir2, "config user.email a@b.c");
		g(repoDir2, "config user.name t");
		await writeFile(join(repoDir2, "a.txt"), "base\n");
		g(repoDir2, "add .");
		g(repoDir2, "commit -m init");

		// Agent in repo1
		await tracker.registerAgent("sR1", repoDir);
		await writeFile(join(repoDir, "same.txt"), "same\n");
		g(repoDir, "add .");
		const e1 = await pipeline.ingestAgentKill({
			sessionId: "sR1",
			sessionName: "R1",
			cwd: repoDir,
			agentPrompts: [],
		});

		// Agent in repo2 with identical file change
		await tracker.registerAgent("sR2", repoDir2);
		await writeFile(join(repoDir2, "same.txt"), "same\n");
		g(repoDir2, "add .");
		const e2 = await pipeline.ingestAgentKill({
			sessionId: "sR2",
			sessionName: "R2",
			cwd: repoDir2,
			agentPrompts: [],
		});

		expect(e1).not.toBeNull();
		expect(e2).not.toBeNull();
		expect(e1!.id).not.toBe(e2!.id);
	});

	it("dedup: deleted entry does not block new creation", async () => {
		// First ingest
		await tracker.registerAgent("sDel1", repoDir);
		await writeFile(join(repoDir, "del.txt"), "v1\n");
		g(repoDir, "add .");
		const first = await pipeline.ingestAgentKill({
			sessionId: "sDel1",
			sessionName: "Del1",
			cwd: repoDir,
			agentPrompts: [],
		});
		expect(first).not.toBeNull();

		// Delete it
		await store.delete(first!.id);

		// Reset repo fully (unstage + clean) so next agent sees a clean baseline
		g(repoDir, "reset HEAD -- .");
		g(repoDir, "checkout -- .");
		g(repoDir, "clean -fd");

		// Same change again — should create since old one is deleted
		await tracker.registerAgent("sDel2", repoDir);
		await writeFile(join(repoDir, "del.txt"), "v1\n");
		g(repoDir, "add .");
		const second = await pipeline.ingestAgentKill({
			sessionId: "sDel2",
			sessionName: "Del2",
			cwd: repoDir,
			agentPrompts: [],
		});
		expect(second).not.toBeNull();
	});
});
