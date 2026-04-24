import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { ulid } from "../utils/ulid.js";
import type {
	CreateLearningEntryInput,
	LearningEntry,
	LearningEntryStatus,
	LearningEntrySummary,
	LearningMessage,
	LearningMessageRole,
	SummaryJson,
} from "./learning-types.js";

interface EntryRow {
	id: string;
	title: string;
	status: LearningEntryStatus;
	source_type: "agent" | "merged";
	source_agents: string;
	agent_prompts: string;
	summary_json: string;
	diff_stats: string;
	diff_blob_path: string;
	memory_flushed_at: number | null;
	created_at: number;
	updated_at: number;
}

export class LearningStore {
	private db: Database.Database;
	private diffDir: string;

	constructor(db: Database.Database, diffDir: string) {
		this.db = db;
		this.diffDir = diffDir;
	}

	private async ensureDiffDir(): Promise<void> {
		await mkdir(this.diffDir, { recursive: true });
	}

	private rowToEntry(row: EntryRow): LearningEntry {
		return {
			id: row.id,
			title: row.title,
			status: row.status,
			sourceType: row.source_type,
			sourceAgents: JSON.parse(row.source_agents),
			agentPrompts: JSON.parse(row.agent_prompts),
			summaryJson: JSON.parse(row.summary_json),
			diffStats: JSON.parse(row.diff_stats),
			diffBlobPath: row.diff_blob_path,
			memoryFlushedAt: row.memory_flushed_at,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		};
	}

	private toSummary(entry: LearningEntry): LearningEntrySummary {
		const { summaryJson, agentPrompts, diffBlobPath, ...rest } = entry;
		return rest;
	}

	async create(input: CreateLearningEntryInput): Promise<LearningEntry> {
		await this.ensureDiffDir();
		const id = `lrn_${ulid()}`;
		const now = Date.now();
		const diffBlobPath = join(this.diffDir, `${id}.diff`);
		await writeFile(diffBlobPath, input.rawDiff, "utf-8");
		try {
			this.db
				.prepare(
					`INSERT INTO learning_entries
					(id, title, status, source_type, source_agents, agent_prompts, summary_json, diff_stats, diff_blob_path, memory_flushed_at, created_at, updated_at)
					VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
				)
				.run(
					id,
					input.title,
					input.sourceType,
					JSON.stringify(input.sourceAgents),
					JSON.stringify(input.agentPrompts),
					JSON.stringify(input.summaryJson),
					JSON.stringify(input.diffStats),
					diffBlobPath,
					now,
					now,
				);
		} catch (err) {
			await unlink(diffBlobPath).catch(() => {});
			throw err;
		}
		return (await this.loadEntry(id))!;
	}

	async loadEntry(id: string): Promise<LearningEntry | null> {
		const row = this.db.prepare("SELECT * FROM learning_entries WHERE id = ?").get(id) as EntryRow | undefined;
		return row ? this.rowToEntry(row) : null;
	}

	async list(
		opts: { status?: LearningEntryStatus; limit?: number; offset?: number } = {},
	): Promise<LearningEntrySummary[]> {
		const status = opts.status ?? "active";
		const limit = opts.limit ?? 100;
		const offset = opts.offset ?? 0;
		const rows = this.db
			.prepare("SELECT * FROM learning_entries WHERE status = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?")
			.all(status, limit, offset) as EntryRow[];
		return rows.map((r) => this.toSummary(this.rowToEntry(r)));
	}

	async updateTitle(id: string, title: string): Promise<void> {
		this.db.prepare("UPDATE learning_entries SET title = ?, updated_at = ? WHERE id = ?").run(title, Date.now(), id);
	}

	async setStatus(id: string, status: LearningEntryStatus): Promise<void> {
		this.db
			.prepare("UPDATE learning_entries SET status = ?, updated_at = ? WHERE id = ?")
			.run(status, Date.now(), id);
	}

	async replaceSummary(id: string, summary: SummaryJson): Promise<void> {
		this.db
			.prepare("UPDATE learning_entries SET summary_json = ?, title = ?, updated_at = ? WHERE id = ?")
			.run(JSON.stringify(summary), summary.title, Date.now(), id);
	}

	async markMemoryFlushed(id: string, at: number): Promise<void> {
		this.db
			.prepare("UPDATE learning_entries SET memory_flushed_at = ?, updated_at = ? WHERE id = ?")
			.run(at, Date.now(), id);
	}

	async delete(id: string): Promise<void> {
		const row = await this.loadEntry(id);
		this.db.prepare("DELETE FROM learning_entries WHERE id = ?").run(id);
		if (row) {
			try {
				await unlink(row.diffBlobPath);
			} catch {
				/* ignore missing file */
			}
		}
	}

	async appendMessage(entryId: string, role: LearningMessageRole, content: string): Promise<void> {
		const now = Date.now();
		this.db
			.prepare("INSERT INTO learning_messages (entry_id, role, content, created_at) VALUES (?, ?, ?, ?)")
			.run(entryId, role, content, now);
		this.db.prepare("UPDATE learning_entries SET updated_at = ? WHERE id = ?").run(now, entryId);
	}

	async loadMessages(entryId: string): Promise<LearningMessage[]> {
		const rows = this.db
			.prepare(
				"SELECT id, entry_id, role, content, created_at FROM learning_messages WHERE entry_id = ? ORDER BY id ASC",
			)
			.all(entryId) as Array<{
			id: number;
			entry_id: string;
			role: LearningMessageRole;
			content: string;
			created_at: number;
		}>;
		return rows.map((r) => ({
			id: r.id,
			entryId: r.entry_id,
			role: r.role,
			content: r.content,
			createdAt: r.created_at,
		}));
	}

	async readDiffBlob(id: string): Promise<string> {
		const entry = await this.loadEntry(id);
		if (!entry) throw new Error(`learning entry not found: ${id}`);
		return readFile(entry.diffBlobPath, "utf-8");
	}

	async writeDiffBlobFor(id: string, rawDiff: string): Promise<string> {
		await this.ensureDiffDir();
		const path = join(this.diffDir, `${id}.diff`);
		await writeFile(path, rawDiff, "utf-8");
		return path;
	}

	toSummaryFor(entry: LearningEntry): LearningEntrySummary {
		return this.toSummary(entry);
	}
}
