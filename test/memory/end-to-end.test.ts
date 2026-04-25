import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildCategoryPathFilter } from "../../src/memory/category.js";
import { searchMemory } from "../../src/memory/search.js";
import { MemoryStore } from "../../src/memory/store.js";
import { syncMemoryFiles } from "../../src/memory/sync.js";
import type { EmbeddingProvider, HybridSearchConfig } from "../../src/memory/types.js";

/**
 * End-to-end memory pipeline tests.
 *
 * Drives the full real flow: Markdown files on disk → `syncMemoryFiles` →
 * SQLite (chunks + chunks_fts [+ chunks_vec_*]) → `searchMemory` → `memory_get`
 * line slicing. All collaborators are real except the embedding provider, which
 * is a deterministic in-memory mock so tests don't depend on network/local models.
 */

const TODAY = new Date();
const todayStr = `${TODAY.getUTCFullYear()}-${String(TODAY.getUTCMonth() + 1).padStart(2, "0")}-${String(TODAY.getUTCDate()).padStart(2, "0")}`;

const MEMORY_FILES: Record<string, string> = {
	"memory/core.md":
		"## Core Conventions\nThe Cliclaw MainAgent uses a two-state machine (IDLE and EXECUTING).\n" +
		"Tool calls run sequentially. Streaming deltas are broadcast to WebSocket clients.\n",
	"memory/preferences.md":
		"## Preferences\nThe user prefers Chinese for the final summary.\nUse tabs for indentation, width 3.\nAlways prefer const.\n",
	"memory/todos.md":
		"## Open Todos\n- Wire up the new dashboard endpoint\n- Investigate the embedding model regression on Voyage v2\n",
	[`memory/${todayStr}.md`]:
		"## Daily Notes\nDebugged the WebSocket handler. Removed dangling event listeners on close.\n",
};

/**
 * Deterministic mock provider:
 * - Each chunk gets a stable 8-D vector hashed from its text.
 * - Same query string → same vector, so similarity rankings are reproducible.
 */
function createDeterministicProvider(): EmbeddingProvider {
	const hash = (s: string): number[] => {
		const v = new Array(8).fill(0);
		for (let i = 0; i < s.length; i++) {
			v[i % 8] += (s.charCodeAt(i) % 37) / 37;
		}
		// L2 normalize so cosine ≈ dot
		const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
		return v.map((x) => x / norm);
	};
	return {
		id: "mock",
		model: "e2e-mock-v1",
		embedQuery: async (t) => hash(t),
		embedBatch: async (ts) => ts.map(hash),
	};
}

describe("Memory pipeline — end-to-end", () => {
	let tmpDir: string;
	let storageDir: string;
	let store: MemoryStore;
	let provider: EmbeddingProvider;

	const config: HybridSearchConfig = {
		enabled: true,
		vectorWeight: 0.7,
		textWeight: 0.3,
		candidateMultiplier: 3,
	};

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "cliclaw-e2e-"));
		storageDir = join(tmpDir, "storage");
		await mkdir(join(storageDir, "memory"), { recursive: true });
		for (const [rel, content] of Object.entries(MEMORY_FILES)) {
			await writeFile(join(storageDir, rel), content);
		}

		store = new MemoryStore({
			dbPath: join(storageDir, "e2e.sqlite"),
			workspaceDir: tmpDir,
			storageDir,
			vectorEnabled: false, // brute-force vector path covers KNN-equivalent semantics
		});
		provider = createDeterministicProvider();

		const stats = await syncMemoryFiles(store, { embeddingProvider: provider });
		expect(stats.added).toBe(Object.keys(MEMORY_FILES).length);
		expect(stats.chunksIndexed).toBeGreaterThan(0);
	});

	afterEach(async () => {
		store.close();
		await rm(tmpDir, { recursive: true, force: true });
	});

	it("indexes every Markdown file and tracks each path", () => {
		const tracked = store.getTrackedFilePaths().sort();
		expect(tracked).toEqual(Object.keys(MEMORY_FILES).sort());

		const chunkCount = store.getDb().prepare("SELECT COUNT(*) AS c FROM chunks").get() as { c: number };
		expect(chunkCount.c).toBeGreaterThan(0);

		const ftsCount = store.getDb().prepare("SELECT COUNT(*) AS c FROM chunks_fts").get() as { c: number };
		expect(ftsCount.c).toBe(chunkCount.c);
	});

	it("returns relevant ranked results from a real Markdown corpus", async () => {
		const results = await searchMemory(store, "two-state machine", provider, config, {
			maxResults: 5,
			minScore: 0,
		});

		expect(results.length).toBeGreaterThan(0);
		expect(results[0].path).toBe("memory/core.md");
		expect(results[0].snippet).toMatch(/two-state machine/);
		expect(results[0].score).toBeGreaterThan(0);
		// Line numbers must be 1-indexed and span at least one line
		expect(results[0].startLine).toBeGreaterThanOrEqual(1);
		expect(results[0].endLine).toBeGreaterThanOrEqual(results[0].startLine);
	});

	it("memory_get-style line slicing returns the search hit's exact lines", async () => {
		const results = await searchMemory(store, "tabs indentation", provider, config, {
			maxResults: 3,
			minScore: 0,
		});
		const hit = results.find((r) => r.path === "memory/preferences.md");
		expect(hit).toBeDefined();
		const { startLine, endLine } = hit!;

		// Reproduce MainAgent's memory_get logic: read file → slice 1-indexed range
		const absPath = join(storageDir, "memory/preferences.md");
		const content = await readFile(absPath, "utf-8");
		const lines = content.split("\n");
		const slice = lines.slice(startLine - 1, endLine).join("\n");

		expect(slice).toMatch(/Tabs for indentation/i);
	});

	it("category filter restricts results to that category's files", async () => {
		const tracked = store.getTrackedFilePaths();

		const prefFilter = buildCategoryPathFilter("preferences", tracked);
		const prefResults = await searchMemory(store, "indentation", provider, config, {
			maxResults: 10,
			minScore: 0,
			categoryPathFilter: prefFilter,
		});
		expect(prefResults.length).toBeGreaterThan(0);
		for (const r of prefResults) {
			expect(r.path).toBe("memory/preferences.md");
		}

		const dailyFilter = buildCategoryPathFilter("daily", tracked);
		expect(dailyFilter).toEqual([`memory/${todayStr}.md`]);
		const dailyResults = await searchMemory(store, "WebSocket handler", provider, config, {
			maxResults: 10,
			minScore: 0,
			categoryPathFilter: dailyFilter,
		});
		expect(dailyResults.length).toBeGreaterThan(0);
		for (const r of dailyResults) {
			expect(r.path).toBe(`memory/${todayStr}.md`);
		}
	});

	it("an empty category yields no results (no leakage across categories)", async () => {
		// 'people' has no file in this fixture
		const tracked = store.getTrackedFilePaths();
		const peopleFilter = buildCategoryPathFilter("people", tracked);
		expect(peopleFilter).toEqual(["memory/people.md"]);

		// peopleFilter has one path, but that path isn't tracked — KNN/FTS will return nothing
		const results = await searchMemory(store, "anyone", provider, config, {
			maxResults: 10,
			minScore: 0,
			categoryPathFilter: peopleFilter,
		});
		expect(results).toEqual([]);
	});

	it("re-running sync with no file changes is a no-op", async () => {
		const before = store.getDb().prepare("SELECT COUNT(*) AS c FROM chunks").get() as { c: number };

		const stats = await syncMemoryFiles(store, { embeddingProvider: provider });
		expect(stats.added).toBe(0);
		expect(stats.updated).toBe(0);
		expect(stats.deleted).toBe(0);

		const after = store.getDb().prepare("SELECT COUNT(*) AS c FROM chunks").get() as { c: number };
		expect(after.c).toBe(before.c);
	});

	it("editing a file and re-syncing updates only that file's chunks", async () => {
		const original = store.getDb().prepare("SELECT id FROM chunks WHERE path = ?").all("memory/core.md") as {
			id: string;
		}[];
		const otherIdsBefore = store.getDb().prepare("SELECT id FROM chunks WHERE path != ?").all("memory/core.md") as {
			id: string;
		}[];

		await writeFile(
			join(storageDir, "memory/core.md"),
			"## Core Conventions (revised)\nThe MainAgent's two-state machine has been documented further.\nNew section: ContextManager modular sections.\n",
		);

		const stats = await syncMemoryFiles(store, { embeddingProvider: provider });
		expect(stats.updated).toBe(1);
		expect(stats.added).toBe(0);
		expect(stats.deleted).toBe(0);

		const updated = store.getDb().prepare("SELECT id FROM chunks WHERE path = ?").all("memory/core.md") as {
			id: string;
		}[];
		// Old chunk ids for core.md should be gone (re-issued via randomUUID)
		const originalSet = new Set(original.map((r) => r.id));
		for (const r of updated) expect(originalSet.has(r.id)).toBe(false);

		// Other files' chunk ids should be untouched
		const otherIdsAfter = store.getDb().prepare("SELECT id FROM chunks WHERE path != ?").all("memory/core.md") as {
			id: string;
		}[];
		expect(new Set(otherIdsAfter.map((r) => r.id))).toEqual(new Set(otherIdsBefore.map((r) => r.id)));

		// New search should reflect the revised content
		const results = await searchMemory(store, "ContextManager modular", provider, config, {
			maxResults: 3,
			minScore: 0,
		});
		const top = results.find((r) => r.path === "memory/core.md");
		expect(top).toBeDefined();
		expect(top!.snippet).toMatch(/ContextManager modular/);
	});

	it("deleting a file and re-syncing removes its chunks but keeps others", async () => {
		await rm(join(storageDir, "memory/todos.md"));
		const stats = await syncMemoryFiles(store, { embeddingProvider: provider });
		expect(stats.deleted).toBe(1);

		const remaining = store.getTrackedFilePaths();
		expect(remaining).not.toContain("memory/todos.md");
		expect(remaining).toContain("memory/core.md");

		const todoChunks = store.getDb().prepare("SELECT * FROM chunks WHERE path = ?").all("memory/todos.md");
		expect(todoChunks).toHaveLength(0);
	});

	it("FTS-only fallback (no embedding provider) still returns relevant results after sync", async () => {
		// Re-sync without a provider — chunks should still index, just without embeddings
		const ftsTmp = await mkdtemp(join(tmpdir(), "cliclaw-e2e-fts-"));
		try {
			const ftsStorage = join(ftsTmp, "storage");
			await mkdir(join(ftsStorage, "memory"), { recursive: true });
			for (const [rel, content] of Object.entries(MEMORY_FILES)) {
				await writeFile(join(ftsStorage, rel), content);
			}
			const ftsStore = new MemoryStore({
				dbPath: join(ftsStorage, "fts.sqlite"),
				workspaceDir: ftsTmp,
				storageDir: ftsStorage,
				vectorEnabled: false,
			});
			try {
				await syncMemoryFiles(ftsStore, { embeddingProvider: null });
				const results = await searchMemory(ftsStore, "WebSocket handler", null, config, {
					maxResults: 5,
					minScore: 0,
				});
				expect(results.length).toBeGreaterThan(0);
				expect(results.some((r) => r.snippet.includes("WebSocket"))).toBe(true);
			} finally {
				ftsStore.close();
			}
		} finally {
			await rm(ftsTmp, { recursive: true, force: true });
		}
	});

	it("survives a restart: closing and re-opening the store preserves search", async () => {
		const dbPath = join(storageDir, "e2e.sqlite");
		store.close();

		const reopened = new MemoryStore({
			dbPath,
			workspaceDir: tmpDir,
			storageDir,
			vectorEnabled: false,
		});
		try {
			expect(reopened.getTrackedFilePaths().sort()).toEqual(Object.keys(MEMORY_FILES).sort());
			const results = await searchMemory(reopened, "Cliclaw MainAgent", provider, config, {
				maxResults: 3,
				minScore: 0,
			});
			expect(results.length).toBeGreaterThan(0);
			expect(results[0].path).toBe("memory/core.md");
		} finally {
			reopened.close();
			// Re-assign so afterEach's close() is a no-op
			store = reopened;
		}
	});
});
