import { logger } from "../utils/logger.js";
import { type MemoryStore, vectorToBlob } from "./store.js";
import type {
	EmbeddingProvider,
	HybridKeywordResult,
	HybridSearchConfig,
	HybridVectorResult,
	MemorySearchResult,
	MergedResult,
} from "./types.js";

// ─── Main Search Function ───────────────────────────────

export interface SearchOptions {
	/** Maximum number of results to return (default 10) */
	maxResults?: number;
	/** Minimum score threshold (default 0.1) */
	minScore?: number;
	/** Category filter — only search chunks from files matching this category */
	categoryPathFilter?: string[];
}

/**
 * Execute hybrid search (vector + keyword) on the memory store.
 *
 * When no embedding provider is available, falls back to FTS-only mode.
 * When FTS is also unavailable, returns empty results.
 */
export async function searchMemory(
	store: MemoryStore,
	query: string,
	provider: EmbeddingProvider | null,
	config: HybridSearchConfig,
	opts: SearchOptions = {},
): Promise<MemorySearchResult[]> {
	const maxResults = opts.maxResults ?? 10;
	const minScore = opts.minScore ?? 0.1;
	const candidates = maxResults * (config.candidateMultiplier ?? 3);

	// An explicit-but-empty category filter means "the user asked for a category that
	// has no matching files". Returning all-files results would be wrong; return [].
	if (opts.categoryPathFilter !== undefined && opts.categoryPathFilter.length === 0) {
		return [];
	}

	// FTS-only mode when no embedding provider
	if (!provider) {
		if (!store.isFtsAvailable()) {
			return [];
		}
		const ftsResults = searchKeyword(store, query, candidates, opts.categoryPathFilter);
		const merged: MergedResult[] = ftsResults.map((r) => ({
			path: r.path,
			startLine: r.startLine,
			endLine: r.endLine,
			score: r.textScore, // Full weight to text score
			snippet: r.snippet,
			source: r.source,
		}));
		return postProcess(merged, config, maxResults, minScore);
	}

	// Dual-path hybrid search
	const queryEmbedding = await provider.embedQuery(query);

	const [vectorResults, keywordResults] = await Promise.all([
		searchVector(store, queryEmbedding, provider.model, candidates, opts.categoryPathFilter),
		store.isFtsAvailable()
			? searchKeyword(store, query, candidates, opts.categoryPathFilter)
			: ([] as HybridKeywordResult[]),
	]);

	const merged = mergeHybridResults({
		vector: vectorResults,
		keyword: keywordResults,
		vectorWeight: config.vectorWeight,
		textWeight: config.textWeight,
	});

	return postProcess(merged, config, maxResults, minScore);
}

// ─── Vector Search ──────────────────────────────────────

/**
 * Execute vector search using sqlite-vec KNN or brute-force fallback.
 */
export function searchVector(
	store: MemoryStore,
	queryVec: number[],
	model: string,
	limit: number,
	categoryPathFilter?: string[],
): HybridVectorResult[] {
	const db = store.getDb();
	const vecTableName = store.getVecTableName();

	if (store.isVecAvailable() && vecTableName) {
		return searchVectorKNN(db, queryVec, model, limit, vecTableName, categoryPathFilter);
	}

	// Brute-force fallback: load all embeddings, compute cosine similarity
	return searchVectorBruteForce(db, queryVec, model, limit, categoryPathFilter);
}

function searchVectorKNN(
	db: any,
	queryVec: number[],
	model: string,
	limit: number,
	vecTableName: string,
	categoryPathFilter?: string[],
): HybridVectorResult[] {
	try {
		const vecBlob = vectorToBlob(queryVec);

		let sql = `
			SELECT c.id, c.path, c.start_line, c.end_line, c.text, c.source,
					 vec_distance_cosine(v.embedding, ?) AS dist
			FROM ${vecTableName} v
			JOIN chunks c ON c.id = v.id
			WHERE c.model = ?`;

		const params: any[] = [vecBlob, model];

		if (categoryPathFilter && categoryPathFilter.length > 0) {
			const placeholders = categoryPathFilter.map(() => "?").join(",");
			sql += ` AND c.path IN (${placeholders})`;
			params.push(...categoryPathFilter);
		}

		sql += ` ORDER BY dist ASC LIMIT ?`;
		params.push(limit);

		const rows = db.prepare(sql).all(...params) as any[];
		return rows.map((r) => ({
			id: r.id,
			path: r.path,
			startLine: r.start_line,
			endLine: r.end_line,
			snippet: r.text,
			source: r.source,
			vectorScore: 1 - (r.dist as number),
		}));
	} catch (err: any) {
		logger.warn("memory-search", `Vec KNN search failed, falling back to brute-force: ${err.message}`);
		return searchVectorBruteForce(db, queryVec, model, limit, categoryPathFilter);
	}
}

function searchVectorBruteForce(
	db: any,
	queryVec: number[],
	model: string,
	limit: number,
	categoryPathFilter?: string[],
): HybridVectorResult[] {
	let sql = `SELECT id, path, start_line, end_line, text, embedding, source
		FROM chunks WHERE model = ?`;

	const params: any[] = [model];

	if (categoryPathFilter && categoryPathFilter.length > 0) {
		const placeholders = categoryPathFilter.map(() => "?").join(",");
		sql += ` AND path IN (${placeholders})`;
		params.push(...categoryPathFilter);
	}

	const rows = db.prepare(sql).all(...params) as any[];

	const scored = rows
		.map((r) => {
			const embedding = JSON.parse(r.embedding) as number[];
			if (embedding.length === 0) return null;
			return {
				id: r.id as string,
				path: r.path as string,
				startLine: r.start_line as number,
				endLine: r.end_line as number,
				snippet: r.text as string,
				source: r.source as string,
				vectorScore: cosineSimilarity(queryVec, embedding),
			};
		})
		.filter((r): r is HybridVectorResult => r !== null);

	scored.sort((a, b) => b.vectorScore - a.vectorScore);
	return scored.slice(0, limit);
}

// ─── Keyword Search (FTS5) ──────────────────────────────

/**
 * Flat relevance score for LIKE-only keyword hits.
 *
 * When every query term is a short (2-char) CJK word, the trigram index cannot
 * match it, so we fall back to a substring `LIKE` scan that has no bm25 signal
 * to rank by. A `LIKE` hit is an exact substring match (high precision), and
 * the value must clear the merged `minScore` (0.1) even at the default 0.3
 * keyword weight (0.3 * 0.6 = 0.18 ≥ 0.1).
 */
const LIKE_ONLY_SCORE = 0.6;

/** Detect CJK (Han / Kana / Hangul) so segmentation is only paid for when needed. */
function isCjkText(s: string): boolean {
	return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(s);
}

let cachedSegmenter: Intl.Segmenter | null | undefined;
/**
 * Word-granularity segmenter for CJK queries. `Intl.Segmenter` (Node 16+) does
 * dictionary-based CJK word splitting with zero dependencies. Memoized; returns
 * null if the runtime lacks ICU word data, in which case callers treat each
 * whitespace-free CJK run as a single term (degraded but still functional).
 */
function cjkSegmenter(): Intl.Segmenter | null {
	if (cachedSegmenter === undefined) {
		try {
			cachedSegmenter = new Intl.Segmenter("zh", { granularity: "word" });
		} catch {
			cachedSegmenter = null;
		}
	}
	return cachedSegmenter;
}

/** Escape SQLite LIKE metacharacters (%, _, \) for use with `ESCAPE '\'`. */
function escapeLikePattern(term: string): string {
	return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export interface QueryAnalysis {
	/** FTS5 MATCH expression for terms >= 3 chars (trigram-indexable), or null. */
	match: string | null;
	/** 2-char terms the trigram index can't match; handled via LIKE substring scan. */
	likeTerms: string[];
}

/**
 * Split a raw query into keyword terms, CJK-aware.
 *
 * The chunks_fts trigram tokenizer only indexes 3-character windows, so it
 * cannot match 1-2 char terms and treats a whitespace-free CJK run as one rigid
 * phrase (e.g. it misses "中文" + "处理" when they are non-adjacent). We segment
 * CJK runs into words via Intl.Segmenter, then route each term:
 *   - >= 3 chars → an FTS5 MATCH phrase (keeps bm25 ranking)
 *   - == 2 chars → a LIKE substring fallback (common Chinese words / names)
 *   - 1 char     → dropped (particles; too noisy to AND as a hard filter)
 */
export function analyzeQuery(raw: string): QueryAnalysis {
	const runs = raw.match(/[\p{L}\p{N}_]+/gu) ?? [];
	const matchTerms: string[] = [];
	const likeTerms: string[] = [];
	const seen = new Set<string>();

	const addTerm = (term: string): void => {
		const t = term.trim();
		if (!t) return;
		const len = [...t].length; // code points: one per Han char
		if (len < 2) return;
		const key = t.toLowerCase();
		if (seen.has(key)) return;
		seen.add(key);
		if (len >= 3) matchTerms.push(t);
		else likeTerms.push(t);
	};

	for (const run of runs) {
		const segmenter = isCjkText(run) ? cjkSegmenter() : null;
		if (segmenter) {
			for (const seg of segmenter.segment(run)) {
				if (seg.isWordLike) addTerm(seg.segment);
			}
		} else {
			addTerm(run);
		}
	}

	const match = matchTerms.length > 0 ? matchTerms.map((t) => `"${t.replaceAll('"', "")}"`).join(" AND ") : null;
	return { match, likeTerms };
}

/**
 * Execute FTS5 keyword search on chunks_fts, with a CJK-aware LIKE fallback for
 * short terms the trigram index cannot reach.
 */
export function searchKeyword(
	store: MemoryStore,
	query: string,
	limit: number,
	categoryPathFilter?: string[],
): HybridKeywordResult[] {
	const { match, likeTerms } = analyzeQuery(query);
	if (!match && likeTerms.length === 0) return [];

	const db = store.getDb();
	const catFilter = categoryPathFilter && categoryPathFilter.length > 0 ? categoryPathFilter : null;
	const catClause = catFilter ? ` AND path IN (${catFilter.map(() => "?").join(",")})` : "";

	try {
		if (match) {
			// bm25-ranked MATCH; short CJK terms narrow it as LIKE filters.
			let sql = `SELECT id, path, source, start_line, end_line, text,
							 bm25(chunks_fts) AS rank
						FROM chunks_fts
						WHERE chunks_fts MATCH ?`;
			const params: any[] = [match];
			for (const t of likeTerms) {
				sql += ` AND text LIKE ? ESCAPE '\\'`;
				params.push(`%${escapeLikePattern(t)}%`);
			}
			sql += catClause;
			if (catFilter) params.push(...catFilter);
			sql += ` ORDER BY rank ASC LIMIT ?`;
			params.push(limit);

			const rows = db.prepare(sql).all(...params) as any[];
			return rows.map((r) => ({
				id: r.id as string,
				path: r.path as string,
				startLine: r.start_line as number,
				endLine: r.end_line as number,
				snippet: r.text as string,
				source: r.source as string,
				textScore: bm25RankToScore(r.rank as number),
			}));
		}

		// LIKE-only: every term is a short CJK word the trigram index can't match.
		// No bm25 signal, so surface shorter (denser) chunks first at a flat score.
		let sql = `SELECT id, path, source, start_line, end_line, text
					FROM chunks_fts
					WHERE ${likeTerms.map(() => "text LIKE ? ESCAPE '\\'").join(" AND ")}`;
		const params: any[] = likeTerms.map((t) => `%${escapeLikePattern(t)}%`);
		sql += catClause;
		if (catFilter) params.push(...catFilter);
		sql += ` ORDER BY length(text) ASC LIMIT ?`;
		params.push(limit);

		const rows = db.prepare(sql).all(...params) as any[];
		return rows.map((r) => ({
			id: r.id as string,
			path: r.path as string,
			startLine: r.start_line as number,
			endLine: r.end_line as number,
			snippet: r.text as string,
			source: r.source as string,
			textScore: LIKE_ONLY_SCORE,
		}));
	} catch (err: any) {
		logger.warn("memory-search", `FTS search failed: ${err.message}`);
		return [];
	}
}

/**
 * Convert a natural-language query to an FTS5 MATCH expression.
 *
 * Back-compat wrapper over {@link analyzeQuery}: returns only the MATCH part
 * (terms >= 3 chars). The short-term LIKE fallback lives in {@link searchKeyword}.
 */
export function buildFtsQuery(raw: string): string | null {
	return analyzeQuery(raw).match;
}

/**
 * Convert a BM25 rank value to a 0-1 relevance score.
 *
 * SQLite FTS5 `bm25()` returns values where MORE NEGATIVE = BETTER match.
 * We map that to a monotonically increasing score in (0, 1] where a
 * more-negative rank yields a HIGHER score, so that sorting by score
 * descending matches sorting by rank ascending (the FTS convention).
 *
 * - rank = 0        → score 0 (no relevance)
 * - rank = -1       → score 0.5
 * - rank → -∞       → score → 1
 * - rank > 0 (rare) → score 0 (treated as non-relevant)
 */
export function bm25RankToScore(rank: number): number {
	if (rank >= 0) return 0;
	const magnitude = Math.abs(rank);
	return magnitude / (1 + magnitude);
}

// ─── Result Merging ─────────────────────────────────────

/**
 * Merge vector and keyword search results by chunk ID.
 * Chunks hit by both paths receive combined scores.
 */
export function mergeHybridResults(params: {
	vector: HybridVectorResult[];
	keyword: HybridKeywordResult[];
	vectorWeight: number;
	textWeight: number;
}): MergedResult[] {
	const byId = new Map<
		string,
		{
			path: string;
			startLine: number;
			endLine: number;
			snippet: string;
			source: string;
			vectorScore: number;
			textScore: number;
		}
	>();

	// Add vector results
	for (const r of params.vector) {
		byId.set(r.id, {
			path: r.path,
			startLine: r.startLine,
			endLine: r.endLine,
			snippet: r.snippet,
			source: r.source,
			vectorScore: r.vectorScore,
			textScore: 0,
		});
	}

	// Merge keyword results
	for (const r of params.keyword) {
		const existing = byId.get(r.id);
		if (existing) {
			existing.textScore = r.textScore;
		} else {
			byId.set(r.id, {
				path: r.path,
				startLine: r.startLine,
				endLine: r.endLine,
				snippet: r.snippet,
				source: r.source,
				vectorScore: 0,
				textScore: r.textScore,
			});
		}
	}

	// Calculate weighted scores
	return Array.from(byId.values()).map((entry) => ({
		path: entry.path,
		startLine: entry.startLine,
		endLine: entry.endLine,
		score: params.vectorWeight * entry.vectorScore + params.textWeight * entry.textScore,
		snippet: entry.snippet,
		source: entry.source,
	}));
}

// ─── Temporal Decay ─────────────────────────────────────

const DATE_PATTERN = /^memory\/(\d{4}-\d{2}-\d{2})\.md$/;

/**
 * Apply exponential temporal decay to search results.
 * Only date-named files (memory/YYYY-MM-DD.md) are decayed.
 * Evergreen category files are NOT decayed.
 */
export function applyTemporalDecay(
	results: MergedResult[],
	config?: { enabled: boolean; halfLifeDays: number },
	now?: Date,
): MergedResult[] {
	if (!config?.enabled) return results;

	const today = now ?? new Date();
	const lambda = Math.LN2 / config.halfLifeDays;

	return results.map((r) => {
		const dateMatch = r.path.match(DATE_PATTERN);
		if (!dateMatch) return r; // Evergreen, no decay

		const fileDate = new Date(dateMatch[1]);
		const ageMs = today.getTime() - fileDate.getTime();
		const ageDays = Math.max(0, ageMs / (1000 * 60 * 60 * 24));
		const multiplier = Math.exp(-lambda * ageDays);

		return { ...r, score: r.score * multiplier };
	});
}

/**
 * Calculate temporal decay multiplier for a given age.
 */
export function calculateTemporalDecayMultiplier(ageInDays: number, halfLifeDays: number): number {
	const lambda = Math.LN2 / halfLifeDays;
	return Math.exp(-lambda * Math.max(0, ageInDays));
}

// ─── Post-Processing ────────────────────────────────────

function postProcess(
	results: MergedResult[],
	config: HybridSearchConfig,
	maxResults: number,
	minScore: number,
): MemorySearchResult[] {
	// Apply temporal decay
	let processed = applyTemporalDecay(results, config.temporalDecay);

	// Sort by score descending
	processed.sort((a, b) => b.score - a.score);

	// Filter by minimum score
	processed = processed.filter((r) => r.score >= minScore);

	// Top-K truncation
	processed = processed.slice(0, maxResults);

	return processed.map((r) => ({
		path: r.path,
		startLine: r.startLine,
		endLine: r.endLine,
		score: r.score,
		snippet: r.snippet,
		source: r.source,
	}));
}

// ─── Math Utilities ─────────────────────────────────────

/**
 * Compute cosine similarity between two vectors.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
	if (a.length !== b.length || a.length === 0) return 0;

	let dotProduct = 0;
	let normA = 0;
	let normB = 0;

	for (let i = 0; i < a.length; i++) {
		dotProduct += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}

	const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
	if (magnitude === 0) return 0;

	return dotProduct / magnitude;
}
