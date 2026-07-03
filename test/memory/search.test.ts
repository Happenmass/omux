import { describe, expect, it } from "vitest";
import {
	applyTemporalDecay,
	bm25RankToScore,
	buildFtsQuery,
	calculateTemporalDecayMultiplier,
	cosineSimilarity,
	mergeHybridResults,
} from "../../src/memory/search.js";
import type { HybridKeywordResult, HybridVectorResult, MergedResult } from "../../src/memory/types.js";

describe("buildFtsQuery", () => {
	it("should construct AND query from words", () => {
		expect(buildFtsQuery("deploy staging config")).toBe('"deploy" AND "staging" AND "config"');
	});

	it("should handle single word", () => {
		expect(buildFtsQuery("auth")).toBe('"auth"');
	});

	it("should return null for empty query", () => {
		expect(buildFtsQuery("")).toBeNull();
	});

	it("should return null for punctuation-only query", () => {
		expect(buildFtsQuery("!@#$%^&*()")).toBeNull();
	});

	it("should extract tokens from mixed content", () => {
		expect(buildFtsQuery("hello, world! (test)")).toBe('"hello" AND "world" AND "test"');
	});

	it("should strip quotes from tokens", () => {
		expect(buildFtsQuery('"quoted"')).toBe('"quoted"');
	});
});

describe("bm25RankToScore", () => {
	it("should convert rank 0 to score 0 (no relevance)", () => {
		expect(bm25RankToScore(0)).toBe(0);
	});

	it("should convert negative rank (FTS5 convention) to score", () => {
		// FTS5 BM25 returns negative values; more negative = more relevant.
		// Map monotonically so more-negative rank → higher score.
		const score = bm25RankToScore(-5);
		expect(score).toBeCloseTo(5 / (1 + 5), 5);
	});

	it("should convert positive rank to score 0 (treated as non-relevant)", () => {
		expect(bm25RankToScore(1)).toBe(0);
	});

	it("should produce HIGHER scores for more-negative rank (better match)", () => {
		// More negative bm25 rank = better match → must map to a higher score.
		expect(bm25RankToScore(-10)).toBeGreaterThan(bm25RankToScore(-1));
	});

	it("should stay within (0, 1] for negative ranks", () => {
		expect(bm25RankToScore(-1)).toBeGreaterThan(0);
		expect(bm25RankToScore(-1000)).toBeLessThanOrEqual(1);
		expect(bm25RankToScore(-1000)).toBeGreaterThan(bm25RankToScore(-10));
	});
});

describe("mergeHybridResults", () => {
	it("should merge dual-hit chunks with combined score", () => {
		const vector: HybridVectorResult[] = [
			{
				id: "c1",
				path: "memory/core.md",
				startLine: 1,
				endLine: 5,
				snippet: "text",
				source: "memory",
				vectorScore: 0.8,
			},
		];
		const keyword: HybridKeywordResult[] = [
			{
				id: "c1",
				path: "memory/core.md",
				startLine: 1,
				endLine: 5,
				snippet: "text",
				source: "memory",
				textScore: 0.6,
			},
		];

		const result = mergeHybridResults({ vector, keyword, vectorWeight: 0.7, textWeight: 0.3 });
		expect(result).toHaveLength(1);
		expect(result[0].score).toBeCloseTo(0.7 * 0.8 + 0.3 * 0.6, 5);
		expect(result[0].path).toBe("memory/core.md");
	});

	it("should handle vector-only hits", () => {
		const vector: HybridVectorResult[] = [
			{
				id: "c1",
				path: "memory/core.md",
				startLine: 1,
				endLine: 1,
				snippet: "t",
				source: "memory",
				vectorScore: 0.8,
			},
		];
		const result = mergeHybridResults({ vector, keyword: [], vectorWeight: 0.7, textWeight: 0.3 });
		expect(result[0].score).toBeCloseTo(0.7 * 0.8, 5);
	});

	it("should handle keyword-only hits", () => {
		const keyword: HybridKeywordResult[] = [
			{ id: "c2", path: "memory/core.md", startLine: 1, endLine: 1, snippet: "t", source: "memory", textScore: 0.6 },
		];
		const result = mergeHybridResults({ vector: [], keyword, vectorWeight: 0.7, textWeight: 0.3 });
		expect(result[0].score).toBeCloseTo(0.3 * 0.6, 5);
	});

	it("should handle empty inputs", () => {
		const result = mergeHybridResults({ vector: [], keyword: [], vectorWeight: 0.7, textWeight: 0.3 });
		expect(result).toHaveLength(0);
	});

	it("should merge chunks from different files", () => {
		const vector: HybridVectorResult[] = [
			{
				id: "c1",
				path: "memory/core.md",
				startLine: 1,
				endLine: 5,
				snippet: "t1",
				source: "memory",
				vectorScore: 0.9,
			},
			{
				id: "c2",
				path: "memory/todos.md",
				startLine: 1,
				endLine: 5,
				snippet: "t2",
				source: "memory",
				vectorScore: 0.5,
			},
		];
		const keyword: HybridKeywordResult[] = [
			{
				id: "c2",
				path: "memory/todos.md",
				startLine: 1,
				endLine: 5,
				snippet: "t2",
				source: "memory",
				textScore: 0.7,
			},
			{
				id: "c3",
				path: "memory/preferences.md",
				startLine: 1,
				endLine: 5,
				snippet: "t3",
				source: "memory",
				textScore: 0.3,
			},
		];

		const result = mergeHybridResults({ vector, keyword, vectorWeight: 0.7, textWeight: 0.3 });
		expect(result).toHaveLength(3);

		const c1 = result.find((r) => r.path === "memory/core.md")!;
		const c2 = result.find((r) => r.path === "memory/todos.md")!;
		const c3 = result.find((r) => r.path === "memory/preferences.md")!;

		expect(c1.score).toBeCloseTo(0.7 * 0.9, 5); // Vector only
		expect(c2.score).toBeCloseTo(0.7 * 0.5 + 0.3 * 0.7, 5); // Both paths
		expect(c3.score).toBeCloseTo(0.3 * 0.3, 5); // Keyword only
	});
});

describe("applyTemporalDecay", () => {
	it("should not decay evergreen files", () => {
		const results: MergedResult[] = [
			{ path: "memory/core.md", startLine: 1, endLine: 5, score: 0.8, snippet: "t", source: "memory" },
		];
		const decayed = applyTemporalDecay(results, { enabled: true, halfLifeDays: 30 });
		expect(decayed[0].score).toBe(0.8);
	});

	it("should decay 30-day-old daily log by ~50%", () => {
		const results: MergedResult[] = [
			{ path: "memory/2024-01-15.md", startLine: 1, endLine: 5, score: 0.8, snippet: "t", source: "memory" },
		];
		const now = new Date("2024-02-14");
		const decayed = applyTemporalDecay(results, { enabled: true, halfLifeDays: 30 }, now);
		expect(decayed[0].score).toBeCloseTo(0.8 * 0.5, 1);
	});

	it("should not decay when disabled", () => {
		const results: MergedResult[] = [
			{ path: "memory/2024-01-15.md", startLine: 1, endLine: 5, score: 0.8, snippet: "t", source: "memory" },
		];
		const now = new Date("2024-03-15");
		const decayed = applyTemporalDecay(results, { enabled: false, halfLifeDays: 30 }, now);
		expect(decayed[0].score).toBe(0.8);
	});

	it("should decay more for older files", () => {
		const results: MergedResult[] = [
			{ path: "memory/2024-01-15.md", startLine: 1, endLine: 5, score: 0.8, snippet: "t1", source: "memory" },
			{ path: "memory/2024-02-10.md", startLine: 1, endLine: 5, score: 0.8, snippet: "t2", source: "memory" },
		];
		const now = new Date("2024-02-15");
		const decayed = applyTemporalDecay(results, { enabled: true, halfLifeDays: 30 }, now);
		// Jan 15 is older than Feb 10 → should have lower score
		expect(decayed[0].score).toBeLessThan(decayed[1].score);
	});

	it("should not decay future dates (age <= 0)", () => {
		const results: MergedResult[] = [
			{ path: "memory/2024-12-31.md", startLine: 1, endLine: 5, score: 0.8, snippet: "t", source: "memory" },
		];
		const now = new Date("2024-01-01");
		const decayed = applyTemporalDecay(results, { enabled: true, halfLifeDays: 30 }, now);
		expect(decayed[0].score).toBe(0.8); // No decay for future dates
	});
});

describe("calculateTemporalDecayMultiplier", () => {
	it("should return 1.0 for age 0", () => {
		expect(calculateTemporalDecayMultiplier(0, 30)).toBe(1.0);
	});

	it("should return ~0.5 at half-life", () => {
		expect(calculateTemporalDecayMultiplier(30, 30)).toBeCloseTo(0.5, 2);
	});

	it("should return ~0.25 at 2x half-life", () => {
		expect(calculateTemporalDecayMultiplier(60, 30)).toBeCloseTo(0.25, 2);
	});
});

describe("cosineSimilarity", () => {
	it("should return 1.0 for identical vectors", () => {
		expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1.0, 5);
	});

	it("should return 0.0 for orthogonal vectors", () => {
		expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0.0, 5);
	});

	it("should return -1.0 for opposite vectors", () => {
		expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1.0, 5);
	});

	it("should handle empty vectors", () => {
		expect(cosineSimilarity([], [])).toBe(0);
	});

	it("should handle length mismatch", () => {
		expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
	});

	it("should handle zero vectors", () => {
		expect(cosineSimilarity([0, 0], [1, 0])).toBe(0);
	});
});
