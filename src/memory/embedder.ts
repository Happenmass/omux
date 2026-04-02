import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { basename } from "node:path";
import { logger } from "../utils/logger.js";

const require = createRequire(import.meta.url);

import { sha256 } from "./store.js";
import type {
	EmbeddingProvider,
	EmbeddingProviderFallback,
	EmbeddingProviderRequest,
	EmbeddingProviderResult,
	MemoryChunk,
	RemoteEmbeddingClient,
} from "./types.js";

// ─── Constants ──────────────────────────────────────────

const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 8000;

/** Default models per provider */
const DEFAULT_MODELS: Record<string, string> = {
	openai: "text-embedding-3-small",
	gemini: "gemini-embedding-001",
	voyage: "voyage-3",
	mistral: "mistral-embed",
};

/** Default base URLs per provider */
const DEFAULT_BASE_URLS: Record<string, string> = {
	openai: "https://api.openai.com/v1",
	gemini: "https://generativelanguage.googleapis.com/v1beta/models",
	voyage: "https://api.voyageai.com/v1",
	mistral: "https://api.mistral.ai/v1",
};

/** Environment variable names for API keys */
const ENV_KEY_MAP: Record<string, string> = {
	openai: "OPENAI_API_KEY",
	gemini: "GEMINI_API_KEY",
	voyage: "VOYAGE_API_KEY",
	mistral: "MISTRAL_API_KEY",
};

/** Known model input token limits */
const KNOWN_LIMITS: Record<string, number> = {
	"openai:text-embedding-3-small": 8192,
	"openai:text-embedding-3-large": 8192,
	"openai:text-embedding-ada-002": 8191,
	"gemini:text-embedding-004": 2048,
	"gemini:gemini-embedding-001": 2048,
	"voyage:voyage-3": 32000,
	"voyage:voyage-3-lite": 16000,
	"voyage:voyage-code-3": 32000,
	"voyage:voyage-4-large": 32000,
};

// ─── HTTP Utilities ─────────────────────────────────────

/**
 * Fetch embedding vectors from a remote API.
 * Handles the response format: { data: [{ embedding: number[] }] }
 */
export async function fetchRemoteEmbeddingVectors(params: {
	url: string;
	headers: Record<string, string>;
	body: object;
}): Promise<number[][]> {
	const response = await fetch(params.url, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...params.headers },
		body: JSON.stringify(params.body),
	});

	if (!response.ok) {
		const text = await response.text().catch(() => "");
		const err = new Error(`Embedding API error ${response.status}: ${text}`);
		(err as any).status = response.status;
		throw err;
	}

	const json = (await response.json()) as { data: { embedding: number[] }[] };
	return json.data.map((item) => item.embedding);
}

/**
 * Resolve a remote embedding client from config + environment variables.
 * Returns null if no API key is available (auth failure).
 */
export function resolveRemoteEmbeddingClient(params: {
	provider: string;
	model: string;
	config?: {
		baseUrl?: string;
		apiKey?: string;
		headers?: Record<string, string>;
	};
}): RemoteEmbeddingClient | null {
	const config = params.config ?? {};

	// 1. API key from config
	let apiKey = config.apiKey;

	// 2. Fallback to environment variable
	if (!apiKey) {
		const envKey = ENV_KEY_MAP[params.provider];
		if (envKey) {
			apiKey = process.env[envKey];
		}
	}

	// 3. No key available
	if (!apiKey) return null;

	return {
		model: params.model,
		baseUrl: config.baseUrl ?? DEFAULT_BASE_URLS[params.provider] ?? "",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			...config.headers,
		},
	};
}

// ─── Remote Provider (OpenAI / Mistral compatible) ──────

/**
 * Create a remote embedding provider using OpenAI-compatible /embeddings endpoint.
 * Works for OpenAI, Mistral, and other OpenAI-compatible APIs.
 */
export function createRemoteEmbeddingProvider(params: {
	id: string;
	client: RemoteEmbeddingClient;
	maxInputTokens?: number;
}): EmbeddingProvider {
	const { client } = params;
	return {
		id: params.id,
		model: client.model,
		maxInputTokens: params.maxInputTokens,

		embedQuery: async (text: string) => {
			const response = await fetchRemoteEmbeddingVectors({
				url: `${client.baseUrl}/embeddings`,
				headers: client.headers,
				body: { model: client.model, input: text },
			});
			return response[0];
		},

		embedBatch: async (texts: string[]) => {
			return fetchRemoteEmbeddingVectors({
				url: `${client.baseUrl}/embeddings`,
				headers: client.headers,
				body: { model: client.model, input: texts },
			});
		},
	};
}

// ─── Gemini Provider (Google AI API with key rotation) ──

/**
 * Create a Gemini embedding provider with API key rotation support.
 * Uses Google AI API with taskType differentiation.
 */
export function createGeminiEmbeddingProvider(params: {
	apiKeys: string[];
	model: string;
	baseUrl?: string;
	maxInputTokens?: number;
}): EmbeddingProvider {
	const baseUrl = params.baseUrl ?? DEFAULT_BASE_URLS.gemini;
	let currentKeyIndex = 0;

	async function executeWithKeyRotation<T>(fn: (apiKey: string) => Promise<T>): Promise<T> {
		const startIndex = currentKeyIndex;
		let lastError: Error | null = null;

		do {
			const apiKey = params.apiKeys[currentKeyIndex];
			try {
				return await fn(apiKey);
			} catch (err) {
				lastError = err as Error;
				currentKeyIndex = (currentKeyIndex + 1) % params.apiKeys.length;
			}
		} while (currentKeyIndex !== startIndex);

		throw lastError!;
	}

	return {
		id: "gemini",
		model: params.model,
		maxInputTokens: params.maxInputTokens,

		embedQuery: async (text: string) => {
			return executeWithKeyRotation(async (apiKey) => {
				const url = `${baseUrl}/${params.model}:embedContent?key=${apiKey}`;
				const response = await fetch(url, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						content: { parts: [{ text }] },
						taskType: "RETRIEVAL_QUERY",
					}),
				});
				if (!response.ok) {
					const errText = await response.text().catch(() => "");
					const err = new Error(`Gemini API error ${response.status}: ${errText}`);
					(err as any).status = response.status;
					throw err;
				}
				const json = (await response.json()) as { embedding: { values: number[] } };
				return json.embedding.values;
			});
		},

		embedBatch: async (texts: string[]) => {
			return executeWithKeyRotation(async (apiKey) => {
				const url = `${baseUrl}/${params.model}:batchEmbedContents?key=${apiKey}`;
				const response = await fetch(url, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						requests: texts.map((text) => ({
							model: `models/${params.model}`,
							content: { parts: [{ text }] },
							taskType: "RETRIEVAL_DOCUMENT",
						})),
					}),
				});
				if (!response.ok) {
					const errText = await response.text().catch(() => "");
					const err = new Error(`Gemini API error ${response.status}: ${errText}`);
					(err as any).status = response.status;
					throw err;
				}
				const json = (await response.json()) as { embeddings: { values: number[] }[] };
				return json.embeddings.map((e) => e.values);
			});
		},
	};
}

// ─── Local Provider (node-llama-cpp GGUF) ───────────────

/**
 * Create a local embedding provider using node-llama-cpp.
 * Model is lazily loaded on first use.
 */
export function createLocalEmbeddingProvider(params: { modelPath: string; modelCacheDir?: string }): EmbeddingProvider {
	let embeddingContext: any = null;

	async function ensureLoaded() {
		if (embeddingContext) return;
		try {
			const { getLlama, resolveModelFile } = await import("node-llama-cpp");

			// Resolve model path — downloads from HuggingFace if hf: prefixed
			let resolvedPath = params.modelPath;
			if (params.modelPath.startsWith("hf:")) {
				logger.info("embedding", `Downloading model: ${params.modelPath}`);
				resolvedPath = await resolveModelFile(params.modelPath);
			}

			// Limit ramPadding to 512MB — default is 25% of total RAM or 6GB on macOS,
			// which causes V8 heap OOM on macOS ARM due to unified memory architecture.
			const llama = await getLlama({
				ramPadding: 512 * 1024 * 1024,
			});
			const model = await llama.loadModel({ modelPath: resolvedPath });
			embeddingContext = await model.createEmbeddingContext();
		} catch (err: any) {
			throw new Error(`Failed to load local embedding model: ${err.message}`);
		}
	}

	function sanitizeEmbedding(raw: number[]): number[] {
		const cleaned = raw.map((v) => (Number.isFinite(v) ? v : 0));
		const magnitude = Math.sqrt(cleaned.reduce((sum, v) => sum + v * v, 0));
		if (magnitude === 0) return cleaned;
		return cleaned.map((v) => v / magnitude);
	}

	return {
		id: "local",
		model: basename(params.modelPath),

		warmup: ensureLoaded,

		embedQuery: async (text: string) => {
			await ensureLoaded();
			const result = await embeddingContext.getEmbeddingFor(text);
			return sanitizeEmbedding(Array.from(result.vector));
		},

		embedBatch: async (texts: string[]) => {
			await ensureLoaded();
			return Promise.all(
				texts.map(async (text) => {
					const result = await embeddingContext.getEmbeddingFor(text);
					return sanitizeEmbedding(Array.from(result.vector));
				}),
			);
		},
	};
}

// ─── Factory ────────────────────────────────────────────

/** Default HuggingFace model for local embedding when no model path is configured */
const DEFAULT_HF_MODEL = "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf";

/** Auto-detection order for embedding providers (remote first, local last to avoid heavy model loading) */
const AUTO_DETECT_ORDER: Array<Exclude<EmbeddingProviderRequest, "auto">> = [
	"openai",
	"gemini",
	"voyage",
	"mistral",
	"local",
];

/**
 * Cached result for node-llama-cpp availability check.
 * null = not yet checked, boolean = cached result.
 */
let _nodeLlamaCppAvailable: boolean | null = null;

/**
 * Check if node-llama-cpp is installed and resolvable.
 */
export function isNodeLlamaCppAvailable(): boolean {
	if (_nodeLlamaCppAvailable !== null) return _nodeLlamaCppAvailable;
	try {
		require.resolve("node-llama-cpp");
		_nodeLlamaCppAvailable = true;
	} catch {
		_nodeLlamaCppAvailable = false;
	}
	return _nodeLlamaCppAvailable;
}

/** @internal For testing only — override node-llama-cpp availability */
export function _setNodeLlamaCppAvailable(available: boolean | null): void {
	_nodeLlamaCppAvailable = available;
}

/**
 * Check if a local model path should be used.
 * Supports local file paths (must exist) and hf: prefixed paths (downloaded by node-llama-cpp).
 * Returns false if node-llama-cpp is not installed.
 */
export function shouldUseLocalProvider(modelPath?: string): boolean {
	if (!modelPath) return false;
	if (!isNodeLlamaCppAvailable()) return false;
	if (modelPath.startsWith("hf:")) return true;
	if (modelPath.startsWith("http")) return false;
	return existsSync(modelPath);
}

/**
 * Try to create a single embedding provider by name.
 * Returns null if the provider is not available (e.g., no API key).
 * Throws on non-auth errors.
 */
function tryCreateProvider(
	name: Exclude<EmbeddingProviderRequest, "auto">,
	config: CreateEmbeddingProviderParams,
): EmbeddingProvider | null {
	const model = config.model ?? DEFAULT_MODELS[name] ?? "text-embedding-3-small";

	if (name === "local") {
		const modelPath = config.local?.modelPath || DEFAULT_HF_MODEL;
		if (!shouldUseLocalProvider(modelPath)) return null;
		return createLocalEmbeddingProvider({
			modelPath,
			modelCacheDir: config.local?.modelCacheDir,
		});
	}

	if (name === "gemini") {
		// Gemini uses API key in URL param, supports multiple keys
		const keys: string[] = [];
		if (config.remote?.apiKey) {
			keys.push(config.remote.apiKey);
		}
		const envKeys = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_AI_API_KEY;
		if (envKeys) {
			// Support comma-separated keys for rotation
			for (const k of envKeys.split(",")) {
				const trimmed = k.trim();
				if (trimmed && !keys.includes(trimmed)) keys.push(trimmed);
			}
		}
		if (keys.length === 0) return null;

		return createGeminiEmbeddingProvider({
			apiKeys: keys,
			model,
			baseUrl: config.remote?.baseUrl ?? DEFAULT_BASE_URLS.gemini,
			maxInputTokens: KNOWN_LIMITS[`gemini:${model}`],
		});
	}

	// OpenAI-compatible providers (openai, mistral, voyage)
	const client = resolveRemoteEmbeddingClient({
		provider: name,
		model,
		config: config.remote,
	});
	if (!client) return null;

	return createRemoteEmbeddingProvider({
		id: name,
		client,
		maxInputTokens: KNOWN_LIMITS[`${name}:${model}`],
	});
}

export interface CreateEmbeddingProviderParams {
	provider: EmbeddingProviderRequest;
	fallback: EmbeddingProviderFallback;
	model?: string;
	remote?: {
		baseUrl?: string;
		apiKey?: string;
		headers?: Record<string, string>;
	};
	local?: {
		modelPath?: string;
		modelCacheDir?: string;
	};
}

/**
 * Create an embedding provider using the factory pattern.
 *
 * Supports three modes:
 * - "auto": Detect available providers in order (local → openai → gemini → voyage → mistral)
 * - Explicit provider name: Try the specified provider with optional fallback
 * - Returns null provider for FTS-only degradation when no providers available
 */
export async function createEmbeddingProvider(params: CreateEmbeddingProviderParams): Promise<EmbeddingProviderResult> {
	// Mode A: Auto detection
	if (params.provider === "auto") {
		for (const name of AUTO_DETECT_ORDER) {
			try {
				const provider = tryCreateProvider(name, params);
				if (provider) {
					logger.info("embedding", `Auto-detected provider: ${name}`);
					return { provider };
				}
			} catch (err: any) {
				// Non-auth errors are fatal
				if (isAuthError(err)) continue;
				throw err;
			}
		}
		logger.info("embedding", "No embedding providers available, falling back to FTS-only mode");
		return {
			provider: null,
			unavailableReason: "No embedding providers available (no API keys configured, no local model found)",
		};
	}

	// Mode B: Explicit provider
	try {
		const provider = tryCreateProvider(params.provider, params);
		if (provider) {
			return { provider };
		}

		// Auth failure → try fallback
		if (params.fallback !== "none") {
			try {
				const fallbackProvider = tryCreateProvider(params.fallback, params);
				if (fallbackProvider) {
					logger.info("embedding", `Fell back from ${params.provider} to ${params.fallback}`);
					return {
						provider: fallbackProvider,
						fallbackFrom: params.provider,
						fallbackReason: `${params.provider} not available (no API key)`,
					};
				}
			} catch (err: any) {
				if (!isAuthError(err)) throw err;
			}
		}

		// All failed
		return {
			provider: null,
			unavailableReason: `${params.provider} not available and fallback ${params.fallback} also not available`,
		};
	} catch (err: any) {
		if (isAuthError(err) && params.fallback !== "none") {
			try {
				const fallbackProvider = tryCreateProvider(params.fallback, params);
				if (fallbackProvider) {
					return {
						provider: fallbackProvider,
						fallbackFrom: params.provider,
						fallbackReason: err.message,
					};
				}
			} catch (fallbackErr: any) {
				if (!isAuthError(fallbackErr)) throw fallbackErr;
			}
			return {
				provider: null,
				unavailableReason: `${params.provider} failed: ${err.message}, fallback ${params.fallback} also not available`,
			};
		}
		throw err;
	}
}

// ─── Retry with Exponential Backoff ─────────────────────

/**
 * Check if an error is an authentication error (401, 403).
 */
export function isAuthError(err: any): boolean {
	if (!err) return false;
	const status = err.status ?? err.statusCode;
	if (status === 401 || status === 403) return true;
	const message = String(err.message ?? "").toLowerCase();
	return message.includes("unauthorized") || message.includes("forbidden") || message.includes("invalid api key");
}

/**
 * Embed a batch of texts with exponential backoff retry.
 * Auth errors (401, 403) are NOT retried.
 */
export async function embedBatchWithRetry(provider: EmbeddingProvider, texts: string[]): Promise<number[][]> {
	let lastError: Error | null = null;

	for (let attempt = 0; attempt < RETRY_MAX_ATTEMPTS; attempt++) {
		try {
			return await provider.embedBatch(texts);
		} catch (err: any) {
			lastError = err;

			// Auth errors are not retried
			if (isAuthError(err)) throw err;

			// Exponential backoff
			const delay = Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS);
			logger.warn("embedding", `Embed attempt ${attempt + 1} failed: ${err.message}, retrying in ${delay}ms`);
			await sleep(delay);
		}
	}

	throw lastError;
}

// ─── Input Token Limit Enforcement ──────────────────────

/**
 * Split chunks that exceed the embedding model's input token limit.
 * Returns a new array where oversized chunks are split into sub-chunks.
 */
export function enforceEmbeddingMaxInputTokens(provider: EmbeddingProvider, chunks: MemoryChunk[]): MemoryChunk[] {
	const limit = provider.maxInputTokens ?? KNOWN_LIMITS[`${provider.id}:${provider.model}`] ?? 8192;

	const maxChars = limit * 4; // Approximate token→char conversion

	return chunks.flatMap((chunk) => {
		if (chunk.text.length <= maxChars) {
			return [chunk];
		}

		// Oversized chunk → split into sub-chunks
		const pieces: MemoryChunk[] = [];
		for (let start = 0; start < chunk.text.length; start += maxChars) {
			const text = chunk.text.slice(start, start + maxChars);
			pieces.push({
				startLine: chunk.startLine,
				endLine: chunk.endLine,
				text,
				hash: sha256(text),
			});
		}
		return pieces;
	});
}

// ─── Utility ────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
