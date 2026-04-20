import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
		const row = db
			.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='learning_entries'")
			.get();
		expect(row).toBeDefined();
	});

	it("creates learning_messages table with cascade delete", () => {
		const row = db
			.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='learning_messages'")
			.get();
		expect(row).toBeDefined();

		db.prepare(`INSERT INTO learning_entries
			(id, title, status, source_type, source_agents, agent_prompts, summary_json, diff_stats, diff_blob_path, created_at, updated_at)
			VALUES ('lrn_x','t','active','agent','[]','[]','{}','{}','/tmp/x.diff', 1, 1)`).run();
		db.prepare(`INSERT INTO learning_messages (entry_id, role, content, created_at) VALUES ('lrn_x','user','hi', 1)`).run();
		db.prepare(`DELETE FROM learning_entries WHERE id='lrn_x'`).run();
		const msgCount = db
			.prepare(`SELECT COUNT(*) AS n FROM learning_messages WHERE entry_id='lrn_x'`)
			.get() as { n: number };
		expect(msgCount.n).toBe(0);
	});

	it("creates the status+updated_at index", () => {
		const row = db
			.prepare(
				"SELECT name FROM sqlite_master WHERE type='index' AND name='idx_learning_entries_status_updated'",
			)
			.get();
		expect(row).toBeDefined();
	});
});
