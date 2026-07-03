import { logger } from "../../utils/logger.js";
import type {
	CompletionOptions,
	LLMMessage,
	LLMProvider,
	LLMResponse,
	LLMStreamEvent,
	MessageContent,
	ProviderConfig,
} from "../types.js";
import { classifyFetchAbort, createConnectTimeout, isTimeoutError, readWithIdleTimeout } from "./stream-timeout.js";

/**
 * OpenAI-compatible provider.
 * Works with: OpenAI, OpenRouter, Moonshot, MiniMax, DeepSeek, Groq,
 *             Together, xAI, Gemini, Mistral, Ollama, vLLM, LM Studio, etc.
 */
export class OpenAICompatibleProvider implements LLMProvider {
	readonly name: string;
	readonly protocol = "openai-compatible" as const;

	private baseUrl: string;
	private apiKey: string;
	private model: string;
	private headers: Record<string, string>;
	private maxRetries: number;
	private timeout: number;
	private fetch: typeof globalThis.fetch;

	constructor(
		config: ProviderConfig,
		opts: { model?: string; apiKey?: string; maxRetries?: number; timeout?: number; fetch?: typeof globalThis.fetch },
	) {
		this.name = config.name;
		this.baseUrl = config.baseUrl.replace(/\/$/, "");
		this.apiKey = opts.apiKey || process.env[config.apiKeyEnvVar] || "";
		this.model = opts.model || config.defaultModel;
		this.headers = config.headers || {};
		this.maxRetries = opts.maxRetries ?? 3;
		this.timeout = opts.timeout ?? 60000;
		this.fetch = opts.fetch ?? globalThis.fetch;
	}

	async complete(messages: LLMMessage[], opts?: CompletionOptions): Promise<LLMResponse> {
		const body = this.buildRequestBody(messages, opts, false);

		logger.debug("llm", `[${this.name}] Calling ${this.model} (non-streaming)`);

		const response = await this.fetchWithRetry(`${this.baseUrl}/chat/completions`, body, opts?.signal);
		const data = await response.json();

		return this.parseResponse(data);
	}

	async *stream(messages: LLMMessage[], opts?: CompletionOptions): AsyncIterable<LLMStreamEvent> {
		const body = this.buildRequestBody(messages, opts, true);

		logger.debug("llm", `[${this.name}] Streaming ${this.model}`);

		const response = await this.fetchWithRetry(`${this.baseUrl}/chat/completions`, body, opts?.signal);

		if (!response.body) {
			throw new Error(`[${this.name}] No response body for streaming`);
		}

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		let fullText = "";
		const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
		let usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
		let stopReason = "stop";
		let model = this.model;
		let lastReasoningTokens: number | undefined;
		// Track whether the terminal `[DONE]` marker was seen. A stream that ends (reader done)
		// WITHOUT it was truncated mid-flight — yielding a normal `done` with partial text would
		// be indistinguishable from a clean finish. We throw a retryable error instead.
		let sawDoneMarker = false;

		try {
			while (true) {
				// Per-read idle watchdog: if the server stops sending bytes mid-stream, cancel and
				// surface a retryable timeout instead of hanging the loop indefinitely.
				const { done, value } = await readWithIdleTimeout(reader, this.timeout, this.name);
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";

				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed || !trimmed.startsWith("data: ")) continue;

					const dataStr = trimmed.slice(6);
					if (dataStr === "[DONE]") {
						sawDoneMarker = true;
						continue;
					}

					let data: any;
					try {
						data = JSON.parse(dataStr);
					} catch {
						continue;
					}

					if (data.model) model = data.model;
					if (data.usage) {
						usage = {
							inputTokens: data.usage.prompt_tokens || 0,
							outputTokens: data.usage.completion_tokens || 0,
							totalTokens: data.usage.total_tokens || 0,
						};
						const reasoningTokens = data.usage.completion_tokens_details?.reasoning_tokens;
						if (typeof reasoningTokens === "number") {
							lastReasoningTokens = reasoningTokens;
						}
					}

					const choice = data.choices?.[0];
					if (!choice) continue;

					if (choice.finish_reason) {
						stopReason = choice.finish_reason;
					}

					const delta = choice.delta;
					if (!delta) continue;

					// Text content
					if (delta.content) {
						fullText += delta.content;
						yield { type: "text_delta", delta: delta.content };
					}

					// Tool calls
					if (delta.tool_calls) {
						for (const tc of delta.tool_calls) {
							const idx = tc.index ?? 0;
							if (!toolCalls.has(idx)) {
								toolCalls.set(idx, { id: tc.id || "", name: tc.function?.name || "", arguments: "" });
							}
							const existing = toolCalls.get(idx)!;
							if (tc.id) existing.id = tc.id;
							if (tc.function?.name) existing.name = tc.function.name;
							if (tc.function?.arguments) existing.arguments += tc.function.arguments;

							yield {
								type: "tool_call_delta",
								index: idx,
								id: existing.id || undefined,
								name: existing.name || undefined,
								argumentsDelta: tc.function?.arguments || "",
							};
						}
					}
				}
			}
		} finally {
			reader.releaseLock();
		}

		// The reader reached `done` without ever seeing `[DONE]`: the connection dropped
		// mid-stream. Yielding a `done` event here would look like a clean finish with truncated
		// text. Throw a retryable transient error so callers (and openai-responses-style retry)
		// can retry instead of silently accepting a partial response.
		if (!sawDoneMarker) {
			const err = new Error(
				`[${this.name}] stream ended before [DONE] marker — connection dropped mid-stream (truncated response)`,
			) as Error & { retryable?: boolean };
			err.retryable = true;
			throw err;
		}

		if (lastReasoningTokens !== undefined && lastReasoningTokens > 0) {
			const msg = `[${this.name}] reasoning_tokens=${lastReasoningTokens}`;
			logger.info("llm", msg);
			console.log(`[cliclaw] ${msg}`);
		} else if (opts?.thinking && opts.thinking !== "off") {
			const msg = `[${this.name}] reasoning_effort requested but reasoning_tokens=0 (model may ignore the field)`;
			logger.info("llm", msg);
			console.log(`[cliclaw] ${msg}`);
		}

		// Build content blocks
		const contentBlocks: MessageContent[] = [];
		if (fullText) {
			contentBlocks.push({ type: "text", text: fullText });
		}
		for (const [, tc] of toolCalls) {
			let args: Record<string, any> = {};
			try {
				args = JSON.parse(tc.arguments);
			} catch {
				// Keep as empty
			}
			contentBlocks.push({ type: "tool_call", id: tc.id, name: tc.name, arguments: args });
		}

		yield {
			type: "done",
			response: {
				content: fullText,
				contentBlocks,
				usage,
				stopReason,
				model,
			},
		};
	}

	// ─── Internal ────────────────────────────────────────

	private buildRequestBody(messages: LLMMessage[], opts?: CompletionOptions, stream = false): any {
		const body: any = {
			model: this.model,
			stream,
			...(opts?.maxTokens ? { max_tokens: opts.maxTokens } : {}),
		};

		if (stream) {
			body.stream_options = { include_usage: true };
		}

		if (opts?.temperature !== undefined) {
			body.temperature = opts.temperature;
		}

		if (opts?.responseFormat === "json") {
			body.response_format = { type: "json_object" };
		}

		// Reasoning effort (GPT-5 / o-series and other compatible providers).
		// ThinkingLevel values map 1:1 onto the OpenAI `reasoning_effort` field.
		if (opts?.thinking && opts.thinking !== "off") {
			body.reasoning_effort = opts.thinking;
			const msg = `[${this.name}] reasoning_effort=${opts.thinking}`;
			logger.info("llm", msg);
			console.log(`[cliclaw] ${msg}`);
		} else {
			logger.debug("llm", `[${this.name}] reasoning_effort off (level=${opts?.thinking ?? "undefined"})`);
		}

		// Convert messages
		body.messages = this.convertMessages(messages, opts?.systemPrompt);

		// Tools
		if (opts?.tools && opts.tools.length > 0) {
			body.tools = opts.tools.map((t) => ({
				type: "function",
				function: {
					name: t.name,
					description: t.description,
					parameters: t.parameters,
				},
			}));

			if (opts.toolChoice) {
				if (typeof opts.toolChoice === "string") {
					body.tool_choice = opts.toolChoice;
				} else {
					body.tool_choice = { type: "function", function: { name: opts.toolChoice.name } };
				}
			}
		}

		return body;
	}

	private convertMessages(messages: LLMMessage[], systemPrompt?: string): any[] {
		const result: any[] = [];

		// System prompt (from option or from messages)
		const systemMsg = systemPrompt || messages.find((m) => m.role === "system");
		if (systemMsg) {
			result.push({
				role: "system",
				content: typeof systemMsg === "string" ? systemMsg : (systemMsg as LLMMessage).content,
			});
		}

		for (const msg of messages) {
			if (msg.role === "system") continue;

			if (msg.role === "tool") {
				result.push({
					role: "tool",
					tool_call_id: msg.toolCallId,
					content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
				});
				continue;
			}

			if (typeof msg.content === "string") {
				const converted: any = { role: msg.role, content: msg.content };

				// If assistant message with tool calls in contentBlocks, we'd need to handle that
				// For now, simple string content
				result.push(converted);
			} else {
				// Array content — handle multimodal
				const parts: any[] = [];
				const toolCallsParts: any[] = [];

				for (const block of msg.content) {
					switch (block.type) {
						case "text":
							parts.push({ type: "text", text: block.text });
							break;
						case "image":
							parts.push({
								type: "image_url",
								image_url: {
									url: `data:${block.mimeType};base64,${block.data}`,
								},
							});
							break;
						case "tool_call":
							toolCallsParts.push({
								id: block.id,
								type: "function",
								function: {
									name: block.name,
									arguments: JSON.stringify(block.arguments),
								},
							});
							break;
						case "thinking":
							// OpenAI/compatible protocols treat reasoning as model-private state.
							// Do not echo it back into the next request — the model re-reasons fresh,
							// and replaying it risks polluting context, leaking encrypted-summary tokens,
							// or being treated as user-supplied facts.
							break;
					}
				}

				const converted: any = { role: msg.role };
				if (parts.length > 0) {
					converted.content = parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts;
				}
				if (toolCallsParts.length > 0) {
					converted.tool_calls = toolCallsParts;
				}
				result.push(converted);
			}
		}

		return result;
	}

	private async fetchWithRetry(url: string, body: any, signal?: AbortSignal): Promise<Response> {
		let lastError: Error | null = null;

		for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
			try {
				const headers: Record<string, string> = {
					"Content-Type": "application/json",
					...this.headers,
				};

				if (this.apiKey) {
					headers.Authorization = `Bearer ${this.apiKey}`;
				}

				// Connect-phase timeout, scoped to time-to-response-headers only: the timer is
				// disarmed the moment fetch settles, so a healthy long-running body (streaming or
				// a slow non-streaming complete()) is never aborted mid-flight — body stalls are
				// guarded by the per-read idle watchdog instead. A caller abort surfaces as
				// AbortError (non-retryable); the timeout leg as a retryable TimeoutError (see catch).
				const connect = createConnectTimeout(signal, this.timeout);
				let response: Response;
				try {
					response = await this.fetch(url, {
						method: "POST",
						headers,
						body: JSON.stringify(body),
						signal: connect.signal,
					});
				} finally {
					connect.disarm();
				}

				if (response.ok) {
					return response;
				}

				// Rate limit — retry with backoff
				if (response.status === 429 || response.status >= 500) {
					const retryAfter = response.headers.get("retry-after");
					const delay = retryAfter ? parseInt(retryAfter, 10) * 1000 : Math.min(1000 * 2 ** attempt, this.timeout);

					logger.warn("llm", `[${this.name}] ${response.status}, retrying in ${delay}ms (attempt ${attempt + 1})`);
					await new Promise((r) => setTimeout(r, delay));
					continue;
				}

				// Client error — don't retry
				const errorBody = await response.text().catch(() => "");
				throw new Error(`[${this.name}] API error ${response.status}: ${errorBody.substring(0, 500)}`);
			} catch (err: any) {
				// AbortError from the composed signal is either the caller aborting (rethrow) or
				// our own connect timeout firing (convert to a retryable TimeoutError, fall through
				// to retry). classifyFetchAbort discriminates via the caller's signal state.
				let effectiveErr: any = err;
				if (err.name === "AbortError" || err.name === "TimeoutError") {
					const classified = classifyFetchAbort(err, signal, this.name);
					if (!isTimeoutError(classified)) throw classified;
					effectiveErr = classified;
				}
				lastError = effectiveErr;

				if (attempt < this.maxRetries) {
					const delay = Math.min(1000 * 2 ** attempt, this.timeout);
					logger.warn("llm", `[${this.name}] Request failed, retrying in ${delay}ms: ${effectiveErr.message}`);
					await new Promise((r) => setTimeout(r, delay));
				}
			}
		}

		throw lastError || new Error(`[${this.name}] Request failed after ${this.maxRetries} retries`);
	}

	private parseResponse(data: any): LLMResponse {
		const choice = data.choices?.[0];
		const message = choice?.message;

		const text = message?.content || "";
		const contentBlocks: MessageContent[] = [];

		if (text) {
			contentBlocks.push({ type: "text", text });
		}

		// Tool calls
		if (message?.tool_calls) {
			for (const tc of message.tool_calls) {
				let args: Record<string, any> = {};
				try {
					args = JSON.parse(tc.function.arguments);
				} catch {
					// Keep empty
				}
				contentBlocks.push({
					type: "tool_call",
					id: tc.id,
					name: tc.function.name,
					arguments: args,
				});
			}
		}

		const reasoningTokens = data.usage?.completion_tokens_details?.reasoning_tokens;
		if (reasoningTokens && reasoningTokens > 0) {
			const msg = `[${this.name}] reasoning_tokens=${reasoningTokens}`;
			logger.info("llm", msg);
			console.log(`[cliclaw] ${msg}`);
		}

		return {
			content: text,
			contentBlocks,
			usage: {
				inputTokens: data.usage?.prompt_tokens || 0,
				outputTokens: data.usage?.completion_tokens || 0,
				totalTokens: data.usage?.total_tokens || 0,
			},
			stopReason: choice?.finish_reason || "stop",
			model: data.model || this.model,
		};
	}
}
