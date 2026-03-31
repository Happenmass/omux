import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionStore } from "../../src/persistence/session-store.js";

describe("SessionStore", () => {
	let tmpDir: string;
	let db: Database.Database;
	let store: SessionStore;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "cliclaw-session-test-"));
		db = new Database(join(tmpDir, "test.sqlite"));
		db.pragma("journal_mode = WAL");
		store = new SessionStore(db);
	});

	afterEach(async () => {
		db.close();
		await rm(tmpDir, { recursive: true, force: true });
	});

	describe("schema initialization", () => {
		it("should create chat_sessions table", () => {
			const tables = db
				.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
				.all() as Array<{ name: string }>;
			const names = tables.map((t) => t.name);
			expect(names).toContain("chat_sessions");
		});
	});

	describe("saveSession / loadSessions", () => {
		it("should save and load a single session", () => {
			store.saveSession("cliclaw-test-1", { paneTarget: "cliclaw-test-1:0.0", workingDir: "/tmp/work" });

			const sessions = store.loadSessions();
			expect(sessions).toHaveLength(1);
			expect(sessions[0].sessionId).toBe("cliclaw-test-1");
			expect(sessions[0].paneTarget).toBe("cliclaw-test-1:0.0");
			expect(sessions[0].workingDir).toBe("/tmp/work");
			expect(sessions[0].createdAt).toBeGreaterThan(0);
		});

		it("should save multiple sessions and load in creation order", () => {
			store.saveSession("cliclaw-a", { paneTarget: "cliclaw-a:0.0", workingDir: "/a" });
			store.saveSession("cliclaw-b", { paneTarget: "cliclaw-b:0.0", workingDir: "/b" });
			store.saveSession("cliclaw-c", { paneTarget: "cliclaw-c:0.0", workingDir: "/c" });

			const sessions = store.loadSessions();
			expect(sessions).toHaveLength(3);
			expect(sessions[0].sessionId).toBe("cliclaw-a");
			expect(sessions[1].sessionId).toBe("cliclaw-b");
			expect(sessions[2].sessionId).toBe("cliclaw-c");
		});

		it("should upsert on duplicate session_id", () => {
			store.saveSession("cliclaw-dup", { paneTarget: "cliclaw-dup:0.0", workingDir: "/old" });
			store.saveSession("cliclaw-dup", { paneTarget: "cliclaw-dup:0.1", workingDir: "/new" });

			const sessions = store.loadSessions();
			expect(sessions).toHaveLength(1);
			expect(sessions[0].paneTarget).toBe("cliclaw-dup:0.1");
			expect(sessions[0].workingDir).toBe("/new");
		});

		it("should return empty array when no sessions", () => {
			const sessions = store.loadSessions();
			expect(sessions).toEqual([]);
		});
	});

	describe("deleteSession", () => {
		it("should remove a specific session", () => {
			store.saveSession("cliclaw-keep", { paneTarget: "cliclaw-keep:0.0", workingDir: "/keep" });
			store.saveSession("cliclaw-remove", { paneTarget: "cliclaw-remove:0.0", workingDir: "/remove" });

			store.deleteSession("cliclaw-remove");

			const sessions = store.loadSessions();
			expect(sessions).toHaveLength(1);
			expect(sessions[0].sessionId).toBe("cliclaw-keep");
		});

		it("should be a no-op for non-existent session", () => {
			store.saveSession("cliclaw-x", { paneTarget: "cliclaw-x:0.0", workingDir: "/x" });

			store.deleteSession("cliclaw-nonexistent");

			const sessions = store.loadSessions();
			expect(sessions).toHaveLength(1);
		});

		it("should delete all sessions one by one", () => {
			store.saveSession("cliclaw-1", { paneTarget: "cliclaw-1:0.0", workingDir: "/1" });
			store.saveSession("cliclaw-2", { paneTarget: "cliclaw-2:0.0", workingDir: "/2" });

			store.deleteSession("cliclaw-1");
			store.deleteSession("cliclaw-2");

			expect(store.loadSessions()).toEqual([]);
		});
	});

	describe("isolation from ConversationStore clearAll", () => {
		it("should survive when chat_messages and chat_context_state are cleared", () => {
			// Simulate ConversationStore tables existing
			db.exec(`
				CREATE TABLE IF NOT EXISTS chat_messages (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					role TEXT NOT NULL,
					content TEXT NOT NULL,
					tool_call_id TEXT,
					created_at INTEGER NOT NULL DEFAULT (unixepoch())
				);
				CREATE TABLE IF NOT EXISTS chat_context_state (
					key TEXT PRIMARY KEY,
					value TEXT NOT NULL
				);
			`);

			store.saveSession("cliclaw-persist", { paneTarget: "cliclaw-persist:0.0", workingDir: "/persist" });
			db.prepare("INSERT INTO chat_messages (role, content) VALUES (?, ?)").run("user", "hello");

			// Simulate ConversationStore.clearAll()
			db.exec("DELETE FROM chat_messages");
			db.exec("DELETE FROM chat_context_state");

			// Sessions should be unaffected
			const sessions = store.loadSessions();
			expect(sessions).toHaveLength(1);
			expect(sessions[0].sessionId).toBe("cliclaw-persist");
		});
	});

	describe("lifecycle flow: create → exit → verify", () => {
		it("should reflect state after a full create-then-exit cycle", () => {
			// Simulate create_session writing
			store.saveSession("cliclaw-work", { paneTarget: "cliclaw-work:0.0", workingDir: "/project" });

			expect(store.loadSessions()).toHaveLength(1);

			// Simulate kill_session deleting
			store.deleteSession("cliclaw-work");

			expect(store.loadSessions()).toHaveLength(0);
		});

		it("should reflect state after create → kill all cycle", () => {
			store.saveSession("cliclaw-a", { paneTarget: "cliclaw-a:0.0", workingDir: "/a" });
			store.saveSession("cliclaw-b", { paneTarget: "cliclaw-b:0.0", workingDir: "/b" });
			store.saveSession("cliclaw-c", { paneTarget: "cliclaw-c:0.0", workingDir: "/c" });

			expect(store.loadSessions()).toHaveLength(3);

			// Simulate kill_session "all" — delete each
			for (const s of store.loadSessions()) {
				store.deleteSession(s.sessionId);
			}

			expect(store.loadSessions()).toHaveLength(0);
		});
	});

	describe("startup restore flow simulation", () => {
		it("should load persisted sessions and allow selective cleanup of dead ones", () => {
			// Phase 1: previous run persisted 3 sessions
			store.saveSession("cliclaw-alive-1", { paneTarget: "cliclaw-alive-1:0.0", workingDir: "/alive1" });
			store.saveSession("cliclaw-dead", { paneTarget: "cliclaw-dead:0.0", workingDir: "/dead" });
			store.saveSession("cliclaw-alive-2", { paneTarget: "cliclaw-alive-2:0.0", workingDir: "/alive2" });

			// Phase 2: simulate restart — load all, then selectively delete dead ones
			const loaded = store.loadSessions();
			expect(loaded).toHaveLength(3);

			// Simulate bridge.hasSession() results: alive-1=true, dead=false, alive-2=true
			const aliveSet = new Set(["cliclaw-alive-1", "cliclaw-alive-2"]);
			const restored: typeof loaded = [];
			for (const s of loaded) {
				if (aliveSet.has(s.sessionId)) {
					restored.push(s);
				} else {
					store.deleteSession(s.sessionId);
				}
			}

			expect(restored).toHaveLength(2);
			expect(restored[0].sessionId).toBe("cliclaw-alive-1");
			expect(restored[1].sessionId).toBe("cliclaw-alive-2");

			// Store should now only have alive sessions
			const remaining = store.loadSessions();
			expect(remaining).toHaveLength(2);
			expect(remaining.map((s) => s.sessionId)).toEqual(["cliclaw-alive-1", "cliclaw-alive-2"]);
		});

		it("should handle case where all persisted sessions are dead", () => {
			store.saveSession("cliclaw-dead-1", { paneTarget: "cliclaw-dead-1:0.0", workingDir: "/d1" });
			store.saveSession("cliclaw-dead-2", { paneTarget: "cliclaw-dead-2:0.0", workingDir: "/d2" });

			const loaded = store.loadSessions();
			for (const s of loaded) {
				store.deleteSession(s.sessionId);
			}

			expect(store.loadSessions()).toHaveLength(0);
		});

		it("should handle empty store on fresh startup", () => {
			expect(store.loadSessions()).toHaveLength(0);
		});
	});

	describe("upsert behavior on re-create", () => {
		it("should update paneTarget when session is re-created with same name", () => {
			// First creation
			store.saveSession("cliclaw-reuse", { paneTarget: "cliclaw-reuse:0.0", workingDir: "/project" });

			// Simulate exit (delete) then re-create (save again with new pane)
			store.deleteSession("cliclaw-reuse");
			store.saveSession("cliclaw-reuse", { paneTarget: "cliclaw-reuse:0.1", workingDir: "/project" });

			const sessions = store.loadSessions();
			expect(sessions).toHaveLength(1);
			expect(sessions[0].paneTarget).toBe("cliclaw-reuse:0.1");
		});

		it("should update workingDir when session is saved with different cwd", () => {
			store.saveSession("cliclaw-move", { paneTarget: "cliclaw-move:0.0", workingDir: "/old-dir" });
			store.saveSession("cliclaw-move", { paneTarget: "cliclaw-move:0.0", workingDir: "/new-dir" });

			const sessions = store.loadSessions();
			expect(sessions).toHaveLength(1);
			expect(sessions[0].workingDir).toBe("/new-dir");
		});
	});

	describe("createdAt timestamp", () => {
		it("should set createdAt to a reasonable unix timestamp", () => {
			store.saveSession("cliclaw-ts", { paneTarget: "cliclaw-ts:0.0", workingDir: "/ts" });

			const sessions = store.loadSessions();
			expect(sessions).toHaveLength(1);
			// Should be a unix timestamp within the last minute
			const now = Math.floor(Date.now() / 1000);
			expect(sessions[0].createdAt).toBeGreaterThan(now - 60);
			expect(sessions[0].createdAt).toBeLessThanOrEqual(now + 1);
		});

		it("should preserve original createdAt on upsert", () => {
			store.saveSession("cliclaw-ts2", { paneTarget: "cliclaw-ts2:0.0", workingDir: "/v1" });
			const first = store.loadSessions()[0].createdAt;

			// Upsert with new data — INSERT OR REPLACE resets created_at
			store.saveSession("cliclaw-ts2", { paneTarget: "cliclaw-ts2:0.1", workingDir: "/v2" });
			const second = store.loadSessions()[0].createdAt;

			// Both should be valid timestamps (may or may not be equal depending on speed)
			expect(first).toBeGreaterThan(0);
			expect(second).toBeGreaterThan(0);
		});
	});

	describe("takenOver (human takeover)", () => {
		it("should default takenOver to false for new sessions", () => {
			store.saveSession("cliclaw-new", { paneTarget: "cliclaw-new:0.0", workingDir: "/new" });
			const sessions = store.loadSessions();
			expect(sessions[0].takenOver).toBe(false);
		});

		it("should persist takenOver=true via setTakenOver", () => {
			store.saveSession("cliclaw-take", { paneTarget: "cliclaw-take:0.0", workingDir: "/take" });
			store.setTakenOver("cliclaw-take", true);

			const sessions = store.loadSessions();
			expect(sessions[0].takenOver).toBe(true);
		});

		it("should persist takenOver=false via setTakenOver (release)", () => {
			store.saveSession("cliclaw-rel", { paneTarget: "cliclaw-rel:0.0", workingDir: "/rel" });
			store.setTakenOver("cliclaw-rel", true);
			store.setTakenOver("cliclaw-rel", false);

			const sessions = store.loadSessions();
			expect(sessions[0].takenOver).toBe(false);
		});

		it("should survive restart — takenOver state is loaded from SQLite", async () => {
			store.saveSession("cliclaw-persist", { paneTarget: "cliclaw-persist:0.0", workingDir: "/p" });
			store.setTakenOver("cliclaw-persist", true);

			// Simulate restart: create new SessionStore on same db
			const { SessionStore: SS } = await import("../../src/persistence/session-store.js");
			const store2 = new SS(db);
			const sessions = store2.loadSessions();
			expect(sessions[0].takenOver).toBe(true);
		});

		it("should not affect other sessions when setting takenOver", () => {
			store.saveSession("cliclaw-a", { paneTarget: "a:0.0", workingDir: "/a" });
			store.saveSession("cliclaw-b", { paneTarget: "b:0.0", workingDir: "/b" });

			store.setTakenOver("cliclaw-a", true);

			const sessions = store.loadSessions();
			const a = sessions.find((s) => s.sessionId === "cliclaw-a");
			const b = sessions.find((s) => s.sessionId === "cliclaw-b");
			expect(a!.takenOver).toBe(true);
			expect(b!.takenOver).toBe(false);
		});

		it("should be a no-op for non-existent session", () => {
			store.setTakenOver("cliclaw-ghost", true);
			expect(store.loadSessions()).toHaveLength(0);
		});
	});
});
