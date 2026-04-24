import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LearningStore, computeDiffFingerprint } from "../../src/core/learning-store.js";
import type { CreateLearningEntryInput, SummaryJson } from "../../src/core/learning-types.js";
import { ConversationStore } from "../../src/persistence/conversation-store.js";

describe("learning tables schema", () => {
	let tmpDir: string;
	let db: Database.Database;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "cliclaw-learning-schema-"));
		db = new Database(join(tmpDir, "test.sqlite"));
		db.pragma("journal_mode = WAL");
		new ConversationStore(db); // triggers schema creation
	});

	afterEach(async () => {
		db.close();
		await rm(tmpDir, { recursive: true, force: true });
	});

	it("creates learning_entries table", () => {
		const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='learning_entries'").get();
		expect(row).toBeDefined();
	});

	it("creates learning_messages table with cascade delete", () => {
		const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='learning_messages'").get();
		expect(row).toBeDefined();

		db.prepare(`INSERT INTO learning_entries
			(id, title, status, source_type, source_agents, agent_prompts, summary_json, diff_stats, diff_blob_path, created_at, updated_at)
			VALUES ('lrn_x','t','active','agent','[]','[]','{}','{}','/tmp/x.diff', 1, 1)`).run();
		db.prepare(
			`INSERT INTO learning_messages (entry_id, role, content, created_at) VALUES ('lrn_x','user','hi', 1)`,
		).run();
		db.prepare(`DELETE FROM learning_entries WHERE id='lrn_x'`).run();
		const msgCount = db.prepare(`SELECT COUNT(*) AS n FROM learning_messages WHERE entry_id='lrn_x'`).get() as {
			n: number;
		};
		expect(msgCount.n).toBe(0);
	});

	it("creates the status+updated_at index", () => {
		const row = db
			.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_learning_entries_status_updated'")
			.get();
		expect(row).toBeDefined();
	});

	it("creates the fingerprint index", () => {
		const row = db
			.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_learning_entries_fingerprint'")
			.get();
		expect(row).toBeDefined();
	});

	it("enforces NOT NULL on required columns", () => {
		expect(() =>
			db
				.prepare(
					`INSERT INTO learning_entries (id, status, source_type, source_agents, agent_prompts, summary_json, diff_stats, diff_blob_path, created_at, updated_at)
			 VALUES ('lrn_y','active','agent','[]','[]','{}','{}','/tmp/y.diff', 1, 1)`,
				)
				.run(),
		).toThrow(/NOT NULL/i); // title is missing
	});

	it("allows memory_flushed_at to default to NULL", () => {
		db.prepare(`INSERT INTO learning_entries
			(id, title, status, source_type, source_agents, agent_prompts, summary_json, diff_stats, diff_blob_path, created_at, updated_at)
			VALUES ('lrn_z','t','active','agent','[]','[]','{}','{}','/tmp/z.diff', 1, 1)`).run();
		const row = db.prepare(`SELECT memory_flushed_at FROM learning_entries WHERE id='lrn_z'`).get() as {
			memory_flushed_at: number | null;
		};
		expect(row.memory_flushed_at).toBeNull();
	});
});

function makeInput(overrides: Partial<CreateLearningEntryInput> = {}): CreateLearningEntryInput {
	return {
		title: "Test entry",
		sourceType: "agent",
		sourceAgents: [
			{ sessionId: "s1", sessionName: "cliclaw-a", baseRef: "deadbeef", endRef: "cafef00d", cwd: "/tmp/repo" },
		],
		agentPrompts: ["do the thing"],
		summaryJson: {
			title: "Test entry",
			what_changed: "",
			why: "",
			key_files: [],
			design_points: [],
			learning_hooks: [],
		},
		diffStats: { filesChanged: 1, additions: 5, deletions: 2, filesList: [{ path: "src/a.ts", status: "modified" }] },
		rawDiff: "diff --git a/src/a.ts b/src/a.ts\n...",
		...overrides,
	};
}

describe("LearningStore entries", () => {
	let tmpDir: string;
	let db: Database.Database;
	let store: LearningStore;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "cliclaw-learning-store-"));
		db = new Database(join(tmpDir, "test.sqlite"));
		db.pragma("journal_mode = WAL");
		db.pragma("foreign_keys = ON");
		new ConversationStore(db);
		store = new LearningStore(db, join(tmpDir, "diffs"));
	});

	afterEach(async () => {
		db.close();
		await rm(tmpDir, { recursive: true, force: true });
	});

	it("creates an entry and writes diff blob", async () => {
		const input = makeInput();
		const entry = await store.create(input);
		expect(entry.id).toMatch(/^lrn_/);
		expect(entry.status).toBe("active");
		expect(entry.diffBlobPath).toContain(entry.id);
		const loaded = await store.loadEntry(entry.id);
		expect(loaded?.title).toBe("Test entry");
	});

	it("reads back the raw diff via readDiffBlob", async () => {
		const entry = await store.create(makeInput({ rawDiff: "XYZ-DIFF-CONTENT" }));
		const content = await store.readDiffBlob(entry.id);
		expect(content).toBe("XYZ-DIFF-CONTENT");
	});

	it("list() orders by updated_at DESC and filters by status", async () => {
		const a = await store.create(makeInput({ title: "A" }));
		await new Promise((r) => setTimeout(r, 5));
		const b = await store.create(makeInput({ title: "B" }));
		await store.setStatus(a.id, "archived");
		const active = await store.list({ status: "active" });
		expect(active.map((e) => e.id)).toEqual([b.id]);
		const archived = await store.list({ status: "archived" });
		expect(archived.map((e) => e.id)).toEqual([a.id]);
	});

	it("updateTitle and markMemoryFlushed bump updated_at", async () => {
		const entry = await store.create(makeInput());
		const before = entry.updatedAt;
		await new Promise((r) => setTimeout(r, 5));
		await store.updateTitle(entry.id, "New title");
		const loaded = await store.loadEntry(entry.id);
		expect(loaded?.title).toBe("New title");
		expect(loaded!.updatedAt).toBeGreaterThan(before);
	});

	it("replaceSummary overwrites summary_json only", async () => {
		const entry = await store.create(makeInput());
		const next: SummaryJson = {
			title: "X",
			what_changed: "changed",
			why: "w",
			key_files: [],
			design_points: [],
			learning_hooks: [],
		};
		await store.replaceSummary(entry.id, next);
		const loaded = await store.loadEntry(entry.id);
		expect(loaded?.summaryJson.what_changed).toBe("changed");
	});

	it("delete() removes entry, cascades messages, removes diff blob file", async () => {
		const entry = await store.create(makeInput());
		await store.appendMessage(entry.id, "user", "hi");
		const blobPath = entry.diffBlobPath;
		await store.delete(entry.id);
		expect(await store.loadEntry(entry.id)).toBeNull();
		const msgs = await store.loadMessages(entry.id);
		expect(msgs).toEqual([]);
		const fsCheck = await import("node:fs/promises");
		await expect(fsCheck.access(blobPath)).rejects.toThrow();
	});

	it("appendMessage bumps entry updated_at", async () => {
		const entry = await store.create(makeInput());
		const before = entry.updatedAt;
		await new Promise((r) => setTimeout(r, 5));
		await store.appendMessage(entry.id, "user", "q");
		const loaded = await store.loadEntry(entry.id);
		expect(loaded!.updatedAt).toBeGreaterThan(before);
	});

	it("findByFingerprint returns id for matching active entry", async () => {
		const fp = computeDiffFingerprint("/tmp/repo", "diff content");
		await store.create(makeInput({ rawDiff: "diff content", diffFingerprint: fp } as any));
		expect(store.findByFingerprint(fp)).not.toBeNull();
	});

	it("findByFingerprint returns null when no match", async () => {
		expect(store.findByFingerprint("nonexistent")).toBeNull();
	});

	it("findByFingerprint ignores deleted entries", async () => {
		const fp = computeDiffFingerprint("/tmp/repo", "diff");
		const entry = await store.create(makeInput({ rawDiff: "diff", diffFingerprint: fp } as any));
		await store.delete(entry.id);
		expect(store.findByFingerprint(fp)).toBeNull();
	});
});

describe("computeDiffFingerprint", () => {
	it("produces same hash for identical cwd+diff", () => {
		const a = computeDiffFingerprint("/tmp/repo", "diff --git a/x\n+line\n");
		const b = computeDiffFingerprint("/tmp/repo", "diff --git a/x\n+line\n");
		expect(a).toBe(b);
	});

	it("produces different hash for different cwd", () => {
		const a = computeDiffFingerprint("/tmp/repo-a", "diff\n");
		const b = computeDiffFingerprint("/tmp/repo-b", "diff\n");
		expect(a).not.toBe(b);
	});

	it("produces different hash for different diff", () => {
		const a = computeDiffFingerprint("/tmp/repo", "diff-a\n");
		const b = computeDiffFingerprint("/tmp/repo", "diff-b\n");
		expect(a).not.toBe(b);
	});

	it("normalizes trailing whitespace", () => {
		const a = computeDiffFingerprint("/tmp/repo", "line   \nanother  \n");
		const b = computeDiffFingerprint("/tmp/repo", "line\nanother\n");
		expect(a).toBe(b);
	});

	it("normalizes trailing newlines", () => {
		const a = computeDiffFingerprint("/tmp/repo", "line\n\n\n\n");
		const b = computeDiffFingerprint("/tmp/repo", "line\n");
		expect(a).toBe(b);
	});
});
