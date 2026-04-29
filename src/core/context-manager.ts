import type { LLMClient } from "../llm/client.js";
import type { PromptLoader } from "../llm/prompt-loader.js";
import type { LLMMessage, ToolCallContent } from "../llm/types.js";
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
	contextWindowLimit?: number;
	compressionThreshold?: number;
	/** Memory flush threshold (ratio of contextWindowLimit). Must be < compressionThreshold. Default 0.6. */
	flushThreshold?: number;
	/** MemoryStore for flush writes (optional — flush disabled if not provided) */
	memoryStore?: MemoryStore;
	/** Optional callback to sync indexed memory after writes. */
	syncMemory?: () => Promise<void>;
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

	// Hybrid token counting
	private lastKnownTokenCount = 0;
	private pendingChars = 0;

	// Memory Flush state
	private memoryStore: MemoryStore | null;
	private syncMemory: (() => Promise<void>) | null;
	private compactionCount = 0;
	private lastFlushCompactionCount = -1;

	// Conversation persistence
	private conversationStore: ConversationStore | null;

	constructor(config: ContextManagerConfig) {
		this.llmClient = config.llmClient;
		this.promptLoader = config.promptLoader;
		this.contextWindowLimit = config.contextWindowLimit ?? 500000;
		this.compressionThreshold = config.compressionThreshold ?? 0.7;
		this.flushThreshold = config.flushThreshold ?? 0.6;
		this.toolResultRetention = config.toolResultRetention ?? 20;
		this.memoryStore = config.memoryStore ?? null;
		this.syncMemory = config.syncMemory ?? null;
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
		this.conversation = messages;

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

		// 4. Restore counters
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

		// 6. Inject restart context so LLM knows it was restored — but skip if
		// the previous message is already a restore notice (avoids piling up
		// identical injections when the server restarts repeatedly without
		// any new conversation activity in between).
		const restoredCount = messages.length;
		if (restoredCount > 0) {
			const last = this.conversation[this.conversation.length - 1];
			const lastIsRestore =
				last &&
				last.role === "user" &&
				typeof last.content === "string" &&
				last.content.startsWith("[SESSION_RESTORED]");
			if (!lastIsRestore) {
				const restoreNotice = `[SESSION_RESTORED] 服务已重启。上次会话的 ${restoredCount} 条消息已从数据库恢复到对话上下文中。你可以继续之前的工作。${this.modules.has("compressed_history") ? "此前的对话已压缩并保存在 compressed_history 中。" : ""}`;
				this.conversation.push({ role: "user", content: restoreNotice });
				// Persist the restore notice so it becomes part of the conversation
				store.saveMessage({ role: "user", content: restoreNotice });
			} else {
				logger.info("context-manager", "Skipped restore notice — last message already is one");
			}
		}

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
				msg.content = msg.content.slice(0, singleCapChars) + "\n...[truncated]";
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
		const summary = firstLine.length > 150 ? firstLine.slice(0, 150) + "..." : firstLine;
		return `[${toolName} → ${status}] ${summary}`;
	}

	/**
	 * Truncate long string arguments in a tool_call content block.
	 */
	private truncateToolCallArgs(block: ToolCallContent): void {
		for (const [key, value] of Object.entries(block.arguments)) {
			if (typeof value === "string" && value.length > 200) {
				block.arguments[key] = value.slice(0, 200) + "...";
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

	async compress(): Promise<void> {
		const existingHistory = this.modules.get("compressed_history") ?? "";

		logger.info("context-manager", `Compressing conversation (${this.conversation.length} messages)`);

		const input = JSON.stringify({
			existing_history: existingHistory,
			new_conversation: this.conversation.map((m) => ({
				role: m.role,
				content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
			})),
			current_goal: this.modules.get("goal") ?? "",
		});

		const response = await this.llmClient.complete([{ role: "user", content: input }], {
			systemPrompt: this.promptLoader.resolve("history-compressor"),
			temperature: 0,
		});

		this.modules.set("compressed_history", response.content.trim());
		this.conversation = [];
		this.compactionCount++;

		// Reset token counting after compaction
		this.lastKnownTokenCount = 0;
		this.pendingChars = 0;

		// Persist compressed state to SQLite: clear first, then save (atomic sequence)
		if (this.conversationStore) {
			this.conversationStore.clearAll();
			this.conversationStore.saveContextState("compressed_history", response.content.trim());
			this.conversationStore.saveContextState("compaction_count", String(this.compactionCount));
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

		logger.info("context-manager", "Conversation compressed and reset");
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

const COMPACTED_PLACEHOLDER = "[compacted: tool output removed to free context]";

const POST_COMPACTION_CONTEXT = `[CONTEXT_RECOVERY] The conversation history has been compressed. Key context is preserved in the compressed_history section of the system prompt. Continue working toward the goal. Use memory_search if you need to recall prior decisions or context.`;
