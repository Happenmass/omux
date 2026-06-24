import { logger } from "../utils/logger.js";
import { AnthropicProvider } from "./providers/anthropic.js";
import { OpenAICompatibleProvider } from "./providers/openai-compatible.js";
import { OpenAIResponsesProvider } from "./providers/openai-responses.js";
import { resolveProvider } from "./providers/registry.js";
import { createProxyFetch } from "./proxy.js";
import type {
	CompletionOptions,
	LLMClientOptions,
	LLMMessage,
	LLMProvider,
	LLMResponse,
	LLMStreamEvent,
} from "./types.js";

/**
 * Unified LLM client that dispatches to the correct provider based on protocol.
 *
 * Usage:
 *   const client = new LLMClient({ provider: "openai", model: "gpt-5.4" });
 *   const client = new LLMClient({ provider: "anthropic", model: "claude-sonnet-4-6" });
 *   const client = new LLMClient({ provider: "openrouter", model: "openai/gpt-5.4" });
 *   const client = new LLMClient({ provider: "moonshot", model: "kimi-k2.5" });
 *   const client = new LLMClient({ provider: "deepseek" });   // uses default model
 *   const client = new LLMClient({ provider: "ollama", model: "llama4" });
 *
 * Custom provider:
 *   const client = new LLMClient({ provider: "my-corp", baseUrl: "https://llm.my-corp.com/v1", model: "internal-v2" });
 */
export class LLMClient {
	private provider: LLMProvider;
	private providerName: string;
	private currentModel: string;

	constructor(opts: LLMClientOptions) {
		this.providerName = opts.provider;
		const config = resolveProvider(opts.provider, {
			baseUrl: opts.baseUrl,
			apiKey: opts.apiKey,
		});

		this.currentModel = opts.model || config.defaultModel;

		const proxyFetch = opts.proxy ? createProxyFetch(opts.proxy) : undefined;
		if (proxyFetch) {
			logger.info("llm", `Proxy enabled for main-agent LLM calls: ${opts.proxy}`);
		}

		const providerOpts = {
			model: this.currentModel,
			apiKey: opts.apiKey,
			maxRetries: opts.maxRetries,
			timeout: opts.timeout,
			fetch: proxyFetch,
		};

		switch (config.protocol) {
			case "anthropic":
				this.provider = new AnthropicProvider(config, providerOpts);
				break;
			case "openai-responses":
				this.provider = new OpenAIResponsesProvider(config, providerOpts);
				break;
			case "openai-compatible":
			default:
				this.provider = new OpenAICompatibleProvider(config, providerOpts);
				break;
		}

		logger.info("llm", `Initialized ${config.displayName} provider (model: ${this.currentModel})`);
	}

	async complete(messages: LLMMessage[], opts?: CompletionOptions): Promise<LLMResponse> {
		return this.provider.complete(messages, opts);
	}

	async *stream(messages: LLMMessage[], opts?: CompletionOptions): AsyncIterable<LLMStreamEvent> {
		yield* this.provider.stream(messages, opts);
	}

	/**
	 * Complete and parse the response as JSON.
	 * Handles markdown code blocks wrapping the JSON.
	 */
	async completeJson<T = any>(messages: LLMMessage[], opts?: CompletionOptions): Promise<T> {
		const response = await this.complete(messages, opts);
		const content = response.content.trim();
		const jsonStr = extractJson(content);

		try {
			return JSON.parse(jsonStr);
		} catch (err) {
			logger.error("llm", `Failed to parse JSON response: ${content.substring(0, 300)}`);
			throw new Error(`LLM returned invalid JSON: ${(err as Error).message}`);
		}
	}

	getModel(): string {
		return this.currentModel;
	}

	getProviderName(): string {
		return this.providerName;
	}

	getProtocol(): string {
		return this.provider.protocol;
	}

	/**
	 * Reset any provider-internal state that's tied to a specific conversation.
	 *
	 * Currently this is the OpenAI Responses provider's Layer-2 incremental chain
	 * (`previous_response_id` baseline). Callers MUST invoke this whenever the
	 * `prompt_cache_key` (a.k.a. `conversation_id`) changes — most importantly after
	 * `/clear` and `/reset`, since the next turn will use a fresh cache key and the
	 * prior server-side response state belongs to the old session.
	 *
	 * No-op for providers that have no per-conversation state (chat-completions, anthropic).
	 */
	resetConversationState(): void {
		const p: any = this.provider;
		if (typeof p.resetIncrementalChain === "function") {
			p.resetIncrementalChain();
		}
	}
}

/**
 * Extract JSON from LLM response text.
 * Tries multiple strategies to handle different LLM output formats:
 * 1. Direct JSON parse (already clean)
 * 2. Markdown code block extraction (```json ... ```, ````json ... ````, etc.)
 * 3. First/last bracket matching ({ ... } or [ ... ])
 */
function extractJson(content: string): string {
	const trimmed = content.trim();

	// Strategy 1: Already valid JSON
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		return trimmed;
	}

	// Strategy 2: Markdown code blocks with variable backtick count (3+)
	// Also handles truncated blocks (missing closing ```)
	const codeBlockMatch = trimmed.match(/`{3,}(?:json)?\s*\n([\s\S]*?)(?:\n\s*`{3,}|$)/);
	if (codeBlockMatch) {
		return codeBlockMatch[1].trim();
	}

	// Strategy 3: Find outermost JSON structure by bracket matching
	const firstBrace = trimmed.indexOf("{");
	const firstBracket = trimmed.indexOf("[");
	let start = -1;
	let openChar: string;
	let closeChar: string;

	if (firstBrace === -1 && firstBracket === -1) {
		return trimmed;
	}
	if (firstBrace === -1) {
		start = firstBracket;
		openChar = "[";
		closeChar = "]";
	} else if (firstBracket === -1) {
		start = firstBrace;
		openChar = "{";
		closeChar = "}";
	} else if (firstBracket < firstBrace) {
		start = firstBracket;
		openChar = "[";
		closeChar = "]";
	} else {
		start = firstBrace;
		openChar = "{";
		closeChar = "}";
	}

	// Find matching close bracket from the end
	let depth = 0;
	let end = -1;
	for (let i = start; i < trimmed.length; i++) {
		if (trimmed[i] === openChar) depth++;
		else if (trimmed[i] === closeChar) depth--;
		if (depth === 0) {
			end = i;
			break;
		}
	}

	if (end !== -1) {
		return trimmed.slice(start, end + 1);
	}

	return trimmed;
}
