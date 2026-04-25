import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../../src/memory/store.js";
import { searchMemory, searchKeyword, searchVector, cosineSimilarity } from "../../src/memory/search.js";
import type { EmbeddingProvider, HybridSearchConfig } from "../../src/memory/types.js";
import { logger } from "../../src/utils/logger.js";

// ─── Realistic memory content ────────────────────────────

const MEMORY_CHUNKS = [
	{
		id: "arch-001",
		path: "memory/architecture.md",
		text: "## System Architecture\nThe MainAgent uses a two-state machine (IDLE and EXECUTING). It receives user messages via WebSocket and streams LLM responses back. Tool calls trigger state transitions to EXECUTING mode where tools are run sequentially.",
		embedding: [0.9, 0.1, 0.0, 0.2, 0.0, 0.1, 0.0, 0.0],
	},
	{
		id: "arch-002",
		path: "memory/architecture.md",
		text: "## Memory System\nDual-storage architecture: Markdown files are source of truth, SQLite is the search index. Supports vector KNN search via sqlite-vec and keyword BM25 search via FTS5. Results are merged using weighted hybrid scoring.",
		embedding: [0.2, 0.9, 0.1, 0.0, 0.1, 0.0, 0.0, 0.0],
	},
	{
		id: "pref-001",
		path: "memory/preferences.md",
		text: "## User Preferences\nThe user prefers Chinese responses. Code comments should be in English. Use tabs for indentation with width 3. Always use const instead of let.",
		embedding: [0.0, 0.1, 0.9, 0.0, 0.0, 0.1, 0.0, 0.0],
	},
	{
		id: "debug-001",
		path: "memory/daily/2025-01-15.md",
		text: "## Debugging Session\nFound a memory leak in the WebSocket handler. The connection cleanup was not removing event listeners. Fixed by calling removeAllListeners() in the close handler.",
		embedding: [0.1, 0.0, 0.0, 0.9, 0.1, 0.0, 0.0, 0.0],
	},
	{
		id: "deploy-001",
		path: "memory/operations.md",
		text: "## Deployment Notes\nProduction deployment uses Docker with multi-stage builds. The embedding model is downloaded at startup to avoid runtime delays. Health check endpoint is /api/status.",
		embedding: [0.0, 0.3, 0.0, 0.0, 0.9, 0.0, 0.0, 0.0],
	},
	{
		id: "tmux-001",
		path: "memory/architecture.md",
		text: "## Tmux Integration\nTmuxBridge wraps tmux commands for session management. Sessions are prefixed with 'cliclaw-' for isolation. StateDetector polls pane content and classifies agent state using pattern matching.",
		embedding: [0.7, 0.0, 0.0, 0.1, 0.0, 0.0, 0.2, 0.0],
	},
	{
		id: "skill-001",
		path: "memory/architecture.md",
		text: "## Skill System\nSkills are YAML-fronted Markdown files discovered from adapter and workspace directories. Three types: agent-capability, main-agent-tool, and prompt-enrichment. Skills can register slash commands dynamically.",
		embedding: [0.6, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.9],
	},
];

// ─── Mock embedding provider ─────────────────────────────

/** Simple mock that returns a pre-defined vector based on query keywords */
function createMockEmbeddingProvider(): EmbeddingProvider {
	const queryVectors: Record<string, number[]> = {
		architecture: [0.85, 0.15, 0.0, 0.1, 0.0, 0.1, 0.05, 0.0],
		memory: [0.2, 0.85, 0.1, 0.0, 0.1, 0.0, 0.0, 0.0],
		websocket: [0.7, 0.0, 0.0, 0.6, 0.0, 0.1, 0.0, 0.0],
		deployment: [0.0, 0.2, 0.0, 0.0, 0.9, 0.0, 0.0, 0.0],
		preferences: [0.0, 0.1, 0.9, 0.0, 0.0, 0.1, 0.0, 0.0],
		tmux: [0.6, 0.0, 0.0, 0.1, 0.0, 0.0, 0.3, 0.0],
		skill: [0.5, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.9],
		debugging: [0.1, 0.0, 0.0, 0.85, 0.1, 0.0, 0.0, 0.0],
	};

	return {
		id: "mock",
		model: "mock-embed-v1",
		embedQuery: async (text: string) => {
			const lower = text.toLowerCase();
			for (const [keyword, vec] of Object.entries(queryVectors)) {
				if (lower.includes(keyword)) return vec;
			}
			// Default: uniform vector
			return [0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1];
		},
		embedBatch: async (texts: string[]) => {
			const provider = createMockEmbeddingProvider();
			return Promise.all(texts.map((t) => provider.embedQuery(t)));
		},
	};
}

// ─── Test suite ──────────────────────────────────────────

describe("Memory Hybrid Search Integration", () => {
	let tmpDir: string;
	let storageDir: string;
	let store: MemoryStore;
	let provider: EmbeddingProvider;
	const defaultConfig: HybridSearchConfig = {
		vectorWeight: 0.7,
		textWeight: 0.3,
		candidateMultiplier: 3,
	};

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "cliclaw-search-"));
		storageDir = join(tmpDir, "storage");
		await mkdir(storageDir, { recursive: true });

		store = new MemoryStore({
			dbPath: join(storageDir, "test.sqlite"),
			workspaceDir: tmpDir,
			storageDir,
			vectorEnabled: false, // use brute-force fallback
		});

		// Insert all chunks
		for (const chunk of MEMORY_CHUNKS) {
			store.insertChunk({
				id: chunk.id,
				path: chunk.path,
				startLine: 1,
				endLine: 10,
				hash: `hash-${chunk.id}`,
				model: "mock-embed-v1",
				text: chunk.text,
				embedding: chunk.embedding,
			});
		}

		provider = createMockEmbeddingProvider();
	});

	afterEach(async () => {
		store.close();
		await rm(tmpDir, { recursive: true, force: true });
	});

	// ─── FTS keyword search ──────────────────────────────

	describe("keyword search (FTS5)", () => {
		it("should find chunks by exact keyword", () => {
			const results = searchKeyword(store, "WebSocket", 10);
			expect(results.length).toBeGreaterThan(0);
			const texts = results.map((r) => r.snippet);
			expect(texts.some((t) => t.includes("WebSocket"))).toBe(true);
		});

		it("should find chunks by multiple keywords (AND)", () => {
			const results = searchKeyword(store, "memory SQLite", 10);
			expect(results.length).toBeGreaterThan(0);
			// Should match the memory system chunk which has both keywords
			expect(results.some((r) => r.id === "arch-002")).toBe(true);
		});

		it("should return empty for non-matching query", () => {
			const results = searchKeyword(store, "kubernetes helm chart", 10);
			expect(results).toHaveLength(0);
		});

		it("should rank more relevant matches higher", () => {
			const results = searchKeyword(store, "embedding model startup", 10);
			expect(results.length).toBeGreaterThan(0);
			// deploy-001 mentions "embedding model" and "startup"
			const deployIdx = results.findIndex((r) => r.id === "deploy-001");
			expect(deployIdx).toBeGreaterThanOrEqual(0);
		});

		it("should respect result limit", () => {
			const results = searchKeyword(store, "the", 2);
			expect(results.length).toBeLessThanOrEqual(2);
		});
	});

	// ─── Vector search (brute-force) ─────────────────────

	describe("vector search (brute-force)", () => {
		it("should find semantically similar chunks", () => {
			// Query vector close to architecture chunks
			const queryVec = [0.85, 0.15, 0.0, 0.1, 0.0, 0.1, 0.05, 0.0];
			const results = searchVector(store, queryVec, "mock-embed-v1", 5);

			expect(results.length).toBeGreaterThan(0);
			// arch-001 and tmux-001 should rank high (high first-dimension values)
			const topIds = results.slice(0, 3).map((r) => r.id);
			expect(topIds).toContain("arch-001");
		});

		it("should return scores between 0 and 1", () => {
			const queryVec = [0.5, 0.5, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0];
			const results = searchVector(store, queryVec, "mock-embed-v1", 10);

			for (const r of results) {
				expect(r.vectorScore).toBeGreaterThanOrEqual(0);
				expect(r.vectorScore).toBeLessThanOrEqual(1);
			}
		});

		it("should only match chunks with the correct model", () => {
			const queryVec = [0.9, 0.1, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0];
			const results = searchVector(store, queryVec, "non-existent-model", 10);
			expect(results).toHaveLength(0);
		});

		it("should respect limit", () => {
			const queryVec = [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5];
			const results = searchVector(store, queryVec, "mock-embed-v1", 3);
			expect(results.length).toBeLessThanOrEqual(3);
		});
	});

	// ─── Hybrid search (full pipeline) ───────────────────

	describe("hybrid search (searchMemory)", () => {
		it("should combine vector and keyword signals", async () => {
			const results = await searchMemory(store, "architecture", provider, defaultConfig, {
				maxResults: 5,
			});

			expect(results.length).toBeGreaterThan(0);
			// arch-001 should rank high: strong vector match + keyword match
			expect(results[0].snippet).toContain("MainAgent");
		});

		it("should boost dual-hit chunks over single-signal matches", async () => {
			// "memory" matches arch-002 by both keyword and vector
			const results = await searchMemory(store, "memory", provider, defaultConfig, {
				maxResults: 5,
			});

			expect(results.length).toBeGreaterThan(0);
			// arch-002 (Memory System) should rank very high as dual hit
			const memorySystemResult = results.find((r) => r.snippet.includes("Dual-storage"));
			expect(memorySystemResult).toBeDefined();
			expect(results.indexOf(memorySystemResult!)).toBeLessThan(3);
		});

		it("should find results even with keyword-only matches", async () => {
			// "Docker" only appears in deploy-001, no strong vector signal for generic query
			const results = await searchMemory(store, "deployment", provider, defaultConfig, {
				maxResults: 5,
			});

			const deployResult = results.find((r) => r.snippet.includes("Docker"));
			expect(deployResult).toBeDefined();
		});

		it("should return results with plain path (no project prefix)", async () => {
			const results = await searchMemory(store, "architecture", provider, defaultConfig);

			for (const r of results) {
				expect(r.path).toMatch(/^memory\//);
			}
		});

		it("should filter by minScore", async () => {
			const results = await searchMemory(store, "architecture", provider, defaultConfig, {
				maxResults: 10,
				minScore: 0.5,
			});

			for (const r of results) {
				expect(r.score).toBeGreaterThanOrEqual(0.5);
			}
		});

		it("should handle empty query gracefully", async () => {
			// Empty query still yields vector results (mock returns uniform vec),
			// but keyword side returns nothing — so scores should be lower than specific queries
			const results = await searchMemory(store, "", provider, defaultConfig);
			const specificResults = await searchMemory(store, "architecture", provider, defaultConfig);
			if (results.length > 0 && specificResults.length > 0) {
				expect(specificResults[0].score).toBeGreaterThan(results[0].score);
			}
		});

		it("should return no results when categoryPathFilter is explicitly empty", async () => {
			// Regression: when a category like 'daily' yields no matching files,
			// buildCategoryPathFilter returns []. Earlier behavior treated [] the same as
			// undefined and returned ALL files — leaking results across categories.
			const results = await searchMemory(store, "architecture", provider, defaultConfig, {
				maxResults: 5,
				categoryPathFilter: [],
			});
			expect(results).toEqual([]);

			// FTS-only path must also short-circuit
			const ftsOnly = await searchMemory(store, "architecture", null, defaultConfig, {
				maxResults: 5,
				categoryPathFilter: [],
			});
			expect(ftsOnly).toEqual([]);
		});

		it("should respect a non-empty categoryPathFilter", async () => {
			// Filter to only the architecture file — preferences/operations chunks must be excluded.
			const results = await searchMemory(store, "architecture", provider, defaultConfig, {
				maxResults: 10,
				categoryPathFilter: ["memory/architecture.md"],
			});
			expect(results.length).toBeGreaterThan(0);
			for (const r of results) {
				expect(r.path).toBe("memory/architecture.md");
			}
		});
	});

	// ─── FTS-only mode (no embedding provider) ───────────

	describe("FTS-only mode (no embedding provider)", () => {
		it("should fall back to keyword-only search", async () => {
			const results = await searchMemory(store, "WebSocket handler", null, defaultConfig, {
				maxResults: 5,
			});

			expect(results.length).toBeGreaterThan(0);
			expect(results.some((r) => r.snippet.includes("WebSocket"))).toBe(true);
		});

		it("should still return scored results", async () => {
			const results = await searchMemory(store, "tmux session", null, defaultConfig);

			expect(results.length).toBeGreaterThan(0);
			for (const r of results) {
				expect(r.score).toBeGreaterThan(0);
			}
		});
	});

	// ─── Weight tuning ───────────────────────────────────

	describe("weight configuration", () => {
		it("should favor vector results with high vectorWeight", async () => {
			const vectorHeavy: HybridSearchConfig = { vectorWeight: 0.95, textWeight: 0.05, candidateMultiplier: 3 };
			const results = await searchMemory(store, "debugging", provider, vectorHeavy, { maxResults: 5 });

			// With vector-heavy config, debug-001 should rank at top (strong vector match)
			expect(results.length).toBeGreaterThan(0);
			expect(results[0].snippet).toContain("memory leak");
		});

		it("should favor keyword results with high textWeight", async () => {
			const textHeavy: HybridSearchConfig = { vectorWeight: 0.05, textWeight: 0.95, candidateMultiplier: 3 };
			const results = await searchMemory(store, "skill YAML Markdown", provider, textHeavy, { maxResults: 5 });

			// With text-heavy config, keyword matches should dominate
			expect(results.length).toBeGreaterThan(0);
			// skill-001 mentions all three keywords
			expect(results[0].snippet).toContain("YAML");
		});
	});

	// ─── Cross-topic queries ─────────────────────────────

	describe("cross-topic retrieval", () => {
		it("should retrieve relevant chunks across different files", async () => {
			const results = await searchMemory(store, "websocket", provider, defaultConfig, { maxResults: 5 });

			// Should find both arch-001 (WebSocket in architecture) and debug-001 (WebSocket handler bug)
			const ids = results.map((r) => {
				const match = r.snippet.match(/WebSocket/);
				return match ? true : false;
			});
			expect(ids.filter(Boolean).length).toBeGreaterThanOrEqual(1);
		});

		it("should return distinct chunks (no duplicates)", async () => {
			const results = await searchMemory(store, "architecture memory", provider, defaultConfig, {
				maxResults: 10,
			});

			const snippets = new Set(results.map((r) => r.snippet));
			expect(snippets.size).toBe(results.length);
		});
	});

	// ─── Vector search via sqlite-vec KNN ────────────────

	describe("vector search (sqlite-vec KNN)", () => {
		let knnDir: string;
		let knnStore: MemoryStore;

		beforeEach(async () => {
			knnDir = await mkdtemp(join(tmpdir(), "cliclaw-knn-"));
			const knnStorage = join(knnDir, "storage");
			await mkdir(knnStorage, { recursive: true });

			knnStore = new MemoryStore({
				dbPath: join(knnStorage, "knn.sqlite"),
				workspaceDir: knnDir,
				storageDir: knnStorage,
				vectorEnabled: true,
			});

			if (!knnStore.isVecAvailable()) {
				return; // sqlite-vec not loadable in this environment — covered by brute-force tests
			}

			knnStore.initVecTable("mock-embed-v1", 8);
			for (const chunk of MEMORY_CHUNKS) {
				knnStore.insertChunk({
					id: chunk.id,
					path: chunk.path,
					startLine: 1,
					endLine: 10,
					hash: `hash-${chunk.id}`,
					model: "mock-embed-v1",
					text: chunk.text,
					embedding: chunk.embedding,
				});
			}
		});

		afterEach(async () => {
			knnStore.close();
			await rm(knnDir, { recursive: true, force: true });
		});

		it("should execute the KNN path without ReferenceError and return ranked results", () => {
			if (!knnStore.isVecAvailable()) return; // skip when extension unavailable

			const knnFailures: string[] = [];
			const unsubscribe = logger.subscribe((entry) => {
				if (entry.module === "memory-search" && entry.message.includes("Vec KNN search failed")) {
					knnFailures.push(entry.message);
				}
			});

			try {
				const queryVec = [0.85, 0.15, 0.0, 0.1, 0.0, 0.1, 0.05, 0.0];
				const results = searchVector(knnStore, queryVec, "mock-embed-v1", 5);

				expect(results.length).toBeGreaterThan(0);
				expect(results[0].vectorScore).toBeGreaterThanOrEqual(results[results.length - 1].vectorScore);
				// arch-001 has near-identical embedding → must be top-ranked
				expect(results[0].id).toBe("arch-001");
				// KNN must succeed without falling back to brute-force
				expect(knnFailures).toEqual([]);
			} finally {
				unsubscribe();
			}
		});

		it("should restore vecTableName after reopen so KNN survives restart", () => {
			if (!knnStore.isVecAvailable()) return;

			const dbPath = join(knnDir, "storage", "knn.sqlite");
			const tableBeforeClose = knnStore.getVecTableName();
			expect(tableBeforeClose).toBe("chunks_vec_mock_embed_v1_8");
			knnStore.close();

			// Reopen — sync would NOT call initVecTable when nothing changed,
			// so the constructor must restore the name from sqlite_master itself.
			knnStore = new MemoryStore({
				dbPath,
				workspaceDir: knnDir,
				storageDir: join(knnDir, "storage"),
				vectorEnabled: true,
			});

			expect(knnStore.getVecTableName()).toBe(tableBeforeClose);

			const knnFailures: string[] = [];
			const unsubscribe = logger.subscribe((entry) => {
				if (entry.module === "memory-search" && entry.message.includes("Vec KNN search failed")) {
					knnFailures.push(entry.message);
				}
			});

			try {
				const results = searchVector(
					knnStore,
					[0.85, 0.15, 0.0, 0.1, 0.0, 0.1, 0.05, 0.0],
					"mock-embed-v1",
					5,
				);
				expect(results[0].id).toBe("arch-001");
				expect(knnFailures).toEqual([]);
			} finally {
				unsubscribe();
			}
		});
	});

	// ─── Cosine similarity edge cases ────────────────────

	describe("cosineSimilarity", () => {
		it("should return 1 for identical vectors", () => {
			expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1.0);
		});

		it("should return 0 for orthogonal vectors", () => {
			expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0.0);
		});

		it("should return -1 for opposite vectors", () => {
			expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1.0);
		});

		it("should return 0 for zero-length vectors", () => {
			expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
			expect(cosineSimilarity([1, 1], [0, 0])).toBe(0);
		});

		it("should handle high-dimensional vectors", () => {
			const a = Array(768).fill(0).map((_, i) => Math.sin(i));
			const b = Array(768).fill(0).map((_, i) => Math.sin(i + 0.1));
			const sim = cosineSimilarity(a, b);
			expect(sim).toBeGreaterThan(0.9); // Very similar
			expect(sim).toBeLessThan(1.0);
		});
	});
});
