// ─── Messages ────────────────────────────────────────────

export interface TextContent {
	type: "text";
	text: string;
}

export interface ImageContent {
	type: "image";
	data: string; // base64
	mimeType: string;
}

export interface ToolCallContent {
	type: "tool_call";
	id: string;
	name: string;
	arguments: Record<string, any>;
}

export interface ThinkingContent {
	type: "thinking";
	thinking: string;
	/**
	 * Anthropic extended-thinking signature. The API requires the original `signature`
	 * to be replayed verbatim alongside the thinking text in tool-use loops — a
	 * signature-less thinking block is rejected. Legacy history persisted before this
	 * field existed will have `signature` undefined; the anthropic provider DROPS such
	 * blocks on replay rather than sending them signature-less.
	 */
	signature?: string;
}

/**
 * Reasoning trace produced by the OpenAI Responses API for reasoning-capable models.
 *
 * `encryptedContent` is opaque to the client and MUST be replayed verbatim in the next
 * turn's `input` so the server can reconstruct the model's prior chain-of-thought without
 * exposing raw reasoning tokens. This is the mechanism that lets prompt-cache prefixes
 * survive across turns for reasoning models (see Codex `include = ["reasoning.encrypted_content"]`).
 *
 * `summary` and `content` are display-only / debugging mirrors of what the server emits
 * via `response.reasoning_summary_text.delta` / `response.reasoning_text.delta`. They are
 * NOT required for replay — only `encryptedContent` matters for cache continuity.
 *
 * Other protocols (Chat Completions, Anthropic) ignore this block on input; the
 * openai-responses provider is the only one that round-trips it.
 */
export interface ReasoningContent {
	type: "reasoning";
	/** Opaque blob from the server — replay verbatim in the next turn's input. */
	encryptedContent: string | null;
	/** Optional human-readable summary segments (`response.reasoning_summary_text`). */
	summary?: string[];
	/** Optional chain-of-thought text segments (`response.reasoning_text`). */
	content?: string[];
}

export type MessageContent = TextContent | ImageContent | ToolCallContent | ThinkingContent | ReasoningContent;

export interface LLMMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: string | MessageContent[];
	/** For role: "tool" — the tool_call_id this result responds to */
	toolCallId?: string;
	name?: string;
}

// ─── Tools ───────────────────────────────────────────────

export interface ToolParameter {
	type: string;
	description?: string;
	enum?: string[];
	items?: ToolParameter;
	properties?: Record<string, ToolParameter>;
	required?: string[];
}

export interface ToolDefinition {
	name: string;
	description: string;
	parameters: {
		type: "object";
		properties: Record<string, ToolParameter>;
		required?: string[];
	};
}

// ─── Response ────────────────────────────────────────────

export interface LLMUsage {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
}

export interface LLMResponse {
	content: string;
	contentBlocks: MessageContent[];
	usage: LLMUsage;
	stopReason: string;
	model: string;
}

// ─── Streaming ───────────────────────────────────────────

export type LLMStreamEvent =
	| { type: "text_delta"; delta: string }
	| { type: "thinking_delta"; delta: string }
	| { type: "reasoning_summary_delta"; delta: string; summaryIndex: number }
	| { type: "reasoning_content_delta"; delta: string; contentIndex: number }
	| { type: "tool_call_delta"; index: number; id?: string; name?: string; argumentsDelta: string }
	| { type: "done"; response: LLMResponse };

// ─── Options ─────────────────────────────────────────────

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high";

/** Display verbosity hint for the OpenAI Responses API `text.verbosity` field. */
export type Verbosity = "low" | "medium" | "high";

/** Reasoning summary granularity for OpenAI Responses (`reasoning.summary`). */
export type ReasoningSummaryLevel = "auto" | "concise" | "detailed";

export interface CompletionOptions {
	temperature?: number;
	maxTokens?: number;
	signal?: AbortSignal;
	systemPrompt?: string;
	tools?: ToolDefinition[];
	toolChoice?: "auto" | "none" | "required" | { name: string };
	responseFormat?: "text" | "json";
	thinking?: ThinkingLevel;
	/**
	 * Stable cache key for the OpenAI Responses API (`prompt_cache_key`).
	 * MUST equal the conversation_id and stay constant for the lifetime of the session
	 * so the server hits the same cache entry across turns. Other providers ignore.
	 */
	promptCacheKey?: string;
	/**
	 * Reasoning summary level for OpenAI Responses (`reasoning.summary`).
	 *
	 * - `undefined` (omitted) → defaults to `"auto"` (matches Codex `ReasoningSummaryConfig::Auto`).
	 *   Server emits `response.reasoning_summary_text.delta` events.
	 * - `"auto" / "concise" / "detailed"` → explicit level.
	 * - `null` → suppress summaries entirely (Codex `ReasoningSummaryConfig::None`).
	 *   The `summary` field is omitted from the wire request.
	 *
	 * Other providers ignore this option.
	 */
	reasoningSummary?: ReasoningSummaryLevel | null;
	/**
	 * Display verbosity hint for OpenAI Responses (`text.verbosity`).
	 * Other providers ignore.
	 */
	verbosity?: Verbosity;
}

// ─── Provider ────────────────────────────────────────────

export type ProviderProtocol = "openai-compatible" | "anthropic" | "openai-responses";

export interface ProviderConfig {
	/** Unique provider identifier */
	name: string;
	/** Display name */
	displayName: string;
	/** Which API protocol to use */
	protocol: ProviderProtocol;
	/** Base URL for the API */
	baseUrl: string;
	/** Environment variable name for the API key */
	apiKeyEnvVar: string;
	/** Default model ID */
	defaultModel: string;
	/** Available models (optional, for listing) */
	models?: string[];
	/** Custom headers to include in requests */
	headers?: Record<string, string>;
}

export interface LLMClientOptions {
	provider: string;
	model?: string;
	apiKey?: string;
	baseUrl?: string;
	/** HTTP/HTTPS/SOCKS proxy URL. Only affects this LLMClient's outbound requests. */
	proxy?: string;
	maxRetries?: number;
	timeout?: number;
}

// ─── Provider Implementation Interface ───────────────────

export interface LLMProvider {
	readonly name: string;
	readonly protocol: ProviderProtocol;

	complete(messages: LLMMessage[], opts?: CompletionOptions): Promise<LLMResponse>;
	stream(messages: LLMMessage[], opts?: CompletionOptions): AsyncIterable<LLMStreamEvent>;
}
