import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildFileEntry,
	isMemoryPath,
	listMemoryFiles,
	MemoryStore,
	sanitizeVecTableProvider,
	sha256,
} from "../../src/memory/store.js";

describe("MemoryStore", () => {
	let tmpDir: string;
	let storageDir: string;
	let dbPath: string;
	let store: MemoryStore;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "cliclaw-test-"));
		storageDir = join(tmpDir, "storage");
		await mkdir(storageDir, { recursive: true });
		dbPath = join(storageDir, "test.sqlite");
		store = new MemoryStore({
			dbPath,
			workspaceDir: tmpDir,
			storageDir,
			vectorEnabled: false, // Don't require sqlite-vec in tests
		});
	});

	afterEach(async () => {
		store.close();
		await rm(tmpDir, { recursive: true, force: true });
	});

	describe("schema initialization", () => {
		it("should auto-create parent directory if missing", () => {
			const nestedDir = join(tmpDir, "nonexistent", "deep", "path");
			const nestedDbPath = join(nestedDir, "memory.sqlite");
			const nestedStore = new MemoryStore({
				dbPath: nestedDbPath,
				workspaceDir: tmpDir,
				vectorEnabled: false,
			});
			// Should not throw — directory was created automatically
			const tables = nestedStore
				.getDb()
				.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
				.all() as { name: string }[];
			expect(tables.length).toBeGreaterThan(0);
			nestedStore.close();
		});

		it("should create all required tables", () => {
			const tables = store
				.getDb()
				.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
				.all() as { name: string }[];
			const names = tables.map((t) => t.name);

			expect(names).toContain("meta");
			expect(names).toContain("files");
			expect(names).toContain("chunks");
			expect(names).toContain("embedding_cache");
		});

		it("should store schema version in meta table", () => {
			const row = store.getDb().prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as any;
			expect(row.value).toBe("3");
		});

		it("should migrate old schema by rebuilding tables", async () => {
			// Simulate an old schema by setting a different version
			store.close();

			// Create a DB with old version
			const Database = (await import("better-sqlite3")).default;
			const db = new Database(dbPath);
			db.prepare("UPDATE meta SET value = '1' WHERE key = 'schema_version'").run();
			db.prepare(
				"INSERT OR REPLACE INTO files (path, source, hash, mtime, size) VALUES ('memory/old.md', 'memory', 'h', 1000, 50)",
			).run();
			db.close();

			// Re-open — should detect version mismatch and rebuild
			const newStore = new MemoryStore({
				dbPath,
				workspaceDir: tmpDir,
				storageDir,
				vectorEnabled: false,
			});

			// Old data should be gone after rebuild
			const files = newStore.getDb().prepare("SELECT * FROM files").all();
			expect(files).toHaveLength(0);

			// Version should be updated
			const row = newStore.getDb().prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as any;
			expect(row.value).toBe("3");

			newStore.close();
		});
	});

	describe("file tracking", () => {
		it("should track and retrieve files", () => {
			store.upsertFile({ path: "memory/core.md", hash: "abc123", mtimeMs: 1000, size: 100 });

			const tracked = store.getTrackedFile("memory/core.md");
			expect(tracked).toBeDefined();
			expect(tracked!.hash).toBe("abc123");
		});

		it("should return undefined for untracked files", () => {
			expect(store.getTrackedFile("nonexistent.md")).toBeUndefined();
		});

		it("should list tracked file paths", () => {
			store.upsertFile({ path: "memory/core.md", hash: "a", mtimeMs: 1000, size: 100 });
			store.upsertFile({ path: "memory/todos.md", hash: "b", mtimeMs: 1000, size: 50 });

			const paths = store.getTrackedFilePaths();
			expect(paths).toContain("memory/core.md");
			expect(paths).toContain("memory/todos.md");
		});

		it("should remove file and its chunks", () => {
			store.upsertFile({ path: "memory/old.md", hash: "x", mtimeMs: 1000, size: 50 });
			store.insertChunk({
				id: "chunk-1",
				path: "memory/old.md",
				startLine: 1,
				endLine: 5,
				hash: "h1",
				model: "test",
				text: "some text",
				embedding: [],
			});

			store.removeFile("memory/old.md");

			expect(store.getTrackedFile("memory/old.md")).toBeUndefined();
			const chunks = store.getDb().prepare("SELECT * FROM chunks WHERE path = ?").all("memory/old.md");
			expect(chunks).toHaveLength(0);
		});
	});

	describe("chunk operations", () => {
		it("should insert and query chunks", () => {
			store.insertChunk({
				id: "c1",
				path: "memory/core.md",
				startLine: 1,
				endLine: 10,
				hash: "h1",
				model: "test-model",
				text: "## Architecture\nSome content here",
				embedding: [0.1, 0.2, 0.3],
			});

			const row = store.getDb().prepare("SELECT * FROM chunks WHERE id = ?").get("c1") as any;
			expect(row).toBeDefined();
			expect(row.path).toBe("memory/core.md");
			expect(row.start_line).toBe(1);
			expect(row.end_line).toBe(10);
			expect(JSON.parse(row.embedding)).toEqual([0.1, 0.2, 0.3]);
		});

		it("should delete chunks by path", () => {
			store.insertChunk({
				id: "c1",
				path: "memory/core.md",
				startLine: 1,
				endLine: 5,
				hash: "h1",
				model: "test",
				text: "text",
				embedding: [],
			});
			store.insertChunk({
				id: "c2",
				path: "memory/todos.md",
				startLine: 1,
				endLine: 5,
				hash: "h2",
				model: "test",
				text: "other text",
				embedding: [],
			});

			store.removeChunksByPath("memory/core.md");

			const c1 = store.getDb().prepare("SELECT * FROM chunks WHERE id = 'c1'").get();
			expect(c1).toBeUndefined();

			const c2 = store.getDb().prepare("SELECT * FROM chunks WHERE id = 'c2'").get();
			expect(c2).toBeDefined();
		});

		it("should not duplicate FTS rows when re-inserting the same chunk id", () => {
			const params = {
				id: "c1",
				path: "memory/core.md",
				startLine: 1,
				endLine: 5,
				hash: "h1",
				model: "test",
				text: "some searchable content",
				embedding: [],
			};
			store.insertChunk(params);
			// Re-insert the same id (e.g. crash-recovery / re-index without a prior remove).
			store.insertChunk({ ...params, text: "updated searchable content" });

			const ftsRows = store.getDb().prepare("SELECT * FROM chunks_fts WHERE id = 'c1'").all();
			expect(ftsRows).toHaveLength(1);
			const chunkRows = store.getDb().prepare("SELECT * FROM chunks WHERE id = 'c1'").all();
			expect(chunkRows).toHaveLength(1);
		});

		it("should re-index a file atomically via runInTransaction", () => {
			store.runInTransaction(() => {
				store.removeChunksByPath("memory/core.md");
				store.insertChunk({
					id: "tx1",
					path: "memory/core.md",
					startLine: 1,
					endLine: 3,
					hash: "h1",
					model: "test",
					text: "transactional content",
					embedding: [],
				});
				store.upsertFile({ path: "memory/core.md", hash: "fh", mtimeMs: 1000, size: 20 });
			});

			expect(store.getDb().prepare("SELECT * FROM chunks WHERE id = 'tx1'").get()).toBeDefined();
			expect(store.getDb().prepare("SELECT * FROM chunks_fts WHERE id = 'tx1'").all()).toHaveLength(1);
			expect(store.getTrackedFile("memory/core.md")).toBeDefined();
		});
	});

	describe("model change detection", () => {
		it("should detect model change", () => {
			store.insertChunk({
				id: "c1",
				path: "memory/core.md",
				startLine: 1,
				endLine: 5,
				hash: "h1",
				model: "old-model",
				text: "text",
				embedding: [],
			});

			expect(store.hasModelChanged("old-model")).toBe(false);
			expect(store.hasModelChanged("new-model")).toBe(true);
		});

		it("should return false when no chunks exist", () => {
			expect(store.hasModelChanged("any-model")).toBe(false);
		});
	});

	describe("clearAllTrackedFiles", () => {
		it("should clear all files and chunks", () => {
			store.upsertFile({ path: "memory/core.md", hash: "a", mtimeMs: 1000, size: 100 });
			store.insertChunk({
				id: "c1",
				path: "memory/core.md",
				startLine: 1,
				endLine: 5,
				hash: "h1",
				model: "test",
				text: "text",
				embedding: [],
			});

			store.clearAllTrackedFiles();

			expect(store.getTrackedFilePaths()).toHaveLength(0);
			const chunks = store.getDb().prepare("SELECT * FROM chunks").all();
			expect(chunks).toHaveLength(0);
			expect(store.isDirty()).toBe(true);
		});
	});

	describe("embedding cache", () => {
		it("should cache and retrieve embeddings", () => {
			store.upsertCachedEmbedding("openai", "text-embedding-3-small", "key1", "hash1", [0.1, 0.2]);

			const cached = store.loadCachedEmbeddings("openai", "text-embedding-3-small", "key1", ["hash1"]);
			expect(cached.get("hash1")).toEqual([0.1, 0.2]);
		});

		it("should return empty map for cache miss", () => {
			const cached = store.loadCachedEmbeddings("openai", "model", "key", ["nonexistent"]);
			expect(cached.size).toBe(0);
		});

		it("should prune oldest cache entries", () => {
			// Insert 5 entries with increasing timestamps
			for (let i = 0; i < 5; i++) {
				store.upsertCachedEmbedding("p", "m", "k", `hash${i}`, [i]);
			}

			store.pruneCache("p", "m", 3);

			const remaining = store.loadCachedEmbeddings("p", "m", "k", ["hash0", "hash1", "hash2", "hash3", "hash4"]);
			expect(remaining.size).toBeLessThanOrEqual(3);
		});
	});

	describe("write", () => {
		it("should write new memory file to storageDir", async () => {
			const result = await store.write({ path: "memory/test.md", content: "# Test\nHello" });
			expect(result.success).toBe(true);
			expect(store.isDirty()).toBe(true);

			const { readFile } = await import("node:fs/promises");
			const content = await readFile(join(storageDir, "memory/test.md"), "utf-8");
			expect(content).toBe("# Test\nHello");
		});

		it("should append to existing file in storageDir", async () => {
			await mkdir(join(storageDir, "memory"), { recursive: true });
			await writeFile(join(storageDir, "memory/core.md"), "# Core\n");

			await store.write({ path: "memory/core.md", content: "New line" });

			const { readFile } = await import("node:fs/promises");
			const content = await readFile(join(storageDir, "memory/core.md"), "utf-8");
			expect(content).toBe("# Core\nNew line");
		});

		it("should overwrite existing file when mode is overwrite", async () => {
			await mkdir(join(storageDir, "memory"), { recursive: true });
			await writeFile(join(storageDir, "memory/core.md"), "# Old Content\nold stuff");

			await store.write({ path: "memory/core.md", content: "# New Content\nnew stuff", mode: "overwrite" });

			const { readFile } = await import("node:fs/promises");
			const content = await readFile(join(storageDir, "memory/core.md"), "utf-8");
			expect(content).toBe("# New Content\nnew stuff");
		});

		it("should create file when overwrite mode targets non-existent file", async () => {
			await store.write({ path: "memory/new.md", content: "# Fresh", mode: "overwrite" });

			const { readFile } = await import("node:fs/promises");
			const content = await readFile(join(storageDir, "memory/new.md"), "utf-8");
			expect(content).toBe("# Fresh");
		});

		it("should reject non-memory paths", async () => {
			await expect(store.write({ path: "src/main.ts", content: "hack" })).rejects.toThrow(
				"Only .md files under memory/",
			);
		});
	});

	describe("edit", () => {
		it("should replace matched text", async () => {
			await mkdir(join(storageDir, "memory"), { recursive: true });
			await writeFile(join(storageDir, "memory/core.md"), "# Core\n- old item\n- keep item\n");

			await store.edit({ path: "memory/core.md", mode: "replace", match: "- old item", content: "- new item" });

			const { readFile } = await import("node:fs/promises");
			const content = await readFile(join(storageDir, "memory/core.md"), "utf-8");
			expect(content).toBe("# Core\n- new item\n- keep item\n");
		});

		it("should delete matched text", async () => {
			await mkdir(join(storageDir, "memory"), { recursive: true });
			await writeFile(join(storageDir, "memory/todos.md"), "# Todos\n- done task\n- pending task\n");

			await store.edit({ path: "memory/todos.md", mode: "delete", match: "- done task\n" });

			const { readFile } = await import("node:fs/promises");
			const content = await readFile(join(storageDir, "memory/todos.md"), "utf-8");
			expect(content).toBe("# Todos\n- pending task\n");
		});

		it("should throw when match text not found", async () => {
			await mkdir(join(storageDir, "memory"), { recursive: true });
			await writeFile(join(storageDir, "memory/core.md"), "# Core\n- item\n");

			await expect(
				store.edit({ path: "memory/core.md", mode: "replace", match: "nonexistent", content: "new" }),
			).rejects.toThrow("match text not found");
		});

		it("should throw when match missing for replace mode", async () => {
			await expect(store.edit({ path: "memory/core.md", mode: "replace", content: "new" })).rejects.toThrow(
				"match is required",
			);
		});

		it("should throw when match missing for delete mode", async () => {
			await expect(store.edit({ path: "memory/core.md", mode: "delete" })).rejects.toThrow("match is required");
		});

		it("should reject path traversal that escapes the storage dir", async () => {
			// "memory/../../../etc/x.md" join()'d onto storageDir would land outside
			// <storageDir>/memory. Must be rejected before any FS write.
			await expect(
				store.edit({ path: "memory/../../../etc/x.md", content: "pwned", mode: "overwrite" }),
			).rejects.toThrow("Only .md files under memory/");

			// The escaped file must NOT have been written.
			const { readFile } = await import("node:fs/promises");
			await expect(readFile(join(tmpDir, "..", "..", "..", "etc", "x.md"), "utf-8")).rejects.toThrow();
		});

		it("should expand $-sequences literally in replace content", async () => {
			await mkdir(join(storageDir, "memory"), { recursive: true });
			await writeFile(join(storageDir, "memory/core.md"), "# Core\nPRICE_HERE done\n");

			// Replacement contains $&, $', $` and $1 — a naive String.replace(match, content)
			// would expand these; the function replacer must insert them verbatim.
			const literal = "cost is $5 and $& $' $` $1 tokens";
			await store.edit({ path: "memory/core.md", mode: "replace", match: "PRICE_HERE", content: literal });

			const { readFile } = await import("node:fs/promises");
			const content = await readFile(join(storageDir, "memory/core.md"), "utf-8");
			expect(content).toBe(`# Core\n${literal} done\n`);
		});
	});

	describe("vec table naming", () => {
		it("should sanitize provider names for table names", () => {
			expect(sanitizeVecTableProvider("openai")).toBe("openai");
			expect(sanitizeVecTableProvider("OpenAI")).toBe("openai");
			expect(sanitizeVecTableProvider("openai-v2")).toBe("openai_v2");
			expect(sanitizeVecTableProvider("my.provider")).toBe("my_provider");
		});
	});
});

describe("isMemoryPath", () => {
	it("should accept memory/ paths", () => {
		expect(isMemoryPath("memory/core.md")).toBe(true);
		expect(isMemoryPath("memory/2024-01-15.md")).toBe(true);
	});

	it("should reject legacy root files", () => {
		expect(isMemoryPath("MEMORY.md")).toBe(false);
		expect(isMemoryPath("memory.md")).toBe(false);
	});

	it("should reject non-memory paths", () => {
		expect(isMemoryPath("src/main.ts")).toBe(false);
		expect(isMemoryPath("memory/nested/deep.md")).toBe(true); // subdirs are ok
		expect(isMemoryPath("memory/file.txt")).toBe(false); // non-md
	});

	it("should reject path traversal segments", () => {
		expect(isMemoryPath("memory/../../../x.md")).toBe(false);
		expect(isMemoryPath("memory/../secret.md")).toBe(false);
		expect(isMemoryPath("memory/sub/../../escape.md")).toBe(false);
	});
});

describe("listMemoryFiles", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "cliclaw-list-"));
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	it("should find memory/*.md files in storageDir", async () => {
		await mkdir(join(tmpDir, "memory"), { recursive: true });
		await writeFile(join(tmpDir, "memory/core.md"), "core");
		await writeFile(join(tmpDir, "memory/todos.md"), "todos");

		const files = await listMemoryFiles(tmpDir);
		expect(files).toHaveLength(2);
		expect(files.some((f) => f.endsWith("core.md"))).toBe(true);
		expect(files.some((f) => f.endsWith("todos.md"))).toBe(true);
	});

	it("should not find root MEMORY.md (legacy removed)", async () => {
		await writeFile(join(tmpDir, "MEMORY.md"), "legacy");

		const files = await listMemoryFiles(tmpDir);
		expect(files).toHaveLength(0);
	});

	it("should return empty for no memory files", async () => {
		const files = await listMemoryFiles(tmpDir);
		expect(files).toHaveLength(0);
	});

	it("should recursively find .md files in subdirectories", async () => {
		// Learning-pipeline output lands at memory/learning/<id>.md — it must be
		// discovered so memory_search can index and find it.
		await mkdir(join(tmpDir, "memory", "learning"), { recursive: true });
		await writeFile(join(tmpDir, "memory/core.md"), "core");
		await writeFile(join(tmpDir, "memory/learning/abc123.md"), "learned");

		const files = await listMemoryFiles(tmpDir);
		expect(files).toHaveLength(2);
		expect(files.some((f) => f.endsWith(join("learning", "abc123.md")))).toBe(true);
		expect(files.some((f) => f.endsWith("core.md"))).toBe(true);
	});

	it("should ignore non-.md files in subdirectories", async () => {
		await mkdir(join(tmpDir, "memory", "learning"), { recursive: true });
		await writeFile(join(tmpDir, "memory/learning/diff.txt"), "not markdown");
		await writeFile(join(tmpDir, "memory/learning/note.md"), "markdown");

		const files = await listMemoryFiles(tmpDir);
		expect(files).toHaveLength(1);
		expect(files[0].endsWith("note.md")).toBe(true);
	});
});

describe("sha256", () => {
	it("should produce consistent hashes", () => {
		expect(sha256("hello")).toBe(sha256("hello"));
		expect(sha256("hello")).not.toBe(sha256("world"));
	});
});

describe("buildFileEntry", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "cliclaw-entry-"));
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	it("should build correct file entry", async () => {
		await mkdir(join(tmpDir, "memory"), { recursive: true });
		await writeFile(join(tmpDir, "memory/core.md"), "content");

		const entry = await buildFileEntry(join(tmpDir, "memory/core.md"), tmpDir);
		expect(entry.path).toBe("memory/core.md");
		expect(entry.hash).toBe(sha256("content"));
		expect(entry.size).toBeGreaterThan(0);
		expect(entry.mtimeMs).toBeGreaterThan(0);
	});
});
