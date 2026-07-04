import type { LLMClient } from "../llm/client.js";
import type { PromptLoader } from "../llm/prompt-loader.js";
import type { LLMMessage, ThinkingLevel, ToolCallContent, ToolDefinition } from "../llm/types.js";
import type { MemoryStore } from "../memory/store.js";
import type { ConversationStore } from "../persistence/conversation-store.js";
import { logger } from "../utils/logger.js";

// ─── Types ──────────────────────────────────────────────

export interface LLMUsage {
	inputTokens: number;
	outputTokens: number;
}

export interface ContextManagerConfig {
	llmClient: LLMClient;
	promptLoader: PromptLoader;
	/**
	 * Explicit context-window override in tokens. When set, it wins over the known-model
	 * lookup and the built-in default. Wire `config.context.contextWindowLimit` (or the
	 * `--context-window` CLI flag) in here. Only a positive number is treated as an override —
	 * `0` / `undefined` means "not explicitly configured" so the model lookup can apply.
	 */
	contextWindowLimit?: number;
	/**
	 * Model id (e.g. "claude-sonnet-4-6", "gpt-5.4", "deepseek-chat"). Used ONLY to derive a
	 * sensible context-window default via KNOWN_CONTEXT_WINDOWS when no explicit
	 * `contextWindowLimit` override is provided. Optional — omitting it falls back to the
	 * 500k default with a loud startup warning.
	 */
	model?: string;
	compressionThreshold?: number;
	/** Memory flush threshold (ratio of contextWindowLimit). Must be < compressionThreshold. Default 0.6. */
	flushThreshold?: number;
	/** MemoryStore for flush writes (optional — flush disabled if not provided) */
	memoryStore?: MemoryStore;
	/** Optional callback to sync indexed memory after writes. */
	syncMemory?: () => Promise<void>;
	/**
	 * Optional reloader for the global persistent {{memory}} module.
	 * Invoked only at cache-invalidation breakpoints (`clear()` / `compress()` / external reset),
	 * so the in-prompt copy of MEMORY.md stays byte-stable for the duration of a session and the
	 * prompt cache prefix is not invalidated by `persistent_memory` writes.
	 * Returning `null` leaves the existing module value untouched.
	 */
	memoryReloader?: () => Promise<string | null>;
	/** Number of recent tool results to keep in full. Older results are summarized. Default 20. */
	toolResultRetention?: number;
	/** ConversationStore for SQLite persistence (optional — persistence disabled if not provided) */
	conversationStore?: ConversationStore;
}

// ─── ContextManager ─────────────────────────────────────

export class ContextManager {
	private llmClient: LLMClient;
	private promptLoader: PromptLoader;
	private contextWindowLimit: number;
	private compressionThreshold: number;
	private flushThreshold: number;
	private toolResultRetention: number;

	private modules: Map<string, string> = new Map();
	private conversation: LLMMessage[] = [];

	// Stable cache key for the OpenAI Responses API (`prompt_cache_key`).
	// Lifecycle (matches Codex `client.state.conversation_id`):
	//   - generated lazily on first `getConversationId()` call, persisted to SQLite
	//   - PRESERVED across `compress()` (compact = new prefix on the SAME cache entry)
	//   - REGENERATED on `clear()` / external `/reset` (those are cache-invalidation breakpoints)
	//   - RESTORED from SQLite on session restart so reconnects keep hitting the same entry
	private conversationId: string | null = null;

	// Hybrid token counting
	private lastKnownTokenCount = 0;
	private pendingChars = 0;

	// Memory Flush state
	private memoryStore: MemoryStore | null;
	private syncMemory: (() => Promise<void>) | null;
	private memoryReloader: (() => Promise<string | null>) | null;

	// In-chain compaction tuning (set by MainAgent post-construction). When BOTH `tools`
	// and `thinking` are set, `compress()` runs the cache-friendly in-chain path: the compact
	// request inherits the main session's instructions / tools / reasoning so the entire
	// existing prefix hits the prompt cache, and the L2 incremental check fires on the lone
	// tail directive. When unset, falls back to the legacy separate-completion path with the
	// `history-compressor.md` system prompt (zero cache reuse, but always available).
	private compactTools: ToolDefinition[] | null = null;
	private compactThinking: ThinkingLevel | null = null;
	private compactionCount = 0;
	private lastFlushCompactionCount = -1;

	// Conversation persistence
	private conversationStore: ConversationStore | null;

	constructor(config: ContextManagerConfig) {
		this.llmClient = config.llmClient;
		this.promptLoader = config.promptLoader;
		this.contextWindowLimit = resolveContextWindowLimit(config.contextWindowLimit, config.model);
		this.compressionThreshold = config.compressionThreshold ?? 0.7;
		this.flushThreshold = config.flushThreshold ?? 0.6;
		this.toolResultRetention = config.toolResultRetention ?? 20;
		this.memoryStore = config.memoryStore ?? null;
		this.syncMemory = config.syncMemory ?? null;
		this.memoryReloader = config.memoryReloader ?? null;
		this.conversationStore = config.conversationStore ?? null;

		// Validate flush < compress invariant
		if (this.flushThreshold >= this.compressionThreshold) {
			throw new Error(
				`flushThreshold (${this.flushThreshold}) must be less than compressionThreshold (${this.compressionThreshold})`,
			);
		}
	}

	// ─── System Prompt ────────────────────────────────────

	getSystemPrompt(): string {
		// Hot-reload main-agent.md from disk if its mtime changed, so prompt
		// edits take effect on the next LLM round without requiring /reset.
		this.promptLoader.reloadIfChanged?.("main-agent");
		let prompt = this.promptLoader.getRaw("main-agent");
		for (const [key, value] of this.modules) {
			prompt = prompt.replaceAll(`{{${key}}}`, value);
		}
		// Clear any remaining unreplaced variables
		prompt = prompt.replace(/\{\{[\w-]+\}\}/g, "");
		return prompt;
	}

	updateModule(key: string, value: string): void {
		this.modules.set(key, value);
	}

	/**
	 * Wire MainAgent's effective LLM tuning into ContextManager so `compress()` can reuse
	 * the prompt-cache prefix from the running session. Call once at MainAgent construction
	 * and again whenever the tuning changes (skill registry update, /reset, etc).
	 *
	 * To preserve byte-equality of every non-input field across regular turns and the compact
	 * turn, the values passed in MUST be the same `tools` array and same `thinking` level
	 * the MainAgent sends in `streamLLMResponse`. ContextManager does not mutate them.
	 */
	setCompactTuning(opts: { tools: ToolDefinition[]; thinking: ThinkingLevel }): void {
		this.compactTools = opts.tools;
		this.compactThinking = opts.thinking;
	}

	/**
	 * Stable conversation_id used as `prompt_cache_key` on the OpenAI Responses API.
	 *
	 * Generated lazily and persisted to SQLite on first call. Stays constant across `compress()`
	 * (per the design spec §8: "压缩后视作'新的稳定前缀的开始'，cache_key 可保持不变") and
	 * regenerates on `clear()` / restart-with-empty-store. Other protocols ignore it.
	 *
	 * Format: a uuid-shaped 32-hex string with dashes, generated via crypto.randomUUID() when
	 * available (Node ≥14.17 / browsers); a hand-rolled fallback keeps tests hermetic.
	 */
	getConversationId(): string {
		if (this.conversationId) return this.conversationId;
		const id = generateUuid();
		this.conversationId = id;
		if (this.conversationStore) {
			this.conversationStore.saveContextState("conversation_id", id);
		}
		return id;
	}

	/**
	 * Re-read the global persistent {{memory}} module from disk via the configured reloader.
	 * Only call from cache-invalidation breakpoints (clear / compress / reset). The
	 * `persistent_memory` tool intentionally does NOT call this — its writes land on disk and the
	 * agent learns about the effect from the tool result, leaving the system prompt byte-stable.
	 */
	async reloadPersistentMemory(): Promise<void> {
		if (!this.memoryReloader) return;
		try {
			const value = await this.memoryReloader();
			if (value !== null && value !== undefined) {
				this.modules.set("memory", value);
			}
		} catch (err: any) {
			logger.warn("context-manager", `Persistent memory reload failed: ${err.message}`);
		}
	}

	/** Reload the prompt template from disk (kept for /reset back-compat). */
	reloadPromptTemplate(): void {
		this.promptLoader.reloadIfChanged?.("main-agent");
	}

	// ─── Conversation Management ──────────────────────────

	addMessage(message: LLMMessage): void {
		this.conversation.push(message);

		// Accumulate chars for hybrid token counting
		if (typeof message.content === "string") {
			this.pendingChars += message.content.length;
		} else {
			this.pendingChars += JSON.stringify(message.content).length;
		}

		// Persist to SQLite when ConversationStore is configured
		if (this.conversationStore) {
			this.conversationStore.saveMessage(message);
		}
	}

	getMessages(): LLMMessage[] {
		return this.conversation;
	}

	getConversationLength(): number {
		return this.conversation.length;
	}

	// ─── Persistence: restore / clear ────────────────────

	/**
	 * Restore conversation and context state from SQLite.
	 * Rebuilds conversation[], modules, and counters.
	 */
	restore(store: ConversationStore): number {
		this.conversationStore = store;

		// 1. Restore conversation messages
		const messages = store.loadMessages();
		// Repair any dangling tool calls (assistant tool_call with no paired role:"tool" result).
		// A SIGKILL between persisting the assistant function_call message and persisting its
		// tool result bricks the conversation: the OpenAI Responses API 400s ("No tool output
		// found for function call …") on EVERY subsequent turn, and the other providers can also
		// choke on an orphaned function_call. This repair is protocol-agnostic — it synthesizes a
		// placeholder tool result for every unmatched call so the restored history is always valid.
		const repaired = repairDanglingToolCalls(messages);
		this.conversation = repaired;

		// 2. Restore compressed_history module
		const compressedHistory = store.loadContextState("compressed_history");
		if (compressedHistory) {
			this.modules.set("compressed_history", compressedHistory);
		}

		// 3. Restore goal module
		const goal = store.loadContextState("goal");
		if (goal) {
			this.modules.set("goal", goal);
		}

		// 4. Restore conversation_id (prompt_cache_key) — must survive process restarts so
		//    reconnects continue hitting the same Responses API cache entry.
		const persistedConvId = store.loadContextState("conversation_id");
		if (persistedConvId) {
			this.conversationId = persistedConvId;
		}

		// 5. Restore counters
		const tokenCount = store.loadContextState("token_count");
		if (tokenCount) {
			this.lastKnownTokenCount = Number.parseInt(tokenCount, 10) || 0;
		}
		const compactionCount = store.loadContextState("compaction_count");
		if (compactionCount) {
			this.compactionCount = Number.parseInt(compactionCount, 10) || 0;
		}

		// 5. Reset pendingChars — restored messages are already accounted for
		// in lastKnownTokenCount (persisted at last reportUsage call).
		// Only new messages added after restore should contribute to pendingChars.
		// If token_count was never persisted, fall back to char-based estimation.
		if (this.lastKnownTokenCount > 0) {
			this.pendingChars = 0;
		} else {
			// No persisted token count — estimate from message content
			this.pendingChars = 0;
			for (const msg of this.conversation) {
				if (typeof msg.content === "string") {
					this.pendingChars += msg.content.length;
				} else {
					this.pendingChars += JSON.stringify(msg.content).length;
				}
			}
		}

		// 6. Do NOT inject any "[SESSION_RESTORED]" notice into the conversation.
		//    Earlier versions appended a synthetic user message announcing the restart, but
		//    that's actively harmful for prompt-cache continuity:
		//      - Each restart appended a NEW message at the input tail (with restart-specific
		//        wording), invalidating the L2 incremental baseline and forcing a full-history
		//        upload on the first turn after restart.
		//      - The notice changed the input prefix the next turn extends, so even L1 server-
		//        side cache hits could shift if the notice text varied across releases.
		//      - The model didn't actually need it: from the model's POV, conversation history
		//        is whatever it sees in `input` — there's nothing it has to do differently
		//        because omux's process happened to restart between turns.
		//    The conversation is restored verbatim; the next user message just continues it.
		const restoredCount = this.conversation.length;
		logger.info("context-manager", `Restored ${restoredCount} messages, compactionCount=${this.compactionCount}`);
		return restoredCount;
	}

	/**
	 * Clear conversation: memory flush → clear memory state → clear SQLite.
	 * Preserves static modules like agent_capabilities.
	 */
	async clear(): Promise<void> {
		// 1. Run memory flush if MemoryStore is available
		if (this.memoryStore && this.conversation.length > 0) {
			try {
				await this.runMemoryFlush();
			} catch (err: any) {
				logger.warn("context-manager", `Memory flush during clear failed: ${err.message}`);
			}
		}

		// 2. Clear conversation
		this.conversation = [];

		// 3. Remove dynamic modules (preserve static ones like agent_capabilities)
		this.modules.delete("goal");
		this.modules.delete("compressed_history");

		// 4. Reset counters
		this.lastKnownTokenCount = 0;
		this.pendingChars = 0;
		this.compactionCount = 0;
		this.lastFlushCompactionCount = -1;

		// 5. Clear SQLite
		if (this.conversationStore) {
			this.conversationStore.clearAll();
		}

		// 6. Drop conversation_id — /clear is a hard cache-invalidation breakpoint, so the next
		//    Responses API call should land on a fresh cache entry. The id will be regenerated
		//    lazily on the next `getConversationId()` call.
		this.conversationId = null;

		// 6a. Reset the OpenAI Responses provider's `previous_response_id` chain. The prior
		//     baseline belonged to the now-dead conversation_id; reusing it would either fail
		//     the byte-equal check (good — degrades to full) or, worse, would silently splice
		//     unrelated server-side state into the new session. Explicit reset is cheap and safe.
		try {
			(this.llmClient as { resetConversationState?: () => void }).resetConversationState?.();
		} catch (err: any) {
			logger.warn("context-manager", `Provider state reset failed (non-fatal): ${err.message}`);
		}

		// 7. Refresh {{memory}} from disk — clear is one of the explicit cache-invalidation
		//    breakpoints where prompt prefix is allowed to change.
		await this.reloadPersistentMemory();

		logger.info("context-manager", "Context cleared");
	}

	// ─── prepareForLLM (Layer 1) ──────────────────────────

	/**
	 * Prepare system prompt and messages for LLM call.
	 * Shallow-clones the conversation (deep-copies only mutable fields),
	 * applies transformContext, and returns the transformed data.
	 * Original conversation is NOT modified.
	 */
	prepareForLLM(): { system: string; messages: LLMMessage[] } {
		const system = this.getSystemPrompt();
		// Use lightweight clone instead of structuredClone to reduce peak memory:
		// - tool messages: shallow copy (content is a string, immutable)
		// - assistant messages with tool_call arrays: shallow copy + copy arguments
		// - user/system messages: direct reference (transformContext doesn't modify them)
		const cloned = this.conversation.map((msg) => {
			if (msg.role === "tool") {
				return { ...msg };
			}
			if (msg.role === "assistant" && Array.isArray(msg.content)) {
				return {
					...msg,
					content: msg.content.map((block) =>
						block.type === "tool_call" ? { ...block, arguments: { ...block.arguments } } : block,
					),
				};
			}
			return msg;
		});
		const transformed = this.transformContext(cloned);
		return { system, messages: transformed };
	}

	/**
	 * Apply tool result context guard (Layer 1):
	 * 0. Sliding window: summarize tool results beyond the retention window
	 * 1. Truncate any single tool result > 50% of context budget
	 * 2. Replace oldest tool results when total > 75% of context window
	 */
	private transformContext(messages: LLMMessage[]): LLMMessage[] {
		// Step 0: Sliding window compaction
		const toolResultIndices: number[] = [];
		for (let i = 0; i < messages.length; i++) {
			if (messages[i].role === "tool") {
				toolResultIndices.push(i);
			}
		}

		if (toolResultIndices.length > this.toolResultRetention) {
			const toCompact = toolResultIndices.slice(0, -this.toolResultRetention);
			const compactedCallIds = new Set<string>();

			for (const idx of toCompact) {
				const msg = messages[idx];
				const toolCallId = msg.toolCallId;
				if (toolCallId) compactedCallIds.add(toolCallId);

				const toolName = this.findToolName(messages, toolCallId, idx);
				const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
				msg.content = this.summarizeToolResult(toolName, content);
			}

			// Truncate corresponding tool_call args in assistant messages
			for (const msg of messages) {
				if (msg.role === "assistant" && Array.isArray(msg.content)) {
					for (const block of msg.content) {
						if (block.type === "tool_call" && compactedCallIds.has(block.id)) {
							this.truncateToolCallArgs(block);
						}
					}
				}
			}
		}

		// Step 1: Truncate oversized single tool results
		const singleCap = this.contextWindowLimit * 0.5;
		const singleCapChars = singleCap * 4; // tokens → chars

		for (const msg of messages) {
			if (msg.role === "tool" && typeof msg.content === "string" && msg.content.length > singleCapChars) {
				msg.content = `${msg.content.slice(0, singleCapChars)}\n...[truncated]`;
			}
		}

		// Step 2: Budget overflow compaction (75% cap)
		const budgetCap = this.contextWindowLimit * 0.75;
		let totalTokens = this.estimateTokens(this.getSystemPrompt()) + this.estimateTokens(messages);

		if (totalTokens > budgetCap) {
			// Compact oldest tool results first (skip already-summarized ones)
			for (const msg of messages) {
				if (totalTokens <= budgetCap) break;
				if (
					msg.role === "tool" &&
					typeof msg.content === "string" &&
					msg.content !== COMPACTED_PLACEHOLDER &&
					!msg.content.startsWith("[")
				) {
					const freed = Math.ceil(msg.content.length / 4);
					msg.content = COMPACTED_PLACEHOLDER;
					totalTokens -= freed - Math.ceil(COMPACTED_PLACEHOLDER.length / 4);
				}
			}
		}

		return messages;
	}

	// ─── Sliding Window Helpers ──────────────────────────

	/**
	 * Find the tool name by searching backwards from a tool result
	 * for the assistant message containing the matching tool_call.
	 */
	private findToolName(messages: LLMMessage[], toolCallId: string | undefined, beforeIndex: number): string {
		if (!toolCallId) return "unknown";
		for (let i = beforeIndex - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.role === "assistant" && Array.isArray(msg.content)) {
				for (const block of msg.content) {
					if (block.type === "tool_call" && block.id === toolCallId) {
						return block.name;
					}
				}
			}
		}
		return "unknown";
	}

	/**
	 * Generate a brief summary for a compacted tool result.
	 * Format: [{tool_name} → {status}] {first_line_summary}
	 */
	private summarizeToolResult(toolName: string, content: string): string {
		const firstLine = content.split("\n")[0].trim();
		const isError =
			firstLine.startsWith("Error:") || firstLine.startsWith("Failed") || firstLine.includes("[exit code:");
		const status = isError ? "✗" : "✓";
		const summary = firstLine.length > 150 ? `${firstLine.slice(0, 150)}...` : firstLine;
		return `[${toolName} → ${status}] ${summary}`;
	}

	/**
	 * Truncate long string arguments in a tool_call content block.
	 */
	private truncateToolCallArgs(block: ToolCallContent): void {
		for (const [key, value] of Object.entries(block.arguments)) {
			if (typeof value === "string" && value.length > 200) {
				block.arguments[key] = `${value.slice(0, 200)}...`;
			}
		}
	}

	// ─── Hybrid Token Counting ────────────────────────────

	/**
	 * Report actual token usage from LLM API response.
	 * Resets pendingChars and calibrates the token count.
	 */
	reportUsage(usage: LLMUsage): void {
		this.lastKnownTokenCount = usage.inputTokens + usage.outputTokens;
		this.pendingChars = 0;

		// Persist token_count so compression thresholds survive restarts
		if (this.conversationStore) {
			this.conversationStore.saveContextState("token_count", String(this.lastKnownTokenCount));
		}
	}

	/**
	 * Get current token count estimate.
	 * Uses last known count + estimated tokens from pending chars.
	 */
	getCurrentTokenEstimate(): number {
		return this.lastKnownTokenCount + Math.ceil(this.pendingChars / 4);
	}

	getContextWindowLimit(): number {
		return this.contextWindowLimit;
	}

	// ─── Compression (Layer 3) ────────────────────────────

	shouldCompress(): boolean {
		const totalTokens = this.getCurrentTokenEstimate();
		// Fallback: if no API usage reported yet, use old estimation
		if (this.lastKnownTokenCount === 0) {
			const estimated = this.estimateTokens(this.getSystemPrompt()) + this.estimateTokens(this.conversation);
			return estimated > this.contextWindowLimit * this.compressionThreshold;
		}
		return totalTokens > this.contextWindowLimit * this.compressionThreshold;
	}

	async compress(runId?: string): Promise<void> {
		// `runId` is propagated from /compact (or from the auto-trigger in MainAgent's
		// executeToolLoop when shouldCompress fires) so every log line emitted during this
		// compaction can be grep'd as one trace.
		const id = runId ?? `auto-${Date.now().toString(36)}`;
		const tStart = Date.now();
		logger.info(
			"context-manager",
			`[compact ${id}] compress() entered: conv.length=${this.conversation.length}, compactTools=${this.compactTools ? `set(${this.compactTools.length})` : "null"}, compactThinking=${this.compactThinking ?? "null"}, compactionCount=${this.compactionCount}, conversation_id=${this.conversationId ?? "(none)"}`,
		);

		// Try the in-chain (cache-friendly) path first. Falls back to the legacy separate-
		// completion path on (a) tuning not wired (early-startup safety), (b) empty response,
		// or (c) the model produces tool_calls instead of summary text.
		const tInChain = Date.now();
		let summary = await this.compressInChain(id);
		const inChainElapsed = Date.now() - tInChain;
		if (summary === null) {
			logger.warn(
				"context-manager",
				`[compact ${id}] in-chain path returned null after ${inChainElapsed}ms — invoking compressLegacy() (THIS IS A SECOND LLM CALL)`,
			);
			const tLegacy = Date.now();
			summary = await this.compressLegacy(id);
			logger.info("context-manager", `[compact ${id}] legacy path returned after ${Date.now() - tLegacy}ms`);
		} else {
			logger.info(
				"context-manager",
				`[compact ${id}] in-chain path succeeded after ${inChainElapsed}ms (no fallback needed)`,
			);
		}

		this.modules.set("compressed_history", summary);
		this.conversation = [];
		this.compactionCount++;

		// Reset token counting after compaction
		this.lastKnownTokenCount = 0;
		this.pendingChars = 0;

		// Persist compressed state to SQLite: clear first, then save (atomic sequence).
		// IMPORTANT: conversation_id is preserved across compress() per spec §8 — compaction
		// is "a new stable prefix on the SAME cache entry". So we re-save it after clearAll().
		if (this.conversationStore) {
			this.conversationStore.clearAll();
			this.conversationStore.saveContextState("compressed_history", summary);
			this.conversationStore.saveContextState("compaction_count", String(this.compactionCount));
			if (this.conversationId) {
				this.conversationStore.saveContextState("conversation_id", this.conversationId);
			}
		}

		// Post-compaction context injection
		this.conversation.push({
			role: "user",
			content: POST_COMPACTION_CONTEXT,
		});
		// Persist the post-compaction context message
		if (this.conversationStore) {
			this.conversationStore.saveMessage({ role: "user", content: POST_COMPACTION_CONTEXT });
		}

		// Compress is the other explicit cache-invalidation breakpoint — refresh {{memory}}
		// from disk now so any persistent_memory writes during the conversation become visible
		// in the new prefix without invalidating the prefix more than once.
		await this.reloadPersistentMemory();

		// Reset the L2 `previous_response_id` chain. Compress rewrites `instructions`
		// (compressed_history is part of the system prompt), which would auto-fail the next
		// turn's byte-equal-without-input check anyway — but explicit reset avoids the wasted
		// comparison and keeps logs clean.
		try {
			(this.llmClient as { resetConversationState?: () => void }).resetConversationState?.();
		} catch (err: any) {
			logger.warn("context-manager", `Provider state reset failed (non-fatal): ${err.message}`);
		}

		logger.info("context-manager", `[compact ${id}] compress() returned (total ${Date.now() - tStart}ms)`);
	}

	/**
	 * In-chain compaction (preferred): the request is a continuation turn on the SAME
	 * Responses chain as the main session, so:
	 *
	 *   • L1 prompt-cache: server-side cache entry keyed by `prompt_cache_key` is reused —
	 *     instructions, tools, tool_choice, parallel_tool_calls, reasoning, include all
	 *     match the prior turn byte-for-byte. Only the new tail directive + the produced
	 *     summary are billed at full rate.
	 *   • L2 incremental transport: the openai-responses provider's `tryBuildIncremental`
	 *     check passes (non-input fields byte-equal, input is a strict prefix-extension
	 *     by exactly one user message), so the wire payload is `previous_response_id` +
	 *     a single `function_call_output`-free user item. Saves ~99% upstream bytes vs
	 *     a JSON-encoded full conversation blob.
	 *
	 * Returns the parsed summary text, or `null` to signal the caller should fall back
	 * (response empty / tool-calls only / tuning unavailable).
	 */
	private async compressInChain(id: string): Promise<string | null> {
		if (!this.compactTools || !this.compactThinking) {
			logger.warn(
				"context-manager",
				`[compact ${id}] in-chain SKIPPED: tuning not wired (compactTools=${this.compactTools ? "set" : "null"}, compactThinking=${this.compactThinking ?? "null"}). MainAgent.setCompactTuning() may not have been called yet — this WILL fall back to legacy and miss cache.`,
			);
			return null;
		}
		if (this.conversation.length === 0) {
			logger.info("context-manager", `[compact ${id}] in-chain skipped: empty conversation, returning ""`);
			return "";
		}

		const messages: LLMMessage[] = [...this.conversation, { role: "user", content: COMPACT_DIRECTIVE }];

		// Snapshot the exact non-input fields about to be sent. Compare these against the prior
		// regular-turn values in MainAgent.streamLLMResponse — if any of them differ, the L2
		// incremental check WILL fail (tryBuildIncremental requires non-input fields byte-equal
		// to lastFullRequest) and we'll send a full request, missing L2's wire-byte savings.
		const systemPromptForCompact = this.getSystemPrompt();
		const promptCacheKey = this.getConversationId();
		logger.info(
			"context-manager",
			`[compact ${id}] in-chain request fields snapshot: systemPrompt.len=${systemPromptForCompact.length} hash=${djb2Hash(systemPromptForCompact)}, tools.count=${this.compactTools.length} hash=${djb2Hash(JSON.stringify(this.compactTools))}, thinking=${this.compactThinking}, prompt_cache_key=${promptCacheKey}, input.itemsBeforeDirective=${this.conversation.length}, directive.len=${COMPACT_DIRECTIVE.length}`,
		);

		try {
			const response = await this.llmClient.complete(messages, {
				// CRITICAL: every option below MUST match what `MainAgent.streamLLMResponse`
				// passes for the byte-equality / cache-hit path to fire.
				systemPrompt: systemPromptForCompact,
				tools: this.compactTools,
				toolChoice: "auto",
				temperature: 0.2,
				thinking: this.compactThinking,
				promptCacheKey,
			});

			// Defensive: if the model produced tool_calls instead of (or in addition to) the
			// summary text, the on-chain path is unsafe — calling those tools mid-compact is
			// out of scope, and the text portion may be truncated. Bail to legacy.
			const blockTypes = response.contentBlocks.map((b) => b.type).join(",");
			const hasToolCalls = response.contentBlocks.some((b) => b.type === "tool_call");
			const u = response.usage;
			const usageStr = `${u?.inputTokens ?? "?"}/${u?.outputTokens ?? "?"}/${u?.totalTokens ?? "?"}`;
			if (hasToolCalls) {
				logger.warn(
					"context-manager",
					`[compact ${id}] in-chain BAILED: model returned tool_calls. contentBlocks=[${blockTypes}], stopReason=${response.stopReason}, usage(in/out/total)=${usageStr}. Falling back to legacy.`,
				);
				return null;
			}

			const raw = response.content.trim();
			if (!raw) {
				logger.warn(
					"context-manager",
					`[compact ${id}] in-chain BAILED: empty content. contentBlocks=[${blockTypes}], stopReason=${response.stopReason}, usage(in/out/total)=${usageStr}. Falling back to legacy.`,
				);
				return null;
			}

			const summary = extractCompactionSummary(raw);
			const tagFound = /<compaction_summary>/i.test(raw);
			logger.info(
				"context-manager",
				`[compact ${id}] in-chain succeeded: usage(in/out/total)=${usageStr}, stopReason=${response.stopReason}, contentBlocks=[${blockTypes}], rawContent.len=${raw.length}, summary.len=${summary.length}, foundTag=${tagFound}`,
			);
			return summary;
		} catch (err: any) {
			logger.error(
				"context-manager",
				`[compact ${id}] in-chain THREW: ${err.name ?? "Error"}: ${err.message}. Falling back to legacy. Stack: ${err.stack ?? "(no stack)"}`,
			);
			return null;
		}
	}

	/**
	 * Legacy compaction path: a fresh `complete()` call with the `history-compressor.md`
	 * system prompt and a JSON-encoded conversation blob as the sole user message.
	 *
	 * Zero cache reuse — different `instructions` and a single-message `input` mean the
	 * server has no prefix to match. Kept as a safety net for: (a) early startup before
	 * MainAgent wires `setCompactTuning`, (b) in-chain path bailouts (tool_calls / empty /
	 * stream errors), (c) callers that intentionally want a fresh chain.
	 */
	private async compressLegacy(id: string): Promise<string> {
		const existingHistory = this.modules.get("compressed_history") ?? "";
		const input = JSON.stringify({
			existing_history: existingHistory,
			new_conversation: this.conversation.map((m) => ({
				role: m.role,
				content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
			})),
			current_goal: this.modules.get("goal") ?? "",
		});
		logger.info(
			"context-manager",
			`[compact ${id}] legacy LLM call STARTING: input.len=${input.length}, prompt=history-compressor (NO prompt_cache_key, NO chain reuse — full miss expected)`,
		);
		const response = await this.llmClient.complete([{ role: "user", content: input }], {
			systemPrompt: this.promptLoader.resolve("history-compressor"),
			temperature: 0,
		});
		const u = response.usage;
		logger.info(
			"context-manager",
			`[compact ${id}] legacy LLM call returned: usage(in/out/total)=${u?.inputTokens ?? "?"}/${u?.outputTokens ?? "?"}/${u?.totalTokens ?? "?"}, stopReason=${response.stopReason}, content.len=${response.content.length}`,
		);
		return response.content.trim();
	}

	// ─── Memory Flush (Layer 2) ───────────────────────────

	/**
	 * Check if memory flush should run.
	 * Returns true when:
	 * - Token estimate exceeds flush threshold
	 * - No flush has occurred in the current compaction cycle
	 * - MemoryStore is available
	 */
	shouldRunMemoryFlush(): boolean {
		if (!this.memoryStore) return false;
		if (this.lastFlushCompactionCount === this.compactionCount) return false;

		const tokenEstimate = this.getCurrentTokenEstimate();
		// Fallback for first run before any API usage
		if (this.lastKnownTokenCount === 0) {
			const estimated = this.estimateTokens(this.getSystemPrompt()) + this.estimateTokens(this.conversation);
			return estimated > this.contextWindowLimit * this.flushThreshold;
		}
		return tokenEstimate > this.contextWindowLimit * this.flushThreshold;
	}

	/**
	 * Run memory flush: analyze conversation and persist valuable info.
	 * Uses an independent LLM call that does NOT affect the main conversation.
	 */
	async runMemoryFlush(): Promise<void> {
		if (!this.memoryStore) return;

		logger.info("context-manager", "Running memory flush");

		// Build flush prompt from conversation
		const conversationSummary = this.conversation
			.slice(-30) // Last 30 messages (most recent context)
			.map((m) => {
				const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
				return `[${m.role}] ${content.slice(0, 500)}`;
			})
			.join("\n\n");

		const flushPrompt = `Review the following recent conversation and extract valuable information to persist to memory files.\n\n${conversationSummary}`;

		try {
			const flushSystemPrompt = this.promptLoader.resolve("memory-flush");

			const response = await this.llmClient.complete([{ role: "user", content: flushPrompt }], {
				systemPrompt: flushSystemPrompt,
				tools: [
					{
						name: "memory_edit",
						description: "Edit a memory file (append by default)",
						parameters: {
							type: "object",
							properties: {
								path: { type: "string", description: "Relative path" },
								content: { type: "string", description: "Content to append" },
							},
							required: ["path", "content"],
						},
					},
				],
				temperature: 0,
			});

			// Execute any memory_edit tool calls
			const toolCalls = response.contentBlocks.filter((b): b is ToolCallContent => b.type === "tool_call");
			let wroteMemory = false;

			for (const call of toolCalls) {
				if (call.name === "memory_edit") {
					const path = call.arguments.path as string;
					const content = call.arguments.content as string;
					try {
						await this.memoryStore.write({ path, content });
						wroteMemory = true;
						logger.info("context-manager", `Flush wrote to ${path}`);
					} catch (err: any) {
						logger.warn("context-manager", `Flush write failed: ${err.message}`);
					}
				}
			}

			if (wroteMemory && this.syncMemory) {
				try {
					await this.syncMemory();
				} catch (err: any) {
					logger.warn("context-manager", `Memory sync after flush failed: ${err.message}`);
				}
			}
		} catch (err: any) {
			logger.warn("context-manager", `Memory flush failed: ${err.message}`);
		}

		// Always update flush counter (even if nothing was written)
		this.lastFlushCompactionCount = this.compactionCount;
		logger.info("context-manager", "Memory flush complete");
	}

	// ─── Token Estimation (private) ───────────────────────

	private estimateTokens(input: string | LLMMessage[]): number {
		if (typeof input === "string") {
			return Math.ceil(input.length / 4);
		}
		let totalChars = 0;
		for (const msg of input) {
			if (typeof msg.content === "string") {
				totalChars += msg.content.length;
			} else {
				totalChars += JSON.stringify(msg.content).length;
			}
		}
		return Math.ceil(totalChars / 4);
	}
}

// ─── Constants ──────────────────────────────────────────

/**
 * Default context window when neither an explicit override nor a known-model match applies.
 * Deliberately large (500k) to match earlier behavior, but it is provider-specific and unsafe
 * for smaller-window models — hence the loud warning when we fall back to it (see
 * `resolveContextWindowLimit`). Prefer setting `config.context.contextWindowLimit` for any
 * model whose window differs.
 */
const DEFAULT_CONTEXT_WINDOW = 500000;

/**
 * Best-effort context-window sizes (in tokens) keyed by a lowercased SUBSTRING of the model id.
 * Only consulted when no explicit `contextWindowLimit` override is provided. This is intentionally
 * conservative and non-exhaustive: entries are ordered so the FIRST substring that matches the
 * model id wins, so put more-specific ids before broader family prefixes. When a model isn't
 * listed, we fall back to DEFAULT_CONTEXT_WINDOW and log a warning so the operator can pin the
 * real window via config.
 *
 * NOTE: these are the model's TOTAL window; the manager derives its flush/compress/tool-result
 * thresholds as ratios of this value, so an accurate window keeps compaction firing before the
 * provider hard-errors.
 */
const KNOWN_CONTEXT_WINDOWS: Array<[substring: string, tokens: number]> = [
	// Claude — 200k standard window. (The 1M-token beta is opt-in and not implied by the id
	// alone; set config.context.contextWindowLimit=1000000 explicitly for those sessions.)
	["claude", 200000],
	// OpenAI GPT / o-series (Responses + Chat Completions) — 200k class.
	["gpt-5", 400000],
	["gpt-4.1", 1000000],
	["gpt-4o", 128000],
	["gpt-4", 128000],
	["o4", 200000],
	["o3", 200000],
	["o1", 200000],
	// DeepSeek — 128k (v3 / chat / reasoner).
	["deepseek", 128000],
	// Moonshot / Kimi — 128k class (kimi-k2 and friends).
	["kimi", 128000],
	["moonshot", 128000],
	// Google Gemini — 1M+ window.
	["gemini", 1000000],
	// xAI Grok — 128k class.
	["grok", 128000],
	// Mistral large — 128k class.
	["mistral", 128000],
	["ministral", 128000],
	// Qwen — 128k class (long-context variants exist but aren't implied by the base id).
	["qwen", 128000],
];

/**
 * Resolve the effective context window in tokens.
 *
 * Resolution order:
 *   1. explicit `override` (config.context.contextWindowLimit / --context-window) if positive
 *   2. KNOWN_CONTEXT_WINDOWS lookup by model-id substring
 *   3. DEFAULT_CONTEXT_WINDOW (500k) — logged as a loud warning, since it is unsafe for
 *      smaller-window models (compaction would fire far too late and the provider hard-errors).
 */
function resolveContextWindowLimit(override: number | undefined, model: string | undefined): number {
	if (typeof override === "number" && override > 0) {
		return override;
	}
	if (model) {
		const id = model.toLowerCase();
		for (const [substr, tokens] of KNOWN_CONTEXT_WINDOWS) {
			if (id.includes(substr)) {
				logger.info(
					"context-manager",
					`Context window resolved to ${tokens} tokens for model "${model}" (matched "${substr}")`,
				);
				return tokens;
			}
		}
	}
	logger.warn(
		"context-manager",
		`Context window for model "${model ?? "(unknown)"}" is not recognized — falling back to the ${DEFAULT_CONTEXT_WINDOW}-token default. ` +
			`This is provider-specific and may exceed the model's real limit; set config.context.contextWindowLimit (or --context-window) to the model's actual window.`,
	);
	return DEFAULT_CONTEXT_WINDOW;
}

const COMPACTED_PLACEHOLDER = "[compacted: tool output removed to free context]";

const POST_COMPACTION_CONTEXT = `[CONTEXT_RECOVERY] The conversation history has been compressed. Key context is preserved in the compressed_history section of the system prompt. Continue working toward the goal. Use memory_search if you need to recall prior decisions or context.`;

/**
 * Tail user message appended to the existing chain to request a self-compaction summary.
 *
 * Phrasing constraints:
 *   - Must NOT change `instructions` or `tools` (those stay byte-equal so the cache hits)
 *   - Must instruct the model not to call tools (tool_choice stays "auto", but we want text)
 *   - Must wrap output in <compaction_summary> tags so we can deterministically parse it
 *     out of arbitrary surrounding text the model might produce
 */
const COMPACT_DIRECTIVE = `<system_compaction_request>
The conversation history above has approached the context limit. Produce a structured summary that will REPLACE this history while preserving everything required to continue the task without loss of context.

Cover at minimum:
  - User goals, intent, and any constraints they have stated
  - Decisions taken and their rationale (with [YYYY-MM-DD] dates if known)
  - Files, paths, and code references inspected, modified, or referenced
  - Tasks completed and tasks still pending
  - Active agents (tmux session ids, current task), in-flight tool calls, working directories

If your system prompt already contains a compressed_history section from an earlier compaction, fold all of its still-relevant content into this new summary so nothing from earlier compactions is lost.

Output the summary INSIDE <compaction_summary>...</compaction_summary> tags. No preamble, no commentary outside the tags. Do NOT call any tools — produce text only.
</system_compaction_request>`;

/**
 * Extract the contents of `<compaction_summary>...</compaction_summary>` from a model
 * response. If the tag is missing, falls back to the full trimmed response — better to
 * have a slightly noisy summary than a `null` compaction.
 */
function extractCompactionSummary(text: string): string {
	const match = text.match(/<compaction_summary>([\s\S]*?)<\/compaction_summary>/i);
	if (match) return match[1].trim();
	return text.trim();
}

// ─── Dangling tool-call repair ───────────────────────────

/**
 * Placeholder tool result synthesized for an assistant `tool_call` that has no paired
 * `role:"tool"` result in restored history. See `repairDanglingToolCalls`.
 */
const INTERRUPTED_TOOL_RESULT = "[interrupted: no result recorded]";

/**
 * Protocol-agnostic repair for restored conversations: every assistant `tool_call` block must
 * be followed (somewhere later in the message list) by a `role:"tool"` message whose
 * `toolCallId` matches. A crash between persisting the assistant function_call message and its
 * tool result leaves a dangling call that permanently 400s the OpenAI Responses API (and can
 * break Anthropic / Chat-Completions replay too), with no per-provider repair on those paths.
 *
 * This synthesizes a placeholder tool result for each unmatched call and inserts it in the
 * correct position — immediately after the assistant message that issued the call, so the
 * pairing is contiguous. Returns a new array; the input is not mutated. If nothing is dangling
 * the original array is returned unchanged.
 */
function repairDanglingToolCalls(messages: LLMMessage[]): LLMMessage[] {
	// Collect every tool_call_id that already has a matching tool result.
	const resultIds = new Set<string>();
	for (const msg of messages) {
		if (msg.role === "tool" && msg.toolCallId) {
			resultIds.add(msg.toolCallId);
		}
	}

	// Walk the list; whenever an assistant message issues calls that lack a result, splice a
	// synthetic result in right after that message (before any next message is emitted).
	const out: LLMMessage[] = [];
	let repairs = 0;
	for (const msg of messages) {
		out.push(msg);
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
		for (const block of msg.content) {
			if (block.type !== "tool_call") continue;
			if (resultIds.has(block.id)) continue;
			// Guard against duplicate tool_call ids in the same assistant block — only synthesize once.
			resultIds.add(block.id);
			out.push({ role: "tool", content: INTERRUPTED_TOOL_RESULT, toolCallId: block.id });
			repairs++;
			logger.warn(
				"context-manager",
				`Repaired dangling tool_call ${block.name} (id=${block.id}): synthesized "${INTERRUPTED_TOOL_RESULT}"`,
			);
		}
	}

	if (repairs === 0) return messages;
	logger.info("context-manager", `Restore repaired ${repairs} dangling tool_call(s)`);
	return out;
}

// ─── UUID generation ─────────────────────────────────────
// Used for `conversation_id` (prompt_cache_key on the Responses API). Prefers the platform
// `crypto.randomUUID()` (Node ≥14.17, browsers). Falls back to a v4-shaped string built from
// `Math.random()` when randomUUID is unavailable — adequate for cache keys (uniqueness within
// one user's installation is sufficient; the value is not security-sensitive).
/**
 * Tiny non-cryptographic hash for log lines that need to identify "is this string the same
 * as before?" without dumping multi-KB content into the log file. djb2 is fine for this —
 * collision probability is irrelevant when the goal is "did the same value appear in two
 * separate compact runs?". Returns 8-char hex.
 */
function djb2Hash(s: string): string {
	let h = 5381;
	for (let i = 0; i < s.length; i++) {
		h = ((h << 5) + h + s.charCodeAt(i)) | 0;
	}
	return (h >>> 0).toString(16).padStart(8, "0");
}

function generateUuid(): string {
	const g: any = globalThis;
	if (g.crypto?.randomUUID) {
		return g.crypto.randomUUID();
	}
	const hex = (n: number) =>
		Math.floor(Math.random() * 16 ** n)
			.toString(16)
			.padStart(n, "0");
	return `${hex(8)}-${hex(4)}-4${hex(3)}-${(8 + Math.floor(Math.random() * 4)).toString(16)}${hex(3)}-${hex(12)}`;
}
