import { randomUUID } from "node:crypto";
import { logger } from "../utils/logger.js";
import { chunkMarkdown } from "./chunker.js";
import { buildFileEntry, listMemoryFiles, type MemoryStore } from "./store.js";
import type { EmbeddingProvider, MemoryChunk } from "./types.js";

export interface SyncOptions {
	/** Chunking config */
	chunking?: { tokens: number; overlap: number };
	/** Embedding provider (null = index without embeddings, FTS only) */
	embeddingProvider?: EmbeddingProvider | null;
	/** Embedding cache config */
	cache?: {
		provider: string;
		model: string;
		providerKey: string;
	};
}

/**
 * Incremental sync of memory files to the SQLite index.
 *
 * For each memory file:
 * - Skip if content hash unchanged
 * - Delete old chunks and re-index if changed
 * - Remove index entries for deleted files
 */
export async function syncMemoryFiles(
	store: MemoryStore,
	opts: SyncOptions = {},
): Promise<{
	added: number;
	updated: number;
	deleted: number;
	chunksIndexed: number;
}> {
	const chunking = opts.chunking ?? { tokens: 400, overlap: 80 };
	const stats = { added: 0, updated: 0, deleted: 0, chunksIndexed: 0 };

	// Detect embedding model change — if the model has changed since last sync,
	// clear all tracked files so every file gets re-indexed with the new model.
	const currentModel = opts.embeddingProvider?.model ?? "none";
	if (store.hasModelChanged(currentModel)) {
		logger.info("memory-sync", `Embedding model changed to ${currentModel}, clearing index for full re-sync`);
		store.clearAllTrackedFiles();
	}

	const currentFiles = await listMemoryFiles(store.getStorageDir());
	const currentPaths = new Set<string>();

	for (const absPath of currentFiles) {
		const entry = await buildFileEntry(absPath, store.getStorageDir());
		currentPaths.add(entry.path);

		// Check if file has changed
		const existing = store.getTrackedFile(entry.path);
		if (existing && existing.hash === entry.hash) {
			continue; // Unchanged, skip
		}

		const isNew = !existing;

		// Remove old chunks for this file
		store.removeChunksByPath(entry.path);

		// Read and chunk the file
		const { readFile } = await import("node:fs/promises");
		const content = await readFile(absPath, "utf-8");
		const chunks = chunkMarkdown(content, chunking);

		// Embed chunks
		const embeddings = await embedChunks(chunks, store, opts);

		// Initialize vec table with correct dimensions on first embedding
		if (opts.embeddingProvider && embeddings.length > 0 && embeddings[0].length > 0) {
			store.initVecTable(opts.embeddingProvider.id, embeddings[0].length);
		}

		// Insert new chunks
		const model = opts.embeddingProvider?.model ?? "none";
		for (let i = 0; i < chunks.length; i++) {
			const chunk = chunks[i];
			const embedding = embeddings[i] ?? [];
			const id = randomUUID();

			store.insertChunk({
				id,
				path: entry.path,
				startLine: chunk.startLine,
				endLine: chunk.endLine,
				hash: chunk.hash,
				model,
				text: chunk.text,
				embedding,
			});

			stats.chunksIndexed++;
		}

		// Update file tracking
		store.upsertFile(entry);

		if (isNew) {
			stats.added++;
		} else {
			stats.updated++;
		}

		logger.info("memory-sync", `${isNew ? "Indexed" : "Re-indexed"} ${entry.path} (${chunks.length} chunks)`);
	}

	// Remove entries for deleted files
	const trackedPaths = store.getTrackedFilePaths();
	for (const trackedPath of trackedPaths) {
		if (!currentPaths.has(trackedPath)) {
			store.removeFile(trackedPath);
			stats.deleted++;
			logger.info("memory-sync", `Removed deleted file: ${trackedPath}`);
		}
	}

	store.clearDirty();
	return stats;
}

/**
 * Embed chunks using the provider, with cache support.
 * Returns an array of embeddings aligned with the input chunks.
 * If no provider is available, returns empty arrays.
 */
async function embedChunks(chunks: MemoryChunk[], store: MemoryStore, opts: SyncOptions): Promise<number[][]> {
	if (!opts.embeddingProvider || chunks.length === 0) {
		return chunks.map(() => []);
	}

	const provider = opts.embeddingProvider;
	const hashes = chunks.map((c) => c.hash);

	// Load cached embeddings
	let cached = new Map<string, number[]>();
	if (opts.cache) {
		cached = store.loadCachedEmbeddings(opts.cache.provider, opts.cache.model, opts.cache.providerKey, hashes);
	}

	// Determine which chunks need embedding
	const needsEmbedding: { index: number; text: string; hash: string }[] = [];
	for (let i = 0; i < chunks.length; i++) {
		if (!cached.has(hashes[i])) {
			needsEmbedding.push({ index: i, text: chunks[i].text, hash: hashes[i] });
		}
	}

	// Batch embed uncached chunks
	if (needsEmbedding.length > 0) {
		const texts = needsEmbedding.map((e) => e.text);
		const newEmbeddings = await provider.embedBatch(texts);

		for (let i = 0; i < needsEmbedding.length; i++) {
			const { hash } = needsEmbedding[i];
			const embedding = newEmbeddings[i];
			cached.set(hash, embedding);

			// Write to cache
			if (opts.cache) {
				store.upsertCachedEmbedding(opts.cache.provider, opts.cache.model, opts.cache.providerKey, hash, embedding);
			}
		}
	}

	// Assemble results in order
	return chunks.map((c) => cached.get(c.hash) ?? []);
}
