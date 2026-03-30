import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { logger } from "../utils/logger.js";

const require = createRequire(import.meta.url);
import type { FileEntry } from "./types.js";

// ─── Schema SQL ─────────────────────────────────────────

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
	key   TEXT PRIMARY KEY,
	value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
	project TEXT NOT NULL,
	path    TEXT NOT NULL,
	source  TEXT NOT NULL DEFAULT 'memory',
	hash    TEXT NOT NULL,
	mtime   INTEGER NOT NULL,
	size    INTEGER NOT NULL,
	PRIMARY KEY (project, path)
);

CREATE TABLE IF NOT EXISTS chunks (
	id         TEXT PRIMARY KEY,
	project    TEXT NOT NULL,
	path       TEXT NOT NULL,
	source     TEXT NOT NULL DEFAULT 'memory',
	start_line INTEGER NOT NULL,
	end_line   INTEGER NOT NULL,
	hash       TEXT NOT NULL,
	model      TEXT NOT NULL,
	text       TEXT NOT NULL,
	embedding  TEXT NOT NULL,
	updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chunks_project ON chunks(project);
CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path);
CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
	text,
	id UNINDEXED,
	project UNINDEXED,
	path UNINDEXED,
	source UNINDEXED,
	model UNINDEXED,
	start_line UNINDEXED,
	end_line UNINDEXED
);

CREATE TABLE IF NOT EXISTS embedding_cache (
	provider     TEXT NOT NULL,
	model        TEXT NOT NULL,
	provider_key TEXT NOT NULL,
	hash         TEXT NOT NULL,
	embedding    TEXT NOT NULL,
	dims         INTEGER,
	updated_at   INTEGER NOT NULL,
	PRIMARY KEY (provider, model, provider_key, hash)
);

CREATE INDEX IF NOT EXISTS idx_embedding_cache_updated_at
	ON embedding_cache(updated_at);
`;

/**
 * Sanitize a provider name for use in a SQL table name.
 * Only lowercase alphanumeric and underscores are allowed.
 */
export function sanitizeVecTableProvider(provider: string): string {
	return provider.toLowerCase().replace(/[^a-z0-9_]/g, "_");
}

const VEC_TABLE_SQL = (provider: string, dims: number) => {
	const tableName = `chunks_vec_${sanitizeVecTableProvider(provider)}_${dims}`;
	return `CREATE VIRTUAL TABLE IF NOT EXISTS ${tableName} USING vec0(
		id TEXT PRIMARY KEY,
		embedding float[${dims}]
	);`;
};

// ─── MemoryStore ────────────────────────────────────────

export interface MemoryStoreConfig {
	/** Path to the SQLite database file */
	dbPath: string;
	/** Project identifier (e.g. "cliclaw-a3f2d1") */
	projectId: string;
	/** Workspace root directory (project location, used for skills/prompts discovery) */
	workspaceDir: string;
	/** Centralized storage directory for memory files (defaults to workspaceDir for backwards compat) */
	storageDir?: string;
	/** Whether to attempt loading sqlite-vec */
	vectorEnabled?: boolean;
	/** Custom path to sqlite-vec shared library */
	vectorExtensionPath?: string;
}

export class MemoryStore {
	private db: Database.Database;
	private projectId: string;
	private workspaceDir: string;
	private storageDir: string;
	private vecAvailable = false;
	private ftsAvailable = false;
	private vecTableName: string | null = null;
	private dirty = false;

	constructor(config: MemoryStoreConfig) {
		this.projectId = config.projectId;
		this.workspaceDir = config.workspaceDir;
		this.storageDir = config.storageDir ?? config.workspaceDir;
		mkdirSync(dirname(config.dbPath), { recursive: true });
		this.db = new Database(config.dbPath);

		// Enable WAL mode for better concurrent read performance
		this.db.pragma("journal_mode = WAL");
		// Set busy timeout for concurrent access from multiple projects
		this.db.pragma("busy_timeout = 5000");

		// Initialize core schema (non-vec tables)
		this.db.exec(SCHEMA_SQL);
		this.ftsAvailable = this.checkFtsAvailable();

		// Attempt to load sqlite-vec extension
		if (config.vectorEnabled !== false) {
			this.vecAvailable = this.loadVecExtension(config.vectorExtensionPath);
		}

		logger.info(
			"memory-store",
			`Initialized: project=${this.projectId}, vec=${this.vecAvailable}, fts=${this.ftsAvailable}`,
		);
	}

	// ─── Public Accessors ─────────────────────────────────

	getProjectId(): string {
		return this.projectId;
	}

	isVecAvailable(): boolean {
		return this.vecAvailable;
	}

	isFtsAvailable(): boolean {
		return this.ftsAvailable;
	}

	isDirty(): boolean {
		return this.dirty;
	}

	markDirty(): void {
		this.dirty = true;
	}

	clearDirty(): void {
		this.dirty = false;
	}

	getDb(): Database.Database {
		return this.db;
	}

	getWorkspaceDir(): string {
		return this.workspaceDir;
	}

	getStorageDir(): string {
		return this.storageDir;
	}

	getVecTableName(): string | null {
		return this.vecTableName;
	}

	// ─── Vec Table Management ─────────────────────────────

	/**
	 * Initialize a provider-specific chunks_vec virtual table.
	 * Table name: chunks_vec_{provider}_{dims}
	 */
	initVecTable(provider: string, dims: number): void {
		if (!this.vecAvailable) return;

		const tableName = `chunks_vec_${sanitizeVecTableProvider(provider)}_${dims}`;
		if (this.vecTableName === tableName) return; // Already initialized

		try {
			this.db.exec(VEC_TABLE_SQL(provider, dims));
			this.vecTableName = tableName;
			logger.info("memory-store", `${tableName} table initialized with ${dims} dimensions`);
		} catch (err: any) {
			logger.warn("memory-store", `Failed to create ${tableName}: ${err.message}`);
			this.vecAvailable = false;
		}
	}

	// ─── File Tracking ────────────────────────────────────

	getTrackedFile(path: string): { hash: string } | undefined {
		return this.db.prepare("SELECT hash FROM files WHERE project = ? AND path = ?").get(this.projectId, path) as
			| { hash: string }
			| undefined;
	}

	upsertFile(entry: FileEntry): void {
		this.db
			.prepare(
				`INSERT OR REPLACE INTO files (project, path, source, hash, mtime, size)
				 VALUES (?, ?, 'memory', ?, ?, ?)`,
			)
			.run(this.projectId, entry.path, entry.hash, entry.mtimeMs, entry.size);
	}

	getTrackedFilePaths(): string[] {
		const rows = this.db
			.prepare("SELECT path FROM files WHERE project = ? AND source = 'memory'")
			.all(this.projectId) as { path: string }[];
		return rows.map((r) => r.path);
	}

	removeFile(path: string): void {
		this.db.prepare("DELETE FROM files WHERE project = ? AND path = ?").run(this.projectId, path);
		this.removeChunksByPath(path);
	}

	// ─── Chunk Operations ─────────────────────────────────

	removeChunksByPath(path: string): void {
		// Get chunk IDs for vec cleanup
		const chunkIds = this.db
			.prepare("SELECT id FROM chunks WHERE project = ? AND path = ?")
			.all(this.projectId, path) as { id: string }[];

		this.db.prepare("DELETE FROM chunks WHERE project = ? AND path = ?").run(this.projectId, path);
		this.db.prepare("DELETE FROM chunks_fts WHERE project = ? AND path = ?").run(this.projectId, path);

		if (this.vecAvailable && this.vecTableName) {
			for (const { id } of chunkIds) {
				try {
					this.db.prepare(`DELETE FROM ${this.vecTableName} WHERE id = ?`).run(id);
				} catch {
					// vec table may not exist yet
				}
			}
		}
	}

	insertChunk(params: {
		id: string;
		path: string;
		startLine: number;
		endLine: number;
		hash: string;
		model: string;
		text: string;
		embedding: number[];
	}): void {
		const now = Date.now();
		const embeddingJson = JSON.stringify(params.embedding);

		this.db
			.prepare(
				`INSERT OR REPLACE INTO chunks
				 (id, project, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
				 VALUES (?, ?, ?, 'memory', ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				params.id,
				this.projectId,
				params.path,
				params.startLine,
				params.endLine,
				params.hash,
				params.model,
				params.text,
				embeddingJson,
				now,
			);

		// FTS insert
		if (this.ftsAvailable) {
			this.db
				.prepare(
					`INSERT INTO chunks_fts (text, id, project, path, source, model, start_line, end_line)
					 VALUES (?, ?, ?, ?, 'memory', ?, ?, ?)`,
				)
				.run(params.text, params.id, this.projectId, params.path, params.model, params.startLine, params.endLine);
		}

		// Vec insert
		if (this.vecAvailable && this.vecTableName) {
			try {
				const vecBlob = vectorToBlob(params.embedding);
				this.db
					.prepare(`INSERT OR REPLACE INTO ${this.vecTableName} (id, embedding) VALUES (?, ?)`)
					.run(params.id, vecBlob);
			} catch (err: any) {
				logger.warn("memory-store", `Failed to insert vec for ${params.id}: ${err.message}`);
			}
		}
	}

	// ─── Embedding Cache ──────────────────────────────────

	loadCachedEmbeddings(provider: string, model: string, providerKey: string, hashes: string[]): Map<string, number[]> {
		const result = new Map<string, number[]>();
		const batchSize = 400;

		for (let i = 0; i < hashes.length; i += batchSize) {
			const batch = hashes.slice(i, i + batchSize);
			const placeholders = batch.map(() => "?").join(",");
			const rows = this.db
				.prepare(
					`SELECT hash, embedding FROM embedding_cache
					 WHERE provider = ? AND model = ? AND provider_key = ?
					 AND hash IN (${placeholders})`,
				)
				.all(provider, model, providerKey, ...batch) as { hash: string; embedding: string }[];

			for (const row of rows) {
				result.set(row.hash, JSON.parse(row.embedding));
			}
		}

		return result;
	}

	upsertCachedEmbedding(
		provider: string,
		model: string,
		providerKey: string,
		hash: string,
		embedding: number[],
	): void {
		this.db
			.prepare(
				`INSERT OR REPLACE INTO embedding_cache
				 (provider, model, provider_key, hash, embedding, dims, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(provider, model, providerKey, hash, JSON.stringify(embedding), embedding.length, Date.now());
	}

	pruneCache(provider: string, model: string, maxEntries: number): void {
		const row = this.db
			.prepare("SELECT COUNT(*) as c FROM embedding_cache WHERE provider = ? AND model = ?")
			.get(provider, model) as { c: number };

		if (row.c <= maxEntries) return;

		const toDelete = row.c - maxEntries;
		this.db
			.prepare(
				`DELETE FROM embedding_cache
				 WHERE rowid IN (
					 SELECT rowid FROM embedding_cache
					 WHERE provider = ? AND model = ?
					 ORDER BY updated_at ASC
					 LIMIT ?
				 )`,
			)
			.run(provider, model, toDelete);
	}

	// ─── Write Operations ─────────────────────────────────

	/**
	 * Write content to a memory file. Used by both MainAgent memory_write tool
	 * and ContextManager Memory Flush.
	 */
	async write(params: { path: string; content: string }): Promise<{ success: boolean; path: string }> {
		const { writeFile, appendFile, mkdir } = await import("node:fs/promises");
		const { dirname } = await import("node:path");

		const relPath = params.path.trim();

		// Security: only allow memory/ directory
		if (!isMemoryPath(relPath)) {
			throw new Error("Only .md files under memory/ directory are allowed");
		}

		const absPath = join(this.storageDir, relPath);

		// Ensure directory exists
		await mkdir(dirname(absPath), { recursive: true });

		// Append or create
		try {
			const existing = await readFile(absPath, "utf-8");
			if (!existing.endsWith("\n")) {
				await appendFile(absPath, "\n");
			}
			await appendFile(absPath, params.content);
		} catch {
			// File doesn't exist, create it
			await writeFile(absPath, params.content, "utf-8");
		}

		this.markDirty();
		return { success: true, path: relPath };
	}

	// ─── Cleanup ──────────────────────────────────────────

	close(): void {
		this.db.close();
	}

	// ─── Private Methods ──────────────────────────────────

	private loadVecExtension(extensionPath?: string): boolean {
		try {
			if (extensionPath) {
				this.db.loadExtension(extensionPath);
			} else {
				// Try to load from sqlite-vec npm package
				const sqliteVec = require("sqlite-vec");
				sqliteVec.load(this.db);
			}
			logger.info("memory-store", "sqlite-vec extension loaded");
			return true;
		} catch (err: any) {
			logger.warn("memory-store", `sqlite-vec not available: ${err.message}`);
			return false;
		}
	}

	private checkFtsAvailable(): boolean {
		try {
			// Check if FTS5 is available by querying the compile options
			const rows = this.db.prepare("PRAGMA compile_options").all() as { compile_options: string }[];
			const options = rows.map((r) => r.compile_options);
			// FTS5 is usually available unless explicitly disabled
			// Our schema already creates the table, so if it succeeded we're good
			return true;
		} catch {
			return false;
		}
	}
}

// ─── Utility Functions ──────────────────────────────────

export function isMemoryPath(relPath: string): boolean {
	const normalized = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
	return normalized.startsWith("memory/") && normalized.endsWith(".md");
}

export function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

export function vectorToBlob(vec: number[]): Buffer {
	const buf = Buffer.alloc(vec.length * 4);
	for (let i = 0; i < vec.length; i++) {
		buf.writeFloatLE(vec[i], i * 4);
	}
	return buf;
}

export function blobToVector(buf: Buffer): number[] {
	const vec: number[] = [];
	for (let i = 0; i < buf.length; i += 4) {
		vec.push(buf.readFloatLE(i));
	}
	return vec;
}

export async function buildFileEntry(absPath: string, workspaceDir: string): Promise<FileEntry> {
	const { relative } = await import("node:path");
	const content = await readFile(absPath, "utf-8");
	const stats = await stat(absPath);
	return {
		path: relative(workspaceDir, absPath).replace(/\\/g, "/"),
		hash: sha256(content),
		mtimeMs: Math.floor(stats.mtimeMs),
		size: stats.size,
	};
}

export async function listMemoryFiles(storageDir: string): Promise<string[]> {
	const { readdir } = await import("node:fs/promises");
	const { join: joinPath } = await import("node:path");

	const files: string[] = [];

	// Scan memory/ directory under centralized storage
	const memoryDir = joinPath(storageDir, "memory");
	try {
		const entries = await readdir(memoryDir, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.isFile() && entry.name.endsWith(".md")) {
				files.push(joinPath(memoryDir, entry.name));
			}
		}
	} catch {
		// memory/ directory doesn't exist yet
	}

	return files;
}
