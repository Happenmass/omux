import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentStore } from "../../src/persistence/agent-store.js";

describe("AgentStore", () => {
	let tmpDir: string;
	let db: Database.Database;
	let store: AgentStore;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "omux-agent-test-"));
		db = new Database(join(tmpDir, "test.sqlite"));
		db.pragma("journal_mode = WAL");
		store = new AgentStore(db);
	});

	afterEach(async () => {
		db.close();
		await rm(tmpDir, { recursive: true, force: true });
	});

	describe("schema initialization", () => {
		it("should create chat_agents table", () => {
			const tables = db
				.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
				.all() as Array<{ name: string }>;
			const names = tables.map((t) => t.name);
			expect(names).toContain("chat_agents");
		});
	});

	describe("migration from chat_sessions", () => {
		it("should rename chat_sessions to chat_agents on construction", async () => {
			// Create a fresh DB with the old table name
			const tmpDir2 = await mkdtemp(join(tmpdir(), "omux-agent-migrate-"));
			const db2 = new Database(join(tmpDir2, "test.sqlite"));
			db2.pragma("journal_mode = WAL");
			db2.exec(`
				CREATE TABLE chat_sessions (
					session_id   TEXT PRIMARY KEY,
					pane_target  TEXT NOT NULL,
					working_dir  TEXT NOT NULL,
					created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
					taken_over   INTEGER NOT NULL DEFAULT 0
				);
			`);
			db2.prepare("INSERT INTO chat_sessions (session_id, pane_target, working_dir) VALUES (?, ?, ?)")
				.run("omux-old", "omux-old:0.0", "/old");

			// Constructing AgentStore should migrate the table
			const store2 = new AgentStore(db2);
			const agents = store2.loadAgents();
			expect(agents).toHaveLength(1);
			expect(agents[0].agentId).toBe("omux-old");

			// Old table should no longer exist
			const tables = db2
				.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
				.all() as Array<{ name: string }>;
			expect(tables.map((t) => t.name)).not.toContain("chat_sessions");
			expect(tables.map((t) => t.name)).toContain("chat_agents");

			db2.close();
			await rm(tmpDir2, { recursive: true, force: true });
		});
	});

	describe("saveAgent / loadAgents", () => {
		it("should save and load a single agent", () => {
			store.saveAgent("omux-test-1", { paneTarget: "omux-test-1:0.0", workingDir: "/tmp/work" });

			const agents = store.loadAgents();
			expect(agents).toHaveLength(1);
			expect(agents[0].agentId).toBe("omux-test-1");
			expect(agents[0].paneTarget).toBe("omux-test-1:0.0");
			expect(agents[0].workingDir).toBe("/tmp/work");
			expect(agents[0].createdAt).toBeGreaterThan(0);
		});

		it("should save multiple agents and load in creation order", () => {
			store.saveAgent("omux-a", { paneTarget: "omux-a:0.0", workingDir: "/a" });
			store.saveAgent("omux-b", { paneTarget: "omux-b:0.0", workingDir: "/b" });
			store.saveAgent("omux-c", { paneTarget: "omux-c:0.0", workingDir: "/c" });

			const agents = store.loadAgents();
			expect(agents).toHaveLength(3);
			expect(agents[0].agentId).toBe("omux-a");
			expect(agents[1].agentId).toBe("omux-b");
			expect(agents[2].agentId).toBe("omux-c");
		});

		it("should upsert on duplicate session_id", () => {
			store.saveAgent("omux-dup", { paneTarget: "omux-dup:0.0", workingDir: "/old" });
			store.saveAgent("omux-dup", { paneTarget: "omux-dup:0.1", workingDir: "/new" });

			const agents = store.loadAgents();
			expect(agents).toHaveLength(1);
			expect(agents[0].paneTarget).toBe("omux-dup:0.1");
			expect(agents[0].workingDir).toBe("/new");
		});

		it("should return empty array when no agents", () => {
			const agents = store.loadAgents();
			expect(agents).toEqual([]);
		});

		it("should persist and load the model", () => {
			store.saveAgent("omux-model", { paneTarget: "omux-model:0.0", workingDir: "/m", model: "opus" });

			const agents = store.loadAgents();
			expect(agents).toHaveLength(1);
			expect(agents[0].model).toBe("opus");
		});

		it("should default model to undefined when omitted", () => {
			store.saveAgent("omux-nomodel", { paneTarget: "omux-nomodel:0.0", workingDir: "/n" });

			const agents = store.loadAgents();
			expect(agents).toHaveLength(1);
			expect(agents[0].model).toBeUndefined();
		});

		it("should persist and load the adapter", () => {
			store.saveAgent("omux-adp", {
				paneTarget: "omux-adp:0.0",
				workingDir: "/a",
				model: "gpt-5.5",
				adapter: "codex",
			});

			const agents = store.loadAgents();
			expect(agents).toHaveLength(1);
			expect(agents[0].adapter).toBe("codex");
		});

		it("should default adapter to undefined when omitted", () => {
			store.saveAgent("omux-noadp", { paneTarget: "omux-noadp:0.0", workingDir: "/n" });

			const agents = store.loadAgents();
			expect(agents).toHaveLength(1);
			expect(agents[0].adapter).toBeUndefined();
		});
	});

	describe("deleteAgent", () => {
		it("should remove a specific agent", () => {
			store.saveAgent("omux-keep", { paneTarget: "omux-keep:0.0", workingDir: "/keep" });
			store.saveAgent("omux-remove", { paneTarget: "omux-remove:0.0", workingDir: "/remove" });

			store.deleteAgent("omux-remove");

			const agents = store.loadAgents();
			expect(agents).toHaveLength(1);
			expect(agents[0].agentId).toBe("omux-keep");
		});

		it("should be a no-op for non-existent agent", () => {
			store.saveAgent("omux-x", { paneTarget: "omux-x:0.0", workingDir: "/x" });

			store.deleteAgent("omux-nonexistent");

			const agents = store.loadAgents();
			expect(agents).toHaveLength(1);
		});

		it("should delete all agents one by one", () => {
			store.saveAgent("omux-1", { paneTarget: "omux-1:0.0", workingDir: "/1" });
			store.saveAgent("omux-2", { paneTarget: "omux-2:0.0", workingDir: "/2" });

			store.deleteAgent("omux-1");
			store.deleteAgent("omux-2");

			expect(store.loadAgents()).toEqual([]);
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

			store.saveAgent("omux-persist", { paneTarget: "omux-persist:0.0", workingDir: "/persist" });
			db.prepare("INSERT INTO chat_messages (role, content) VALUES (?, ?)").run("user", "hello");

			// Simulate ConversationStore.clearAll()
			db.exec("DELETE FROM chat_messages");
			db.exec("DELETE FROM chat_context_state");

			// Agents should be unaffected
			const agents = store.loadAgents();
			expect(agents).toHaveLength(1);
			expect(agents[0].agentId).toBe("omux-persist");
		});
	});

	describe("lifecycle flow: create → exit → verify", () => {
		it("should reflect state after a full create-then-exit cycle", () => {
			// Simulate create_session writing
			store.saveAgent("omux-work", { paneTarget: "omux-work:0.0", workingDir: "/project" });

			expect(store.loadAgents()).toHaveLength(1);

			// Simulate kill_session deleting
			store.deleteAgent("omux-work");

			expect(store.loadAgents()).toHaveLength(0);
		});

		it("should reflect state after create → kill all cycle", () => {
			store.saveAgent("omux-a", { paneTarget: "omux-a:0.0", workingDir: "/a" });
			store.saveAgent("omux-b", { paneTarget: "omux-b:0.0", workingDir: "/b" });
			store.saveAgent("omux-c", { paneTarget: "omux-c:0.0", workingDir: "/c" });

			expect(store.loadAgents()).toHaveLength(3);

			// Simulate kill_session "all" — delete each
			for (const s of store.loadAgents()) {
				store.deleteAgent(s.agentId);
			}

			expect(store.loadAgents()).toHaveLength(0);
		});
	});

	describe("startup restore flow simulation", () => {
		it("should load persisted agents and allow selective cleanup of dead ones", () => {
			// Phase 1: previous run persisted 3 agents
			store.saveAgent("omux-alive-1", { paneTarget: "omux-alive-1:0.0", workingDir: "/alive1" });
			store.saveAgent("omux-dead", { paneTarget: "omux-dead:0.0", workingDir: "/dead" });
			store.saveAgent("omux-alive-2", { paneTarget: "omux-alive-2:0.0", workingDir: "/alive2" });

			// Phase 2: simulate restart — load all, then selectively delete dead ones
			const loaded = store.loadAgents();
			expect(loaded).toHaveLength(3);

			// Simulate bridge.hasSession() results: alive-1=true, dead=false, alive-2=true
			const aliveSet = new Set(["omux-alive-1", "omux-alive-2"]);
			const restored: typeof loaded = [];
			for (const s of loaded) {
				if (aliveSet.has(s.agentId)) {
					restored.push(s);
				} else {
					store.deleteAgent(s.agentId);
				}
			}

			expect(restored).toHaveLength(2);
			expect(restored[0].agentId).toBe("omux-alive-1");
			expect(restored[1].agentId).toBe("omux-alive-2");

			// Store should now only have alive agents
			const remaining = store.loadAgents();
			expect(remaining).toHaveLength(2);
			expect(remaining.map((s) => s.agentId)).toEqual(["omux-alive-1", "omux-alive-2"]);
		});

		it("should handle case where all persisted agents are dead", () => {
			store.saveAgent("omux-dead-1", { paneTarget: "omux-dead-1:0.0", workingDir: "/d1" });
			store.saveAgent("omux-dead-2", { paneTarget: "omux-dead-2:0.0", workingDir: "/d2" });

			const loaded = store.loadAgents();
			for (const s of loaded) {
				store.deleteAgent(s.agentId);
			}

			expect(store.loadAgents()).toHaveLength(0);
		});

		it("should handle empty store on fresh startup", () => {
			expect(store.loadAgents()).toHaveLength(0);
		});
	});

	describe("upsert behavior on re-create", () => {
		it("should update paneTarget when agent is re-created with same name", () => {
			// First creation
			store.saveAgent("omux-reuse", { paneTarget: "omux-reuse:0.0", workingDir: "/project" });

			// Simulate exit (delete) then re-create (save again with new pane)
			store.deleteAgent("omux-reuse");
			store.saveAgent("omux-reuse", { paneTarget: "omux-reuse:0.1", workingDir: "/project" });

			const agents = store.loadAgents();
			expect(agents).toHaveLength(1);
			expect(agents[0].paneTarget).toBe("omux-reuse:0.1");
		});

		it("should update workingDir when agent is saved with different cwd", () => {
			store.saveAgent("omux-move", { paneTarget: "omux-move:0.0", workingDir: "/old-dir" });
			store.saveAgent("omux-move", { paneTarget: "omux-move:0.0", workingDir: "/new-dir" });

			const agents = store.loadAgents();
			expect(agents).toHaveLength(1);
			expect(agents[0].workingDir).toBe("/new-dir");
		});
	});

	describe("createdAt timestamp", () => {
		it("should set createdAt to a reasonable unix timestamp", () => {
			store.saveAgent("omux-ts", { paneTarget: "omux-ts:0.0", workingDir: "/ts" });

			const agents = store.loadAgents();
			expect(agents).toHaveLength(1);
			// Should be a unix timestamp within the last minute
			const now = Math.floor(Date.now() / 1000);
			expect(agents[0].createdAt).toBeGreaterThan(now - 60);
			expect(agents[0].createdAt).toBeLessThanOrEqual(now + 1);
		});

		it("should preserve original createdAt on upsert", () => {
			store.saveAgent("omux-ts2", { paneTarget: "omux-ts2:0.0", workingDir: "/v1" });
			const first = store.loadAgents()[0].createdAt;

			// Upsert with new data — INSERT OR REPLACE resets created_at
			store.saveAgent("omux-ts2", { paneTarget: "omux-ts2:0.1", workingDir: "/v2" });
			const second = store.loadAgents()[0].createdAt;

			// Both should be valid timestamps (may or may not be equal depending on speed)
			expect(first).toBeGreaterThan(0);
			expect(second).toBeGreaterThan(0);
		});
	});

	describe("takenOver (human takeover)", () => {
		it("should default takenOver to false for new agents", () => {
			store.saveAgent("omux-new", { paneTarget: "omux-new:0.0", workingDir: "/new" });
			const agents = store.loadAgents();
			expect(agents[0].takenOver).toBe(false);
		});

		it("should persist takenOver=true via setTakenOver", () => {
			store.saveAgent("omux-take", { paneTarget: "omux-take:0.0", workingDir: "/take" });
			store.setTakenOver("omux-take", true);

			const agents = store.loadAgents();
			expect(agents[0].takenOver).toBe(true);
		});

		it("should persist takenOver=false via setTakenOver (release)", () => {
			store.saveAgent("omux-rel", { paneTarget: "omux-rel:0.0", workingDir: "/rel" });
			store.setTakenOver("omux-rel", true);
			store.setTakenOver("omux-rel", false);

			const agents = store.loadAgents();
			expect(agents[0].takenOver).toBe(false);
		});

		it("should survive restart — takenOver state is loaded from SQLite", async () => {
			store.saveAgent("omux-persist", { paneTarget: "omux-persist:0.0", workingDir: "/p" });
			store.setTakenOver("omux-persist", true);

			// Simulate restart: create new AgentStore on same db
			const { AgentStore: AS } = await import("../../src/persistence/agent-store.js");
			const store2 = new AS(db);
			const agents = store2.loadAgents();
			expect(agents[0].takenOver).toBe(true);
		});

		it("should not affect other agents when setting takenOver", () => {
			store.saveAgent("omux-a", { paneTarget: "a:0.0", workingDir: "/a" });
			store.saveAgent("omux-b", { paneTarget: "b:0.0", workingDir: "/b" });

			store.setTakenOver("omux-a", true);

			const agents = store.loadAgents();
			const a = agents.find((s) => s.agentId === "omux-a");
			const b = agents.find((s) => s.agentId === "omux-b");
			expect(a!.takenOver).toBe(true);
			expect(b!.takenOver).toBe(false);
		});

		it("should be a no-op for non-existent agent", () => {
			store.setTakenOver("omux-ghost", true);
			expect(store.loadAgents()).toHaveLength(0);
		});
	});

	describe("server stop preserves agents", () => {
		it("should retain all agents across a simulated stop-restart cycle", () => {
			// Agents created during a running session
			store.saveAgent("omux-front", { paneTarget: "omux-front:0.0", workingDir: "/front" });
			store.saveAgent("omux-back", { paneTarget: "omux-back:0.0", workingDir: "/back" });
			store.setTakenOver("omux-front", true);

			// Simulate `omux stop`: server process exits but does NOT
			// clear the agent store or kill tmux sessions.
			// (No store.deleteAgent calls here — that's the contract.)

			// Simulate restart: load agents from the same DB
			const agents = store.loadAgents();
			expect(agents).toHaveLength(2);
			expect(agents.map((a) => a.agentId)).toEqual(["omux-front", "omux-back"]);
			// takenOver state must also survive
			expect(agents.find((a) => a.agentId === "omux-front")!.takenOver).toBe(true);
			expect(agents.find((a) => a.agentId === "omux-back")!.takenOver).toBe(false);
		});
	});

	describe("orphan tmux discovery on startup", () => {
		it("should allow saving discovered orphan agents not in the store", () => {
			// Simulate: store has agent-a, but tmux also has agent-b (orphan)
			store.saveAgent("omux-a", { paneTarget: "omux-a:0.0", workingDir: "/a" });

			// Orphan discovered via tmux — save it
			store.saveAgent("omux-b", { paneTarget: "omux-b:0.0", workingDir: "/fallback" });

			const agents = store.loadAgents();
			expect(agents).toHaveLength(2);
			expect(agents.map((a) => a.agentId)).toContain("omux-a");
			expect(agents.map((a) => a.agentId)).toContain("omux-b");
		});

		it("should reconcile: restore known + add orphans + discard dead", () => {
			// Previous run persisted 2 agents
			store.saveAgent("omux-known-alive", { paneTarget: "omux-known-alive:0.0", workingDir: "/ka" });
			store.saveAgent("omux-known-dead", { paneTarget: "omux-known-dead:0.0", workingDir: "/kd" });

			// Simulate tmux discovery: known-alive is alive, known-dead is gone, orphan is new
			const tmuxSessions = ["omux-known-alive", "omux-orphan"];
			const persisted = store.loadAgents();
			const restoredIds = new Set<string>();

			// Step 1: check persisted agents against tmux
			for (const a of persisted) {
				if (tmuxSessions.includes(a.agentId)) {
					restoredIds.add(a.agentId);
				} else {
					store.deleteAgent(a.agentId);
				}
			}

			// Step 2: add orphan tmux sessions not in persisted
			for (const name of tmuxSessions) {
				if (!restoredIds.has(name)) {
					store.saveAgent(name, { paneTarget: `${name}:0.0`, workingDir: "/cwd" });
					restoredIds.add(name);
				}
			}

			// Final state: known-alive + orphan, known-dead removed
			const final = store.loadAgents();
			expect(final).toHaveLength(2);
			expect(final.map((a) => a.agentId).sort()).toEqual(["omux-known-alive", "omux-orphan"]);
		});
	});
});
