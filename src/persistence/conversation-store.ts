import type Database from "better-sqlite3";
import type { LLMMessage } from "../llm/types.js";
import { logger } from "../utils/logger.js";

const SCHEMA_SQL = `
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

CREATE TABLE IF NOT EXISTS learning_entries (
	id TEXT PRIMARY KEY,
	title TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'active',
	source_type TEXT NOT NULL,
	source_agents TEXT NOT NULL,
	agent_prompts TEXT NOT NULL,
	summary_json TEXT NOT NULL,
	diff_stats TEXT NOT NULL,
	diff_blob_path TEXT NOT NULL,
	memory_flushed_at INTEGER,
	diff_fingerprint TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_learning_entries_status_updated
	ON learning_entries(status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_learning_entries_fingerprint
	ON learning_entries(diff_fingerprint, status);

CREATE TABLE IF NOT EXISTS learning_messages (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	entry_id TEXT NOT NULL,
	role TEXT NOT NULL,
	content TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	FOREIGN KEY (entry_id) REFERENCES learning_entries(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_learning_messages_entry
	ON learning_messages(entry_id, id);
`;

export class ConversationStore {
	private db: Database.Database;

	constructor(db: Database.Database) {
		this.db = db;
		this.db.pragma("foreign_keys = ON");
		this.migrate();
		this.db.exec(SCHEMA_SQL);
		logger.info("conversation-store", "Tables initialized");
	}

	/** Backward-compatible migrations for existing databases. Must run before SCHEMA_SQL: the index on diff_fingerprint references a column older DBs lack. */
	private migrate(): void {
		const cols = this.db.pragma("table_info(learning_entries)") as Array<{ name: string }>;
		if (cols.length > 0 && !cols.some((c) => c.name === "diff_fingerprint")) {
			this.db.exec("ALTER TABLE learning_entries ADD COLUMN diff_fingerprint TEXT");
			logger.info("conversation-store", "Migrated: added diff_fingerprint column");
		}
	}

	/**
	 * Save a message to chat_messages.
	 * Content is JSON-serialized when it's MessageContent[].
	 */
	saveMessage(msg: LLMMessage): void {
		const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
		this.db
			.prepare("INSERT INTO chat_messages (role, content, tool_call_id) VALUES (?, ?, ?)")
			.run(msg.role, content, msg.toolCallId ?? null);
	}

	/**
	 * Load all messages from chat_messages in id ascending order.
	 * Deserializes JSON content back to MessageContent[].
	 */
	loadMessages(): LLMMessage[] {
		return this.loadMessagesWithCreatedAt().map(({ createdAt: _createdAt, ...msg }) => msg);
	}

	loadMessagesWithCreatedAt(): Array<LLMMessage & { createdAt: number }> {
		const rows = this.db
			.prepare("SELECT role, content, tool_call_id, created_at FROM chat_messages ORDER BY id ASC")
			.all() as Array<{ role: string; content: string; tool_call_id: string | null; created_at: number }>;

		return rows.map((row) => {
			let content: string | any[];
			try {
				const parsed = JSON.parse(row.content);
				content = Array.isArray(parsed) ? parsed : row.content;
			} catch {
				content = row.content;
			}

			const msg: LLMMessage = {
				role: row.role as LLMMessage["role"],
				content,
			};
			if (row.tool_call_id) {
				msg.toolCallId = row.tool_call_id;
			}
			const createdAt =
				row.created_at > 0 && row.created_at < 1_000_000_000_000 ? row.created_at * 1000 : row.created_at;
			return {
				...msg,
				createdAt,
			};
		});
	}

	/**
	 * Save a key-value pair to chat_context_state (upsert).
	 */
	saveContextState(key: string, value: string): void {
		this.db.prepare("INSERT OR REPLACE INTO chat_context_state (key, value) VALUES (?, ?)").run(key, value);
	}

	/**
	 * Load a value from chat_context_state by key.
	 * Returns undefined if key not found.
	 */
	loadContextState(key: string): string | undefined {
		const row = this.db.prepare("SELECT value FROM chat_context_state WHERE key = ?").get(key) as
			| { value: string }
			| undefined;
		return row?.value;
	}

	/**
	 * Clear all data from both chat_messages and chat_context_state.
	 */
	clearAll(): void {
		this.db.exec("DELETE FROM chat_messages");
		this.db.exec("DELETE FROM chat_context_state");
		logger.info("conversation-store", "All conversation data cleared");
	}

	/**
	 * Get message count for diagnostics.
	 */
	getMessageCount(): number {
		const row = this.db.prepare("SELECT COUNT(*) as count FROM chat_messages").get() as { count: number };
		return row.count;
	}
}
