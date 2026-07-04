import Anthropic from "@anthropic-ai/sdk";
import { logger } from "../../utils/logger.js";
import type {
	CompletionOptions,
	LLMMessage,
	LLMProvider,
	LLMResponse,
	LLMStreamEvent,
	MessageContent,
	ProviderConfig,
	ThinkingLevel,
} from "../types.js";

const THINKING_BUDGET: Record<ThinkingLevel, number> = {
	off: 0,
	minimal: 1024,
	low: 4096,
	medium: 8192,
	high: 16384,
};

/**
 * Anthropic provider using the official SDK.
 * Anthropic's API format differs from OpenAI's — system prompt is a separate field,
 * tool calls use a different schema, and thinking/extended output has unique handling.
 */
export class AnthropicProvider implements LLMProvider {
	readonly name: string;
	readonly protocol = "anthropic" as const;

	private client: Anthropic;
	private model: string;

	constructor(
		config: ProviderConfig,
		opts: { model?: string; apiKey?: string; maxRetries?: number; timeout?: number; fetch?: typeof globalThis.fetch },
	) {
		this.name = config.name;
		this.model = opts.model || config.defaultModel;
		this.client = new Anthropic({
			apiKey: opts.apiKey || process.env[config.apiKeyEnvVar],
			maxRetries: opts.maxRetries ?? 3,
			timeout: opts.timeout ?? 60000,
			...(opts.fetch ? { fetch: opts.fetch as any } : {}),
		});
	}

	async complete(messages: LLMMessage[], opts?: CompletionOptions): Promise<LLMResponse> {
		const { systemPrompt, chatMessages } = this.convertMessages(messages, opts?.systemPrompt);

		logger.debug("llm", `[anthropic] Calling ${this.model} (non-streaming)`);

		const params = this.buildParams(chatMessages, systemPrompt, opts, false);
		const response = await this.client.messages.create(params as any);

		return this.parseResponse(response);
	}

	async *stream(messages: LLMMessage[], opts?: CompletionOptions): AsyncIterable<LLMStreamEvent> {
		const { systemPrompt, chatMessages } = this.convertMessages(messages, opts?.systemPrompt);

		logger.debug("llm", `[anthropic] Streaming ${this.model}`);

		const params = this.buildParams(chatMessages, systemPrompt, opts, true);
		const stream = this.client.messages.stream(params as any);

		let thinkingChars = 0;
		// Track the id/name of each tool_use block by its content-block index. Anthropic only
		// carries these on `content_block_start`; the `input_json_delta` events that follow have
		// index + partial_json only. Cache them here so every tool_call_delta can surface the
		// id/name (matching openai-compatible's event shape).
		const toolBlockByIndex = new Map<number, { id: string; name: string }>();

		for await (const event of stream) {
			if (event.type === "content_block_start") {
				const block = event.content_block;
				if (block.type === "tool_use") {
					toolBlockByIndex.set(event.index, { id: block.id, name: block.name });
					// Emit an opening tool_call_delta carrying id + name so downstream consumers
					// have them before the argument deltas start streaming (no args yet).
					yield {
						type: "tool_call_delta",
						index: event.index,
						id: block.id,
						name: block.name,
						argumentsDelta: "",
					};
				}
			} else if (event.type === "content_block_delta") {
				if (event.delta.type === "text_delta") {
					yield { type: "text_delta", delta: event.delta.text };
				} else if (event.delta.type === "thinking_delta") {
					const chunk = event.delta.thinking ?? "";
					thinkingChars += chunk.length;
					yield { type: "thinking_delta", delta: chunk };
				} else if (event.delta.type === "input_json_delta") {
					const block = toolBlockByIndex.get(event.index);
					yield {
						type: "tool_call_delta",
						index: event.index,
						id: block?.id,
						name: block?.name,
						argumentsDelta: event.delta.partial_json || "",
					};
				}
			}
		}

		if (thinkingChars > 0) {
			const msg = `[anthropic] thinking received: ${thinkingChars} chars`;
			logger.info("llm", msg);
			console.log(`[omux] ${msg}`);
		} else if (opts?.thinking && opts.thinking !== "off") {
			const msg = `[anthropic] thinking requested but NO thinking content returned (model may not support extended thinking)`;
			logger.info("llm", msg);
			console.log(`[omux] ${msg}`);
		}

		const finalMessage = await stream.finalMessage();
		const response = this.parseResponse(finalMessage);

		yield {
			type: "done",
			response,
		};
	}

	// ─── Internal ────────────────────────────────────────

	private buildParams(
		chatMessages: Anthropic.MessageParam[],
		systemPrompt: string | Anthropic.TextBlockParam[] | undefined,
		opts?: CompletionOptions,
		_stream = false,
	): any {
		const params: any = {
			model: this.model,
			messages: chatMessages,
		};

		if (opts?.maxTokens) {
			params.max_tokens = opts.maxTokens;
		}

		// Prompt caching: mark the stable prefix with `cache_control` breakpoints so the API
		// reuses cached tokens across turns instead of re-billing the full prefix each time.
		// Anthropic allows at most 4 breakpoints; we place one on the system block, one on the
		// last tool, and one on the last message (see convertMessages), staying well under 4.
		if (systemPrompt) {
			if (typeof systemPrompt === "string") {
				params.system = [
					{
						type: "text",
						text: systemPrompt,
						cache_control: { type: "ephemeral" },
					},
				];
			} else {
				params.system = systemPrompt;
			}
		}

		if (opts?.temperature !== undefined) {
			params.temperature = opts.temperature;
		}

		// Thinking / extended thinking
		if (opts?.thinking && opts.thinking !== "off") {
			const budget = THINKING_BUDGET[opts.thinking];
			params.thinking = {
				type: "enabled",
				budget_tokens: budget,
			};
			// Extended thinking requires higher max_tokens; resolve missing value before comparing.
			const minMaxTokens = budget + 1024;
			const resolvedMaxTokens = typeof params.max_tokens === "number" ? params.max_tokens : 0;
			if (resolvedMaxTokens < minMaxTokens) {
				params.max_tokens = budget + 4096;
			}
			const msg = `[anthropic] thinking enabled: level=${opts.thinking} budget_tokens=${budget} max_tokens=${params.max_tokens}`;
			logger.info("llm", msg);
			console.log(`[omux] ${msg}`);
		} else {
			logger.debug("llm", `[anthropic] thinking off (level=${opts?.thinking ?? "undefined"})`);
		}

		// Tools
		if (opts?.tools && opts.tools.length > 0) {
			params.tools = opts.tools.map((t, i) => ({
				name: t.name,
				description: t.description,
				input_schema: t.parameters,
				// Cache breakpoint on the LAST tool caches the whole (stable) tool block.
				...(i === opts.tools!.length - 1 ? { cache_control: { type: "ephemeral" } } : {}),
			}));

			if (opts.toolChoice) {
				if (opts.toolChoice === "auto") {
					params.tool_choice = { type: "auto" };
				} else if (opts.toolChoice === "none") {
					// Anthropic doesn't have "none" — just don't send tools
					delete params.tools;
				} else if (opts.toolChoice === "required") {
					params.tool_choice = { type: "any" };
				} else if (typeof opts.toolChoice === "object") {
					params.tool_choice = { type: "tool", name: opts.toolChoice.name };
				}
			}
		}

		return params;
	}

	private convertMessages(
		messages: LLMMessage[],
		systemPromptOverride?: string,
	): { systemPrompt: string | undefined; chatMessages: Anthropic.MessageParam[] } {
		let systemPrompt = systemPromptOverride;

		// Extract system prompt from messages if not provided
		if (!systemPrompt) {
			const systemMsg = messages.find((m) => m.role === "system");
			if (systemMsg) {
				systemPrompt = typeof systemMsg.content === "string" ? systemMsg.content : undefined;
			}
		}

		const chatMessages: Anthropic.MessageParam[] = [];
		// Tracks the user message currently accumulating tool_result blocks, so consecutive
		// `role:"tool"` messages (parallel tool calls) coalesce into ONE user turn. Anthropic
		// expects every tool_result answering the prior assistant turn in the single next user
		// message — separate user messages per result would break the tool-use protocol.
		let pendingToolResult: { role: "user"; content: any[] } | null = null;

		for (const msg of messages) {
			if (msg.role === "system") continue;

			if (msg.role === "tool") {
				// Anthropic uses tool_result blocks
				const toolResultBlock = {
					type: "tool_result",
					tool_use_id: msg.toolCallId || "",
					content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
				} as any;
				if (pendingToolResult) {
					// Coalesce into the in-progress tool-result user message.
					pendingToolResult.content.push(toolResultBlock);
				} else {
					const toolMsg = { role: "user" as const, content: [toolResultBlock] };
					chatMessages.push(toolMsg);
					pendingToolResult = toolMsg;
				}
				continue;
			}

			// Any non-tool message closes the current tool-result group.
			pendingToolResult = null;

			if (typeof msg.content === "string") {
				chatMessages.push({
					role: msg.role as "user" | "assistant",
					content: msg.content,
				});
			} else {
				// Array content
				const parts: any[] = [];

				for (const block of msg.content) {
					switch (block.type) {
						case "text":
							parts.push({ type: "text", text: block.text });
							break;
						case "image":
							parts.push({
								type: "image",
								source: {
									type: "base64",
									media_type: block.mimeType,
									data: block.data,
								},
							});
							break;
						case "tool_call":
							parts.push({
								type: "tool_use",
								id: block.id,
								name: block.name,
								input: block.arguments,
							});
							break;
						case "thinking":
							// Anthropic requires the original `signature` to be replayed verbatim
							// with the thinking text in tool-use loops. A signature-less thinking
							// block is rejected by the API, so DROP legacy blocks (persisted before
							// the signature was captured) rather than sending them signature-less —
							// mirrors the deliberate drop in openai-compatible.ts.
							if (typeof block.signature === "string" && block.signature.length > 0) {
								parts.push({
									type: "thinking",
									thinking: block.thinking,
									signature: block.signature,
								});
							}
							break;
					}
				}

				chatMessages.push({
					role: msg.role as "user" | "assistant",
					content: parts,
				});
			}
		}

		// Prompt-cache breakpoint on the LAST message caches the whole conversation prefix.
		// The last block of the last message is the freshest stable content; marking it lets the
		// server reuse everything before it on the next turn.
		this.applyLastMessageCacheBreakpoint(chatMessages);

		return { systemPrompt, chatMessages };
	}

	/**
	 * Attach `cache_control: {type:"ephemeral"}` to the last content block of the last message.
	 * Normalizes string content into a single text block so the breakpoint has somewhere to
	 * live. No-op when there are no messages. This is one of the (max 4) cache breakpoints —
	 * see buildParams for the system + last-tool breakpoints.
	 */
	private applyLastMessageCacheBreakpoint(chatMessages: Anthropic.MessageParam[]): void {
		const last = chatMessages[chatMessages.length - 1];
		if (!last) return;

		if (typeof last.content === "string") {
			last.content = [
				{
					type: "text",
					text: last.content,
					cache_control: { type: "ephemeral" },
				} as any,
			];
			return;
		}

		const blocks = last.content as any[];
		const lastBlock = blocks[blocks.length - 1];
		if (lastBlock) {
			lastBlock.cache_control = { type: "ephemeral" };
		}
	}

	private parseResponse(response: any): LLMResponse {
		const contentBlocks: MessageContent[] = [];
		let fullText = "";

		for (const block of response.content || []) {
			if (block.type === "text") {
				fullText += block.text;
				contentBlocks.push({ type: "text", text: block.text });
			} else if (block.type === "thinking") {
				// Capture the signature alongside the thinking text — the API rejects a
				// signature-less thinking block when it's replayed in a tool-use loop.
				contentBlocks.push({
					type: "thinking",
					thinking: block.thinking,
					...(typeof block.signature === "string" && block.signature.length > 0
						? { signature: block.signature }
						: {}),
				});
			} else if (block.type === "tool_use") {
				contentBlocks.push({
					type: "tool_call",
					id: block.id,
					name: block.name,
					arguments: block.input || {},
				});
			}
		}

		return {
			content: fullText,
			contentBlocks,
			usage: {
				inputTokens: response.usage?.input_tokens || 0,
				outputTokens: response.usage?.output_tokens || 0,
				totalTokens: (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0),
			},
			stopReason: response.stop_reason || "end_turn",
			model: response.model || this.model,
		};
	}
}
