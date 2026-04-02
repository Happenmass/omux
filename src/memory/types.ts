// ─── Memory Chunks ──────────────────────────────────────

export type MemoryChunk = {
	/** 1-indexed start line in source file */
	startLine: number;
	/** 1-indexed end line in source file */
	endLine: number;
	/** Raw text content of the chunk */
	text: string;
	/** SHA-256 hash of text */
	hash: string;
};

// ─── Search Results ─────────────────────────────────────

export type MemorySearchResult = {
	/** Relative file path (e.g. "memory/core.md") */
	path: string;
	/** 1-indexed start line */
	startLine: number;
	/** 1-indexed end line */
	endLine: number;
	/** Combined relevance score 0~1 */
	score: number;
	/** Truncated text snippet */
	snippet: string;
	/** Source identifier ("memory") */
	source: string;
};

// ─── Categories ─────────────────────────────────────────

export type MemoryCategory = "core" | "preferences" | "people" | "todos" | "daily" | "topic";

// ─── Embedding Provider ─────────────────────────────────

export type EmbeddingProvider = {
	/** Provider identifier: "openai" | "gemini" | "voyage" | "mistral" | "local" */
	id: string;
	/** Model name, e.g. "text-embedding-3-small" */
	model: string;
	/** Max input tokens per embedding call (optional) */
	maxInputTokens?: number;
	/** Embed a single query text (uses RETRIEVAL_QUERY task type where applicable) */
	embedQuery: (text: string) => Promise<number[]>;
	/** Embed a batch of document texts (uses RETRIEVAL_DOCUMENT task type where applicable) */
	embedBatch: (texts: string[]) => Promise<number[][]>;
	/** Optional eager initialization (e.g. download model at startup instead of first use) */
	warmup?: () => Promise<void>;
};

export type EmbeddingProviderRequest = "auto" | "openai" | "gemini" | "voyage" | "mistral" | "local";
export type EmbeddingProviderFallback = "openai" | "gemini" | "voyage" | "mistral" | "local" | "none";

export type EmbeddingProviderResult = {
	/** The resolved provider, or null if all providers unavailable (FTS-only mode) */
	provider: EmbeddingProvider | null;
	/** If fallback was used, which provider was originally requested */
	fallbackFrom?: string;
	/** Reason for falling back */
	fallbackReason?: string;
	/** Reason the provider is completely unavailable */
	unavailableReason?: string;
};

// ─── Hybrid Search Config ───────────────────────────────

export type HybridSearchConfig = {
	enabled: boolean;
	/** Vector search weight (default 0.7) */
	vectorWeight: number;
	/** Keyword search weight (default 0.3) */
	textWeight: number;
	/** Internal candidate multiplier: fetch topK * multiplier candidates before filtering */
	candidateMultiplier: number;
	temporalDecay?: {
		enabled: boolean;
		/** Half-life in days for exponential decay (default 30) */
		halfLifeDays: number;
	};
	mmr?: {
		enabled: boolean;
		/** MMR diversity parameter */
		lambda: number;
	};
};

// ─── Memory Search Config ───────────────────────────────

export type MemorySearchConfig = {
	/** Embedding provider selection */
	provider: EmbeddingProviderRequest;
	/** Fallback provider if primary fails */
	fallback: EmbeddingProviderFallback;
	/** Override provider default model */
	model?: string;

	/** Remote provider config */
	remote?: {
		baseUrl?: string;
		apiKey?: string;
		headers?: Record<string, string>;
	};

	/** Local provider config */
	local?: {
		modelPath?: string;
		modelCacheDir?: string;
	};

	/** Embedding cache config */
	cache: {
		enabled: boolean;
		maxEntries?: number;
	};

	/** SQLite store config */
	store: {
		driver: "sqlite";
		/** SQLite database file path */
		path: string;
		vector: {
			/** Whether to attempt loading sqlite-vec extension */
			enabled: boolean;
			/** Custom path to sqlite-vec shared library */
			extensionPath?: string;
		};
	};

	/** Chunking parameters */
	chunking: {
		/** Max tokens per chunk (default 400) */
		tokens: number;
		/** Overlap tokens between chunks (default 80) */
		overlap: number;
	};
};

// ─── Internal Types ─────────────────────────────────────

/** Hybrid vector search result (before merging) */
export type HybridVectorResult = {
	id: string;
	path: string;
	startLine: number;
	endLine: number;
	snippet: string;
	source: string;
	vectorScore: number;
};

/** Hybrid keyword search result (before merging) */
export type HybridKeywordResult = {
	id: string;
	path: string;
	startLine: number;
	endLine: number;
	snippet: string;
	source: string;
	textScore: number;
};

/** Result after merging vector + keyword scores */
export type MergedResult = {
	path: string;
	startLine: number;
	endLine: number;
	score: number;
	snippet: string;
	source: string;
};

/** File entry for incremental sync tracking */
export type FileEntry = {
	path: string;
	hash: string;
	mtimeMs: number;
	size: number;
};

/** Remote embedding client resolved from config */
export type RemoteEmbeddingClient = {
	model: string;
	baseUrl: string;
	headers: Record<string, string>;
};
