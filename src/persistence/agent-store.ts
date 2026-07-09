import type Database from "better-sqlite3";
import { logger } from "../utils/logger.js";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS chat_agents (
	session_id   TEXT PRIMARY KEY,
	pane_target  TEXT NOT NULL,
	working_dir  TEXT NOT NULL,
	created_at   INTEGER NOT NULL DEFAULT (unixepoch())
);
`;

export interface PersistedAgent {
	agentId: string;
	paneTarget: string;
	workingDir: string;
	createdAt: number;
	takenOver: boolean;
	model?: string;
	adapter?: string;
	worktree?: { path: string; branch: string; sourceRepo: string };
}

export class AgentStore {
	private db: Database.Database;

	constructor(db: Database.Database) {
		this.db = db;
		// Migrate: rename chat_sessions → chat_agents if the old table exists
		try {
			this.db.exec("ALTER TABLE chat_sessions RENAME TO chat_agents");
		} catch {
			// Table already renamed or never existed — ignore
		}
		this.db.exec(SCHEMA_SQL);
		// Migrate: add taken_over column if missing (backward-compatible)
		try {
			this.db.exec("ALTER TABLE chat_agents ADD COLUMN taken_over INTEGER NOT NULL DEFAULT 0");
		} catch {
			// Column already exists — ignore
		}
		// Migrate: add model column if missing (backward-compatible)
		try {
			this.db.exec("ALTER TABLE chat_agents ADD COLUMN model TEXT");
		} catch {
			// Column already exists — ignore
		}
		// Migrate: add adapter column if missing (backward-compatible)
		try {
			this.db.exec("ALTER TABLE chat_agents ADD COLUMN adapter TEXT");
		} catch {
			// Column already exists — ignore
		}
		// Migrate: add worktree columns if missing (backward-compatible). Present only
		// for agents launched with `isolation: "worktree"`; NULL for shared-checkout agents.
		for (const col of ["worktree_path", "worktree_branch", "worktree_source"]) {
			try {
				this.db.exec(`ALTER TABLE chat_agents ADD COLUMN ${col} TEXT`);
			} catch {
				// Column already exists — ignore
			}
		}
		logger.info("agent-store", "Table initialized");
	}

	/**
	 * Persist (upsert) an agent entry.
	 */
	saveAgent(
		agentId: string,
		entry: {
			paneTarget: string;
			workingDir: string;
			model?: string;
			adapter?: string;
			worktree?: { path: string; branch: string; sourceRepo: string };
		},
	): void {
		this.db
			.prepare(
				"INSERT OR REPLACE INTO chat_agents (session_id, pane_target, working_dir, model, adapter, worktree_path, worktree_branch, worktree_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				agentId,
				entry.paneTarget,
				entry.workingDir,
				entry.model ?? null,
				entry.adapter ?? null,
				entry.worktree?.path ?? null,
				entry.worktree?.branch ?? null,
				entry.worktree?.sourceRepo ?? null,
			);
	}

	/**
	 * Remove an agent from the store.
	 */
	deleteAgent(agentId: string): void {
		this.db.prepare("DELETE FROM chat_agents WHERE session_id = ?").run(agentId);
	}

	/**
	 * Update the taken_over flag for an agent.
	 */
	setTakenOver(agentId: string, takenOver: boolean): void {
		this.db.prepare("UPDATE chat_agents SET taken_over = ? WHERE session_id = ?").run(takenOver ? 1 : 0, agentId);
	}

	/**
	 * Load all persisted agents ordered by creation time (oldest first).
	 */
	loadAgents(): PersistedAgent[] {
		const rows = this.db
			.prepare(
				"SELECT session_id, pane_target, working_dir, created_at, taken_over, model, adapter, worktree_path, worktree_branch, worktree_source FROM chat_agents ORDER BY created_at ASC",
			)
			.all() as Array<{
			session_id: string;
			pane_target: string;
			working_dir: string;
			created_at: number;
			taken_over: number;
			model: string | null;
			adapter: string | null;
			worktree_path: string | null;
			worktree_branch: string | null;
			worktree_source: string | null;
		}>;

		return rows.map((row) => ({
			agentId: row.session_id,
			paneTarget: row.pane_target,
			workingDir: row.working_dir,
			createdAt: row.created_at,
			takenOver: row.taken_over === 1,
			model: row.model ?? undefined,
			adapter: row.adapter ?? undefined,
			worktree:
				row.worktree_path && row.worktree_branch && row.worktree_source
					? { path: row.worktree_path, branch: row.worktree_branch, sourceRepo: row.worktree_source }
					: undefined,
		}));
	}
}
