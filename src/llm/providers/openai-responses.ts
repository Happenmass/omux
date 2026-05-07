import { logger } from "../../utils/logger.js";
import type {
	CompletionOptions,
	LLMMessage,
	LLMProvider,
	LLMResponse,
	LLMStreamEvent,
	MessageContent,
	ProviderConfig,
	ReasoningContent,
	ReasoningSummaryLevel,
	ThinkingLevel,
	ToolCallContent,
	ToolDefinition,
	Verbosity,
} from "../types.js";

// ─── Wire-format types (mirror Codex `codex-rs/codex-api/src/common.rs:165`) ──────────
//
// FIELD ORDER IS LOAD-BEARING. JS object literals serialize in insertion order, so the
// declaration order in `buildRequestBody` IS the wire order. Match Codex exactly:
//
//   1. model
//   2. instructions          (skip if empty)
//   3. input
//   4. tools
//   5. tool_choice
//   6. parallel_tool_calls
//   7. reasoning             (Option<Reasoning>; emit `null` when None)
//   8. store
//   9. stream
//  10. include
//  11. service_tier          (skip if undefined)
//  12. prompt_cache_key      (skip if undefined)
//  13. text                  (skip if undefined)
//  14. client_metadata       (skip if undefined)
//
// Any reordering, even of semantically identical fields, will break the prompt-cache prefix.

type ContentItemWire =
	| { type: "input_text"; text: string }
	| { type: "input_image"; image_url: string }
	| { type: "output_text"; text: string };

type ResponseItemWire =
	| {
			type: "message";
			role: "user" | "assistant" | "system" | "developer";
			content: ContentItemWire[];
	  }
	| {
			type: "reasoning";
			summary: { type: "summary_text"; text: string }[];
			content?: { type: "reasoning_text"; text: string }[];
			encrypted_content: string | null;
	  }
	| { type: "function_call"; name: string; arguments: string; call_id: string }
	| { type: "function_call_output"; call_id: string; output: string };

type ResponsesApiToolWire = {
	type: "function";
	name: string;
	description: string;
	strict: boolean;
	parameters: object;
};

type ReasoningWire = {
	effort?: "minimal" | "low" | "medium" | "high";
	summary?: ReasoningSummaryLevel;
};

type TextControlsWire = {
	verbosity?: Verbosity;
	format?: { type: "json_schema"; name: string; strict: boolean; schema: object };
};

interface ResponsesApiRequestWire {
	model: string;
	instructions?: string;
	input: ResponseItemWire[];
	tools: ResponsesApiToolWire[];
	tool_choice: string;
	parallel_tool_calls: boolean;
	reasoning: ReasoningWire | null;
	store: boolean;
	stream: boolean;
	include: string[];
	service_tier?: string;
	prompt_cache_key?: string;
	text?: TextControlsWire;
	client_metadata?: Record<string, string>;
}

/**
 * Incremental request form. Sent when both the byte-equal-without-input check and the
 * input-prefix-extension check pass. Carries `previous_response_id` so the server reuses
 * its retained baseline; `input` contains ONLY the delta items appended since baseline.
 *
 * The optional fields below preserve Codex declared order. `previous_response_id` slots in
 * AFTER `instructions` (matches `ResponseCreateWsRequest` in `codex-rs/codex-api/src/common.rs:212`).
 */
interface ResponsesApiRequestIncrementalWire {
	model: string;
	instructions?: string;
	previous_response_id: string;
	input: ResponseItemWire[];
	tools: ResponsesApiToolWire[];
	tool_choice: string;
	parallel_tool_calls: boolean;
	reasoning: ReasoningWire | null;
	store: boolean;
	stream: boolean;
	include: string[];
	service_tier?: string;
	prompt_cache_key?: string;
	text?: TextControlsWire;
	client_metadata?: Record<string, string>;
}

/**
 * In-memory state for the second-layer optimization (`previous_response_id` chain).
 *
 * Lifecycle (mirrors Codex `WebsocketSession.last_request` + `last_response_rx`):
 *   - Initialized to `null`
 *   - Updated AFTER each successful `response.completed`
 *   - Cleared on `response.failed` / `response.incomplete` / non-200 HTTP / unexpected stream errors
 *   - Cleared (effectively) when the next-turn double-check fails — that turn sends full and
 *     re-seeds the state with the new full request as baseline
 *   - NOT persisted to disk: cliclaw restart re-starts the chain (first request after restart
 *     is full, but `prompt_cache_key` keeps the server-side cache hit). This matches Codex's
 *     in-memory WS session behavior.
 */
interface IncrementalState {
	/** The full (non-incremental) request body that the server's baseline reflects. */
	lastFullRequest: ResponsesApiRequestWire;
	/** Server-issued `response.id` from the prior `response.completed` event. */
	lastResponseId: string;
	/**
	 * Items the server emitted in the prior turn (assistant message / reasoning / function_call,
	 * captured in receipt order from `output_item.done`). The next turn's baseline is
	 * `lastFullRequest.input ⧺ lastItemsAddedWire` — the new full request's `input` must start
	 * with this exact sequence to be eligible for incremental sending.
	 */
	lastItemsAddedWire: ResponseItemWire[];
}

// ─── Provider ─────────────────────────────────────────────────────────────────────────

const REASONING_THINKING_LEVELS: Record<Exclude<ThinkingLevel, "off">, ReasoningWire["effort"]> = {
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
};

/**
 * OpenAI Responses API provider — `POST {baseUrl}/responses`.
 *
 * Single-layer cache optimization (matches Codex CLI's HTTP path exactly):
 *
 *   Layer 1 (server-side prompt cache, always on):
 *     - `prompt_cache_key = conversation_id` locks the server-side cache entry
 *     - `instructions` + `tools` stay byte-equal across turns (stable prefix)
 *     - reasoning items ride along via `include = ["reasoning.encrypted_content"]`
 *       and are replayed verbatim in the next turn's `input`
 *     - runtime config changes append to `input`, never rewrite the prefix
 *
 * Layer 2 (transport-layer delta via `previous_response_id`) is **disabled by default**.
 * Codex CLI itself only uses `previous_response_id` over its private WebSocket protocol
 * (see `prepare_websocket_request` in `codex-rs/core/src/client.rs:985`); its HTTP path
 * always sends the full request via `build_responses_request` (line 1207), with NO
 * `previous_response_id`. The OpenAI Responses HTTP endpoint enforces per-request
 * function_call ↔ function_call_output pairing — sending a delta of just
 * `[function_call_output]` even with `previous_response_id` returns 400
 * "No tool call found for function call output with call_id ...". We hit this in
 * production and decided to mirror Codex's HTTP behavior: no `previous_response_id`,
 * every turn sends full input. The L2 code paths remain in the file for testing /
 * future opt-in via `enableIncremental: true`, but the default is off.
 *
 * Net result: every turn includes the full conversation history in `input`, and the
 * server's prompt cache (keyed by `prompt_cache_key`) returns most of those tokens
 * billed at the cached rate (~10× cheaper than fresh tokens). Latency benefit too,
 * since the server can skip re-encoding the cached prefix.
 */
export class OpenAIResponsesProvider implements LLMProvider {
	readonly name: string;
	readonly protocol = "openai-responses" as const;

	private baseUrl: string;
	private apiKey: string;
	private model: string;
	private headers: Record<string, string>;
	private maxRetries: number;
	private timeout: number;
	private store: boolean;
	private incrementalEnabled: boolean;
	private incrementalState: IncrementalState | null = null;

	constructor(
		config: ProviderConfig,
		opts: {
			model?: string;
			apiKey?: string;
			maxRetries?: number;
			timeout?: number;
			/**
			 * Opt INTO Layer-2 `previous_response_id` incremental transport. Default `false`.
			 *
			 * The default-off matches Codex's HTTP path: every turn sends full input. Enabling
			 * this brings back the wire-byte savings BUT will trip 400
			 * "No tool call found for function call output with call_id ..." on tool-result
			 * turns whenever the gateway / OpenAI server enforces per-request function_call
			 * pairing. Only enable on a server you've verified accepts cross-request pairing
			 * via `previous_response_id` (e.g. via WebSocket-style turn-state).
			 */
			enableIncremental?: boolean;
		},
	) {
		this.name = config.name;
		this.baseUrl = config.baseUrl.replace(/\/$/, "");
		this.apiKey = opts.apiKey || process.env[config.apiKeyEnvVar] || "";
		this.model = opts.model || config.defaultModel;
		this.headers = config.headers || {};
		this.maxRetries = opts.maxRetries ?? 3;
		this.timeout = opts.timeout ?? 60000;
		// Default OFF — matches Codex HTTP path. See class JSDoc for rationale.
		this.incrementalEnabled = opts.enableIncremental ?? false;
		// `store` only matters for Layer-2 (server retains prior response so prev_id chain
		// can reconstruct baseline). With L2 off, `store=false` matches what Codex's HTTP
		// path sends to OpenAI direct (`is_azure_responses_endpoint() == false`). A provider
		// config can still explicitly opt-in via `headers["x-cliclaw-store"]: "true"`.
		this.store = this.incrementalEnabled || config.headers?.["x-cliclaw-store"] === "true";
	}

	/**
	 * Test/diagnostic accessor. Returns a shallow snapshot — DO NOT mutate.
	 * Hidden behind a method (not a public field) to keep the LLMProvider contract narrow.
	 */
	getIncrementalStateSnapshot(): IncrementalState | null {
		return this.incrementalState;
	}

	/**
	 * Force a full request on the next turn. Useful when a higher layer knows the prefix has
	 * been invalidated for reasons the provider can't observe (e.g. tools list changed mid-
	 * session, system prompt rewritten by /clear). Codex's WS session resets on similar events
	 * (`reset_websocket_session` in `client.rs:823`).
	 */
	resetIncrementalChain(): void {
		this.incrementalState = null;
	}

	async complete(messages: LLMMessage[], opts?: CompletionOptions): Promise<LLMResponse> {
		// Non-streaming Responses API is supported (stream=false) but cliclaw's flow always
		// streams; we still expose `complete` for parity with other providers. Implement by
		// running the stream and returning its final `done` event.
		let final: LLMResponse | null = null;
		for await (const ev of this.stream(messages, opts)) {
			if (ev.type === "done") final = ev.response;
		}
		if (!final) throw new Error(`[${this.name}] stream ended without a done event`);
		return final;
	}

	async *stream(messages: LLMMessage[], opts?: CompletionOptions): AsyncIterable<LLMStreamEvent> {
		// Step 1: build the FULL request body. This is what we'd send if Layer-2 were off, and
		// it's also what we capture as the next turn's baseline regardless of which form we
		// transmit (Codex stores the full equivalent, not the on-wire incremental payload).
		const fullBody = buildRequestBody({
			model: this.model,
			messages,
			opts,
			store: this.store,
			providerName: this.name,
		});

		// Stream-level retry loop. Distinct from `fetchWithRetry`'s HTTP-level retry:
		//   - HTTP-level (status != 200, e.g. 429/5xx/network)        → handled inside fetchWithRetry
		//   - Stream-level (HTTP 200 + SSE `response.failed`)         → handled here
		// OpenAI returns 200 + SSE `response.failed: Our servers are currently overloaded`
		// when the request was accepted but generation couldn't proceed. We must retry the
		// whole POST in that case. We only retry while NO caller-visible delta has been
		// yielded yet — once UI text/tool/reasoning deltas have flowed out, retrying would
		// duplicate them. `decision` is recomputed each iteration: after the first failure
		// we clear `incrementalState` so the retry naturally falls back to a full request.
		let streamAttempt = 0;
		while (true) {
			const decision = this.incrementalEnabled
				? tryBuildIncremental(fullBody, this.incrementalState)
				: { mode: "full" as const, wire: fullBody, reason: "incremental-disabled" };

			// Step 2: log turn shape. Promoted from debug→info so /compact and regular turn
			// shapes are visible without flipping log levels. Includes everything needed to
			// diagnose cache misses:
			//   - mode: incremental (delta send) vs full (whole input on the wire)
			//   - reason: when full, WHY the incremental check failed
			//   - input.count + tools.count + instructions.len: prefix shape
			//   - prompt_cache_key: the L1 cache routing key
			//   - hadIncrementalState: whether we *had* a baseline to attempt L2 against
			const wireBytes = JSON.stringify(decision.wire).length;
			if (decision.mode === "incremental") {
				logger.info(
					"llm",
					`[${this.name}] POST /responses INCREMENTAL: prev_id=${decision.wire.previous_response_id}, input.delta=${decision.wire.input.length} item(s), wire.bytes=${wireBytes}, prompt_cache_key=${fullBody.prompt_cache_key ?? "(none)"}`,
				);
			} else if (this.incrementalEnabled) {
				logger.info(
					"llm",
					`[${this.name}] POST /responses FULL: reason=${decision.reason}, input.count=${fullBody.input.length}, tools.count=${fullBody.tools.length}, instructions.len=${fullBody.instructions?.length ?? 0}, wire.bytes=${wireBytes}, prompt_cache_key=${fullBody.prompt_cache_key ?? "(none)"}, hadPriorState=${this.incrementalState ? `yes(prev_id=${this.incrementalState.lastResponseId})` : "no"}`,
				);
			} else {
				logger.info(
					"llm",
					`[${this.name}] POST /responses FULL: input.count=${fullBody.input.length}, tools.count=${fullBody.tools.length}, instructions.len=${fullBody.instructions?.length ?? 0}, wire.bytes=${wireBytes}, prompt_cache_key=${fullBody.prompt_cache_key ?? "(none)"}`,
				);
			}

			const response = await this.fetchWithRetry(`${this.baseUrl}/responses`, decision.wire, opts?.signal);
			if (!response.body) throw new Error(`[${this.name}] No response body for streaming`);

			// Step 3: parse SSE while collecting (a) what to yield to the caller, (b) state
			// needed to seed the next turn's incremental check.
			const collector: SseCollector = { itemsAddedWire: [], responseId: null };
			let yieldedOutput = false;

			try {
				for await (const ev of parseResponsesSse(response.body, this.model, this.name, opts?.thinking, collector)) {
					if (
						ev.type === "text_delta" ||
						ev.type === "tool_call_delta" ||
						ev.type === "reasoning_summary_delta" ||
						ev.type === "reasoning_content_delta"
					) {
						yieldedOutput = true;
					}
					yield ev;
				}
			} catch (err) {
				// Stream-level failure: server-side state is uncertain regardless of L2 setting.
				if (this.incrementalEnabled) {
					logger.warn(
						"llm",
						`[${this.name}] stream threw — clearing L2 incremental state (next turn will go FULL): ${(err as Error).message}`,
					);
				}
				this.incrementalState = null;

				// Retry only when (a) the error is a transient stream-level failure (e.g.
				// overload / rate limit / 5xx), (b) no caller-visible delta has been yielded
				// yet (otherwise we'd duplicate UI content), (c) under maxRetries, and
				// (d) the caller hasn't aborted.
				if (
					!yieldedOutput &&
					streamAttempt < this.maxRetries &&
					isRetryableStreamError(err) &&
					opts?.signal?.aborted !== true
				) {
					streamAttempt++;
					// Fixed 3s wait between stream-level retries. `response.failed` from server
					// overload usually clears within a few seconds; exponential backoff (2s/4s/8s)
					// either piles on more billable retries past the recovery window or times out
					// the user. Capped by `this.timeout` so tests can drive maxRetries quickly.
					const delay = Math.min(3000, this.timeout);
					logger.warn(
						"llm",
						`[${this.name}] stream-level failure on attempt ${streamAttempt}/${this.maxRetries}, retrying in ${delay}ms (each retry is a separate billable call): ${(err as Error).message}`,
					);
					await new Promise((r) => setTimeout(r, delay));
					continue;
				}
				throw err;
			}

			// Step 4: update Layer-2 state, ONLY if L2 is enabled. Skipping the state update
			// when L2 is off keeps `incrementalState = null` and avoids holding the prior
			// request's full body in memory across turns for no benefit.
			if (this.incrementalEnabled) {
				if (collector.responseId) {
					const itemTypes = collector.itemsAddedWire.map((i) => i.type).join(",");
					logger.info(
						"llm",
						`[${this.name}] stream complete: response_id=${collector.responseId}, items_added=${collector.itemsAddedWire.length} [${itemTypes}], L2 state UPDATED (next turn eligible for incremental)`,
					);
					this.incrementalState = {
						lastFullRequest: fullBody,
						lastResponseId: collector.responseId,
						lastItemsAddedWire: collector.itemsAddedWire,
					};
				} else {
					logger.warn(
						"llm",
						`[${this.name}] stream complete but NO response_id surfaced (older server / malformed SSE) — clearing L2 state, next turn will go FULL`,
					);
					this.incrementalState = null;
				}
			} else if (collector.responseId) {
				logger.debug(
					"llm",
					`[${this.name}] stream complete: response_id=${collector.responseId} (L2 disabled — not tracked)`,
				);
			}
			return;
		}
	}

	// ─── Internal ────────────────────────────────────────

	private async fetchWithRetry(url: string, body: any, signal?: AbortSignal): Promise<Response> {
		let lastError: Error | null = null;
		for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
			try {
				const headers: Record<string, string> = {
					"Content-Type": "application/json",
					Accept: "text/event-stream",
					...this.headers,
				};
				if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
				if (attempt > 0) {
					// Surface retries explicitly — every retry is a SEPARATE billable call. If the
					// dashboard shows N entries for what was logically one /compact, attempt counter
					// here will tell us if cliclaw retried internally.
					logger.info(
						"llm",
						`[${this.name}] fetch attempt ${attempt + 1}/${this.maxRetries + 1} — this is a RETRY of the previous failed request`,
					);
				}
				const response = await fetch(url, {
					method: "POST",
					headers,
					body: JSON.stringify(body),
					signal,
				});
				if (response.ok) return response;
				if (response.status === 429 || response.status >= 500) {
					const retryAfter = response.headers.get("retry-after");
					const delay = retryAfter ? parseInt(retryAfter, 10) * 1000 : Math.min(1000 * 2 ** attempt, this.timeout);
					logger.warn(
						"llm",
						`[${this.name}] HTTP ${response.status} on attempt ${attempt + 1}, retrying in ${delay}ms (each retry is a separate billable call)`,
					);
					await new Promise((r) => setTimeout(r, delay));
					continue;
				}
				// 4xx (other than 429): client-side bug in our request body. Retrying
				// produces the same error N more times and bills each one. Fail fast and
				// surface the first server message — we earlier had a case where a 400
				// "No tool call found for function call output with call_id ..." got
				// retried 4 times before bubbling up.
				const errorBody = await response.text().catch(() => "");
				const error = new Error(`[${this.name}] API error ${response.status}: ${errorBody.substring(0, 500)}`);
				(error as { nonRetryable?: boolean }).nonRetryable = true;
				throw error;
			} catch (err: any) {
				if (err.name === "AbortError" || err.nonRetryable) throw err;
				lastError = err;
				if (attempt < this.maxRetries) {
					const delay = Math.min(1000 * 2 ** attempt, this.timeout);
					logger.warn(
						"llm",
						`[${this.name}] fetch threw on attempt ${attempt + 1}, retrying in ${delay}ms (each retry is a separate billable call): ${err.message}`,
					);
					await new Promise((r) => setTimeout(r, delay));
				}
			}
		}
		throw lastError || new Error(`[${this.name}] Request failed after ${this.maxRetries} retries`);
	}
}

// ─── Pure builders (exported for byte-equality testing) ──────────────────────────────

/**
 * Build the Responses API request body in the canonical Codex field order.
 *
 * Exported so tests can pin the byte-equality invariants from the design spec
 * (test_1: instructions+tools byte-equal across turns; test_3: deterministic tool serialization).
 */
export function buildRequestBody(args: {
	model: string;
	messages: LLMMessage[];
	opts?: CompletionOptions;
	store: boolean;
	/** Optional, used only for log lines. */
	providerName?: string;
}): ResponsesApiRequestWire {
	const { model, messages, opts, store } = args;

	const instructions = extractInstructions(messages, opts?.systemPrompt);
	const input = buildInput(messages);
	const tools = buildTools(opts?.tools);

	// Reasoning is the toggle for `include = ["reasoning.encrypted_content"]`.
	// We turn it on iff the caller asked for thinking != "off" (Codex equivalent: model_info
	// supports_reasoning_summaries). Effort and summary level come from opts.
	//
	// `summary` defaults to "auto" when reasoning is enabled but the caller didn't pick one.
	// This matches Codex's config-layer default (`ReasoningSummaryConfig::Auto`) and is what
	// produces the cross-turn `response.reasoning_summary_text.delta` events that downstream
	// UIs render as "thinking…" text. Explicitly passing `null` would suppress summaries
	// entirely (Codex `ReasoningSummaryConfig::None` path); we expose that as
	// `reasoningSummary === null` rather than overloading `undefined`.
	const summaryDefault: ReasoningSummaryLevel = "auto";
	const summaryChoice = opts?.reasoningSummary === undefined ? summaryDefault : opts.reasoningSummary; // may be null to suppress
	const reasoning: ReasoningWire | null =
		opts?.thinking && opts.thinking !== "off"
			? {
					effort: REASONING_THINKING_LEVELS[opts.thinking],
					...(summaryChoice ? { summary: summaryChoice } : {}),
				}
			: null;

	const include: string[] = reasoning !== null ? ["reasoning.encrypted_content"] : [];

	const text: TextControlsWire | undefined = buildTextControls(opts);

	// IMPORTANT: assignment order below IS the wire order. Do not reorder.
	const body: ResponsesApiRequestWire = {
		model,
		// instructions: skip if empty (matches Rust `skip_serializing_if = "String::is_empty"`).
		// Achieved by deleting the key after construction when the source string is empty.
		instructions: instructions,
		input,
		tools,
		tool_choice: normalizeToolChoice(opts?.toolChoice),
		// Codex hardcodes parallel_tool_calls = model_info.supports_parallel_tool_calls.
		// We default to true — gpt-5.x and o-series all support it. Caller can future-extend.
		parallel_tool_calls: true,
		reasoning,
		store,
		stream: true,
		include,
	};

	if (instructions === "") {
		delete (body as { instructions?: string }).instructions;
	}

	// Optional fields — assigned AFTER required fields, in spec order.
	if (opts?.promptCacheKey) {
		body.prompt_cache_key = opts.promptCacheKey;
	}
	if (text !== undefined) {
		body.text = text;
	}

	return body;
}

// ─── Layer-2 incremental decision ─────────────────────────────────────────────────────

/**
 * Decide whether the next turn can be sent as an incremental delta with `previous_response_id`,
 * or must fall back to full transmission. Mirrors Codex `get_incremental_items`
 * (`codex-rs/core/src/client.rs:936`).
 *
 * Returns:
 *   - `{ mode: "incremental", wire }` — `wire` contains only the delta items + previous_response_id,
 *     ready to POST. Server reconstructs the full input from its retained baseline.
 *   - `{ mode: "full", wire: newFull, reason }` — send the original full body. `reason` is a
 *     short tag for log lines / tests, not parsed by callers.
 *
 * Both checks must pass for incremental:
 *   1. Every non-input field byte-equal to the prior full request (`prev_without_input`).
 *   2. New input is a strict prefix-extension of `prev.input ⧺ items_added` (the server's
 *      effective baseline after the prior turn).
 *
 * Either failure means the prior server-side state isn't a valid baseline for this request,
 * so we send full and the caller re-seeds state with the new full body.
 */
type IncrementalDecision =
	| { mode: "incremental"; wire: ResponsesApiRequestIncrementalWire }
	| { mode: "full"; wire: ResponsesApiRequestWire; reason: string };

export function tryBuildIncremental(
	newFull: ResponsesApiRequestWire,
	state: IncrementalState | null,
): IncrementalDecision {
	if (!state) {
		return { mode: "full", wire: newFull, reason: "no-prior-state" };
	}

	// Check 1: non-input fields byte-equal.
	if (!nonInputFieldsByteEqual(state.lastFullRequest, newFull)) {
		return { mode: "full", wire: newFull, reason: "non-input-fields-differ" };
	}

	// Check 2: input is a strict prefix-extension of (prev.input + lastItemsAddedWire).
	const baseline: ResponseItemWire[] = [...state.lastFullRequest.input, ...state.lastItemsAddedWire];
	if (newFull.input.length <= baseline.length) {
		// Equal-length or shorter ⇒ no new items to send. Empty deltas aren't useful (and
		// Codex requires `allow_empty_delta=false` outside special cases like tool replies).
		return { mode: "full", wire: newFull, reason: "no-new-items" };
	}
	if (!inputStartsWith(newFull.input, baseline)) {
		return { mode: "full", wire: newFull, reason: "input-not-prefix-extension" };
	}

	const delta = newFull.input.slice(baseline.length);

	// Hard constraint of the OpenAI Responses HTTP API: a `function_call_output` item must
	// appear in the SAME request's `input` as the `function_call` it answers, even when that
	// `function_call` is reachable via `previous_response_id`. Sending a delta of just
	// `[function_call_output]` makes the server reply 400 with:
	//   "No tool call found for function call output with call_id call_..."
	//
	// This is documented nowhere we found, but the user reproduced it deterministically and
	// every retry got the same 400. Codex never trips it because Codex only uses
	// previous_response_id over WebSocket (`prepare_websocket_request` in client.rs:985);
	// its HTTP path always sends the full request — see codex-rs/core/src/client.rs:831
	// `build_responses_request`, which does NOT splice in previous_response_id at all.
	//
	// Defensive workaround: any delta carrying a function_call_output forces a full request.
	// We lose L2 wire-byte savings on tool-result turns (which is most cliclaw turns since
	// the orchestrator is tool-heavy), but every other turn type (text-only, new user input)
	// still rides the L2 fast path. Server-side L1 prompt-cache (prompt_cache_key) still
	// helps on the full path — that's untouched by this fallback.
	if (delta.some((item) => item.type === "function_call_output")) {
		return { mode: "full", wire: newFull, reason: "delta-contains-function_call_output" };
	}
	const wire: ResponsesApiRequestIncrementalWire = {
		model: newFull.model,
		...(newFull.instructions !== undefined ? { instructions: newFull.instructions } : {}),
		previous_response_id: state.lastResponseId,
		input: delta,
		tools: newFull.tools,
		tool_choice: newFull.tool_choice,
		parallel_tool_calls: newFull.parallel_tool_calls,
		reasoning: newFull.reasoning,
		store: newFull.store,
		stream: newFull.stream,
		include: newFull.include,
	} as ResponsesApiRequestIncrementalWire;

	if (newFull.service_tier !== undefined) wire.service_tier = newFull.service_tier;
	if (newFull.prompt_cache_key !== undefined) wire.prompt_cache_key = newFull.prompt_cache_key;
	if (newFull.text !== undefined) wire.text = newFull.text;
	if (newFull.client_metadata !== undefined) wire.client_metadata = newFull.client_metadata;

	return { mode: "incremental", wire };
}

function nonInputFieldsByteEqual(a: ResponsesApiRequestWire, b: ResponsesApiRequestWire): boolean {
	// JSON.stringify with deterministic key order (insertion order, which buildRequestBody
	// fixes) is sufficient — any drift in non-input fields produces different bytes here.
	const aClone: ResponsesApiRequestWire = { ...a, input: [] };
	const bClone: ResponsesApiRequestWire = { ...b, input: [] };
	return JSON.stringify(aClone) === JSON.stringify(bClone);
}

/**
 * `haystack.startsWith(needle)` for the wire-form ResponseItem array. Compares structurally
 * via JSON.stringify per item. The two sides must be byte-identical because the server's
 * baseline is the previous wire bytes; any field-order or formatting drift breaks the match.
 *
 * `buildInput` is deterministic and `buildRequestBody`'s field order is fixed, so both sides
 * round-trip to the same JSON given the same logical content.
 */
export function inputStartsWith(haystack: ResponseItemWire[], needle: ResponseItemWire[]): boolean {
	if (needle.length > haystack.length) return false;
	for (let i = 0; i < needle.length; i++) {
		if (JSON.stringify(haystack[i]) !== JSON.stringify(needle[i])) {
			return false;
		}
	}
	return true;
}

// ─── Builders (cont.) ─────────────────────────────────────────────────────────────────

function extractInstructions(messages: LLMMessage[], systemPromptOverride?: string): string {
	if (typeof systemPromptOverride === "string") return systemPromptOverride;
	const sys = messages.find((m) => m.role === "system");
	if (!sys) return "";
	return typeof sys.content === "string" ? sys.content : "";
}

/**
 * Translate `LLMMessage[]` → `ResponseItem[]` matching Codex's `enum ResponseItem`.
 *
 * Conventions:
 *   - `system` role is consumed into `instructions`, never appears in `input`
 *   - `user` text → `{type:"message", role:"user", content:[{type:"input_text", ...}]}`
 *   - `assistant` text → `{type:"message", role:"assistant", content:[{type:"output_text", ...}]}`
 *   - `assistant` tool_calls → one `function_call` ResponseItem per call (Codex: `FunctionCall`)
 *   - `tool` results → `{type:"function_call_output", call_id, output}` (Codex: `FunctionCallOutput`)
 *   - `reasoning` blocks → replayed as `{type:"reasoning", encrypted_content, summary}`
 *
 * Strict ordering: each LLMMessage's blocks are emitted in their original order. Reasoning
 * blocks within an assistant message come BEFORE function_calls — this matches the order in
 * which the server emits them (output_item.added: reasoning → function_call) and is what the
 * server expects on replay.
 */
export function buildInput(messages: LLMMessage[]): ResponseItemWire[] {
	const out: ResponseItemWire[] = [];

	for (const msg of messages) {
		if (msg.role === "system") continue;

		if (msg.role === "tool") {
			const output = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
			out.push({
				type: "function_call_output",
				call_id: msg.toolCallId ?? "",
				output,
			});
			continue;
		}

		if (msg.role === "user") {
			const content: ContentItemWire[] =
				typeof msg.content === "string"
					? [{ type: "input_text", text: msg.content }]
					: msg.content
							.map((b): ContentItemWire | null => {
								if (b.type === "text") return { type: "input_text", text: b.text };
								if (b.type === "image")
									return { type: "input_image", image_url: `data:${b.mimeType};base64,${b.data}` };
								return null;
							})
							.filter((b): b is ContentItemWire => b !== null);
			out.push({ type: "message", role: "user", content });
			continue;
		}

		if (msg.role === "assistant") {
			if (typeof msg.content === "string") {
				if (msg.content.length > 0) {
					out.push({
						type: "message",
						role: "assistant",
						content: [{ type: "output_text", text: msg.content }],
					});
				}
				continue;
			}

			// Multi-block assistant message: walk blocks in order, emit:
			//   - reasoning blocks first (server emit order)
			//   - then output_text (one consolidated message item, if any text)
			//   - then function_calls
			const reasoningItems: ResponseItemWire[] = [];
			const textParts: string[] = [];
			const functionCalls: ResponseItemWire[] = [];

			for (const b of msg.content) {
				if (b.type === "reasoning") {
					reasoningItems.push({
						type: "reasoning",
						summary: (b.summary ?? []).map((text) => ({ type: "summary_text" as const, text })),
						...(b.content && b.content.length > 0
							? { content: b.content.map((text) => ({ type: "reasoning_text" as const, text })) }
							: {}),
						encrypted_content: b.encryptedContent,
					});
				} else if (b.type === "text") {
					textParts.push(b.text);
				} else if (b.type === "tool_call") {
					functionCalls.push({
						type: "function_call",
						name: b.name,
						arguments: JSON.stringify(b.arguments ?? {}),
						call_id: b.id,
					});
				}
				// `thinking` (Anthropic-flavored) is intentionally dropped — it has no
				// encrypted_content blob and cannot be safely replayed to the Responses API.
			}

			out.push(...reasoningItems);
			if (textParts.length > 0) {
				out.push({
					type: "message",
					role: "assistant",
					content: [{ type: "output_text", text: textParts.join("") }],
				});
			}
			out.push(...functionCalls);
		}
	}

	return out;
}

/**
 * Serialize tools deterministically. Field order within each tool object is fixed
 * (`type, name, description, strict, parameters`) to match Codex `ResponsesApiTool`
 * and guarantee byte-equality across turns given the same `ToolDefinition[]` input.
 */
export function buildTools(defs: ToolDefinition[] | undefined): ResponsesApiToolWire[] {
	if (!defs || defs.length === 0) return [];
	return defs.map((t) => ({
		type: "function" as const,
		name: t.name,
		description: t.description,
		strict: false,
		parameters: t.parameters,
	}));
}

function normalizeToolChoice(tc: CompletionOptions["toolChoice"]): string {
	// Codex always sends `tool_choice = "auto"`. Allow caller to escape only when explicitly
	// asked, since changing this field breaks the prefix.
	if (!tc) return "auto";
	if (tc === "auto") return "auto";
	if (tc === "required") return "required";
	if (tc === "none") return "none";
	// Specific-tool selection isn't part of Codex's stable-prefix discipline; we still allow
	// it but the caller takes responsibility for the cache impact.
	if (typeof tc === "object" && tc.name) return tc.name;
	return "auto";
}

function buildTextControls(opts: CompletionOptions | undefined): TextControlsWire | undefined {
	if (!opts) return undefined;
	const verbosity = opts.verbosity;
	const wantsJsonObject = opts.responseFormat === "json";
	if (!verbosity && !wantsJsonObject) return undefined;
	const ctrl: TextControlsWire = {};
	if (verbosity) ctrl.verbosity = verbosity;
	if (wantsJsonObject) {
		// Minimal `json_schema` strict=false form so callers still using the legacy
		// `response_format: { type: "json_object" }` switch get JSON output.
		ctrl.format = {
			type: "json_schema",
			name: "json_output",
			strict: false,
			schema: { type: "object", additionalProperties: true },
		};
	}
	return ctrl;
}

// ─── SSE parsing ──────────────────────────────────────────────────────────────────────

/**
 * Sink for state needed by the Layer-2 incremental optimization. The parser writes:
 *   - `responseId`: from `response.completed.response.id` — needed for next turn's
 *     `previous_response_id`.
 *   - `itemsAddedWire`: every `output_item.done` whose item has wire-form representation
 *     (function_call, reasoning, message). Captured in receipt order so the next turn's
 *     `input.startsWith(prev.input + itemsAddedWire)` check matches what `buildInput` will
 *     produce when those same items appear in the LLMMessage history.
 *
 * Caller initializes a fresh collector per request and reads it after the stream completes.
 */
interface SseCollector {
	responseId: string | null;
	itemsAddedWire: ResponseItemWire[];
}

/**
 * Parse the Responses API SSE stream. Mirrors Codex `process_responses_event`
 * (`codex-rs/codex-api/src/sse/responses.rs:297`).
 *
 * Events handled:
 *   - response.output_text.delta              → text_delta
 *   - response.function_call_arguments.delta  → tool_call_delta
 *   - response.reasoning_summary_text.delta   → reasoning_summary_delta
 *   - response.reasoning_text.delta           → reasoning_content_delta
 *   - response.output_item.done               → captures completed items (function_call,
 *                                                reasoning, message) into contentBlocks AND
 *                                                into `collector.itemsAddedWire` for L2 baseline
 *   - response.completed                      → final usage + done event + responseId
 *   - response.failed / response.incomplete   → throw
 */
async function* parseResponsesSse(
	body: ReadableStream<Uint8Array>,
	model: string,
	providerName: string,
	thinking: ThinkingLevel | undefined,
	collector?: SseCollector,
): AsyncIterable<LLMStreamEvent> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	const contentBlocks: MessageContent[] = [];
	let textAccum = "";
	const toolCallByOutputIndex = new Map<number, { id: string; name: string; args: string; index: number }>();
	const toolCallByItemId = new Map<string, number>();
	let usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
	let reasoningChars = 0;
	let stopReason = "stop";
	let done = false;

	try {
		while (!done) {
			const { done: streamDone, value } = await reader.read();
			if (streamDone) break;
			buffer += decoder.decode(value, { stream: true });

			// SSE events are separated by blank lines (\n\n). Each event may have multiple
			// `event:` and `data:` lines; we only need `data:` (it's a self-describing JSON
			// payload with its own `type` discriminator).
			let sep = buffer.indexOf("\n\n");
			while (sep !== -1) {
				const raw = buffer.slice(0, sep);
				buffer = buffer.slice(sep + 2);
				sep = buffer.indexOf("\n\n");

				const dataLines: string[] = [];
				for (const line of raw.split("\n")) {
					if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
				}
				if (dataLines.length === 0) continue;
				const dataStr = dataLines.join("\n");
				if (dataStr === "[DONE]") continue;

				let evt: any;
				try {
					evt = JSON.parse(dataStr);
				} catch {
					continue;
				}

				switch (evt.type) {
					case "response.created":
						// Nothing to emit; useful for breadcrumbs only.
						break;

					case "response.output_text.delta": {
						const delta: string = evt.delta ?? "";
						textAccum += delta;
						yield { type: "text_delta", delta };
						break;
					}

					case "response.reasoning_summary_text.delta": {
						const delta: string = evt.delta ?? "";
						const summaryIndex: number = typeof evt.summary_index === "number" ? evt.summary_index : 0;
						reasoningChars += delta.length;
						yield { type: "reasoning_summary_delta", delta, summaryIndex };
						break;
					}

					case "response.reasoning_text.delta": {
						const delta: string = evt.delta ?? "";
						const contentIndex: number = typeof evt.content_index === "number" ? evt.content_index : 0;
						reasoningChars += delta.length;
						yield { type: "reasoning_content_delta", delta, contentIndex };
						break;
					}

					case "response.function_call_arguments.delta": {
						// `output_index` is the per-output position; `item_id` is the call's id.
						const itemId: string = evt.item_id ?? "";
						const callId: string | undefined = evt.call_id;
						const argDelta: string = evt.delta ?? "";
						let outputIndex = toolCallByItemId.get(itemId);
						if (outputIndex === undefined) {
							outputIndex = toolCallByOutputIndex.size;
							toolCallByItemId.set(itemId, outputIndex);
							toolCallByOutputIndex.set(outputIndex, {
								id: callId ?? itemId,
								name: "",
								args: "",
								index: outputIndex,
							});
						}
						const acc = toolCallByOutputIndex.get(outputIndex)!;
						acc.args += argDelta;
						if (callId) acc.id = callId;
						yield {
							type: "tool_call_delta",
							index: outputIndex,
							id: acc.id || undefined,
							name: acc.name || undefined,
							argumentsDelta: argDelta,
						};
						break;
					}

					case "response.output_item.added": {
						// Capture the `name` for function_call items as soon as they appear, so
						// `tool_call_delta` events can carry it.
						const item = evt.item;
						if (item?.type === "function_call") {
							const itemId: string = item.id ?? item.call_id ?? "";
							let outputIndex = toolCallByItemId.get(itemId);
							if (outputIndex === undefined) {
								outputIndex = toolCallByOutputIndex.size;
								toolCallByItemId.set(itemId, outputIndex);
								toolCallByOutputIndex.set(outputIndex, {
									id: item.call_id ?? itemId,
									name: item.name ?? "",
									args: "",
									index: outputIndex,
								});
							} else {
								const acc = toolCallByOutputIndex.get(outputIndex)!;
								if (item.name) acc.name = item.name;
								if (item.call_id) acc.id = item.call_id;
							}
						}
						break;
					}

					case "response.output_item.done": {
						// Server-side "this output item is finalized". Use it to capture
						// reasoning items (whose only authoritative carrier is encrypted_content)
						// and to reconcile function_call items. Also feed the L2 incremental
						// collector with each item in its canonical wire form so the next turn's
						// `input.startsWith(prev.input + itemsAddedWire)` check can match what
						// `buildInput` will produce when those items reappear in the message
						// history (same shape, same field order).
						const item = evt.item;
						if (!item) break;

						if (item.type === "reasoning") {
							const summary: string[] = Array.isArray(item.summary)
								? item.summary
										.filter((s: any) => s?.type === "summary_text" && typeof s.text === "string")
										.map((s: any) => s.text as string)
								: [];
							const content: string[] = Array.isArray(item.content)
								? item.content.filter((c: any) => typeof c?.text === "string").map((c: any) => c.text as string)
								: [];
							const encrypted: string | null =
								typeof item.encrypted_content === "string" ? item.encrypted_content : null;
							const block: ReasoningContent = {
								type: "reasoning",
								encryptedContent: encrypted,
								...(summary.length > 0 ? { summary } : {}),
								...(content.length > 0 ? { content } : {}),
							};
							contentBlocks.push(block);
							if (collector) {
								collector.itemsAddedWire.push({
									type: "reasoning",
									summary: summary.map((text) => ({ type: "summary_text", text })),
									...(content.length > 0
										? { content: content.map((text) => ({ type: "reasoning_text" as const, text })) }
										: {}),
									encrypted_content: encrypted,
								});
							}
						} else if (item.type === "function_call") {
							const itemId: string = item.id ?? item.call_id ?? "";
							const outputIndex = toolCallByItemId.get(itemId);
							const acc = outputIndex !== undefined ? toolCallByOutputIndex.get(outputIndex) : undefined;
							const finalArgs: string = (typeof item.arguments === "string" ? item.arguments : acc?.args) ?? "";
							const finalName: string = item.name ?? acc?.name ?? "";
							const finalCallId: string = item.call_id ?? acc?.id ?? itemId;
							let parsedArgs: Record<string, any> = {};
							try {
								parsedArgs = finalArgs.length > 0 ? JSON.parse(finalArgs) : {};
							} catch {
								parsedArgs = {};
							}
							const tc: ToolCallContent = {
								type: "tool_call",
								id: finalCallId,
								name: finalName,
								arguments: parsedArgs,
							};
							contentBlocks.push(tc);
							if (collector) {
								// Re-emit the SAME string `buildInput` will produce next turn, so the
								// wire-byte match holds. `buildInput` does `JSON.stringify(args ?? {})`
								// — match it.
								collector.itemsAddedWire.push({
									type: "function_call",
									name: finalName,
									arguments: JSON.stringify(parsedArgs),
									call_id: finalCallId,
								});
							}
						} else if (item.type === "message" && item.role === "assistant") {
							// Capture the assistant text into the L2 baseline as a single output_text
							// content item — this matches `buildInput`'s "consolidate textParts into
							// one message" branch.
							if (collector && Array.isArray(item.content)) {
								const text = item.content
									.filter((c: any) => c?.type === "output_text" && typeof c.text === "string")
									.map((c: any) => c.text as string)
									.join("");
								if (text.length > 0) {
									collector.itemsAddedWire.push({
										type: "message",
										role: "assistant",
										content: [{ type: "output_text", text }],
									});
								}
							}
						}
						break;
					}

					case "response.completed": {
						const resp = evt.response;
						if (resp?.usage) {
							usage = {
								inputTokens: resp.usage.input_tokens ?? 0,
								outputTokens: resp.usage.output_tokens ?? 0,
								totalTokens: resp.usage.total_tokens ?? 0,
							};
						}
						if (collector && typeof resp?.id === "string") {
							collector.responseId = resp.id;
						}
						stopReason = resp?.status === "completed" ? "stop" : (resp?.status ?? "stop");
						done = true;
						break;
					}

					case "response.failed":
					case "response.incomplete": {
						const resp = evt.response;
						const errMsg =
							resp?.error?.message ?? resp?.incomplete_details?.reason ?? "Responses API stream failed";
						const error = new Error(`[${providerName}] ${evt.type}: ${errMsg}`);
						// `response.failed` is the carrier for transient server-side faults
						// (overload, rate-limit, 5xx) — caller's stream-level retry checks this
						// flag. `response.incomplete` (max_output_tokens etc.) is NOT transient
						// and stays unmarked so the retry loop falls through to throw.
						if (evt.type === "response.failed" && isTransientStreamFailureMessage(errMsg)) {
							(error as { retryable?: boolean }).retryable = true;
						}
						throw error;
					}

					default:
						// Unhandled event types (e.g. response.content_part.added). Trace and skip,
						// matching Codex which only handles a curated whitelist.
						break;
				}
			}
		}
	} finally {
		reader.releaseLock();
	}

	// Splice text into contentBlocks in chronological order: text appears at first text_delta
	// arrival, but for the assistant-message replay shape we just need it represented.
	if (textAccum.length > 0) {
		contentBlocks.push({ type: "text", text: textAccum });
	}

	if (reasoningChars > 0) {
		const m = `[${providerName}] reasoning chars=${reasoningChars}`;
		logger.info("llm", m);
		console.log(`[cliclaw] ${m}`);
	} else if (thinking && thinking !== "off") {
		const m = `[${providerName}] reasoning effort=${thinking} requested but no reasoning text returned`;
		logger.info("llm", m);
		console.log(`[cliclaw] ${m}`);
	}

	yield {
		type: "done",
		response: {
			content: textAccum,
			contentBlocks,
			usage,
			stopReason,
			model,
		},
	};
}

// ─── Stream-level retry classification ────────────────────────────────────────────────

/**
 * Decide whether the given `response.failed` server message is the kind we should retry.
 *
 * Examples that DO match (retry):
 *   - "Our servers are currently overloaded. Please try again later."
 *   - "Rate limit reached for ..."
 *   - "Internal server error"
 *   - "Bad gateway / 502 / 503 / 504"
 *   - "Request timed out"
 *
 * Examples that do NOT match (no retry — surface to caller):
 *   - "context_window_exceeded"
 *   - "invalid_request_error"
 *   - "content_policy_violation"
 *
 * Conservative by design: we retry only on phrases that strongly imply a transient
 * server-side fault. Unknown error text falls through to no-retry, matching the
 * "fail fast on 4xx" stance of `fetchWithRetry`.
 */
export function isTransientStreamFailureMessage(message: string): boolean {
	const m = message.toLowerCase();
	return (
		m.includes("overload") ||
		m.includes("rate limit") ||
		m.includes("rate-limit") ||
		m.includes("ratelimit") ||
		m.includes("try again") ||
		m.includes("temporarily") ||
		m.includes("temporary") ||
		m.includes("timeout") ||
		m.includes("timed out") ||
		m.includes("internal server error") ||
		m.includes("internal error") ||
		m.includes("bad gateway") ||
		m.includes("service unavailable") ||
		m.includes("gateway timeout") ||
		/\b(500|502|503|504)\b/.test(m)
	);
}

/**
 * True when the error from the SSE parse phase should trigger a stream-level retry.
 *
 * Retryable: errors thrown from `parseResponsesSse` that we tagged with `retryable=true`
 * (currently: `response.failed` whose message matched `isTransientStreamFailureMessage`).
 *
 * Non-retryable: AbortError, errors carrying `nonRetryable=true` (e.g. 4xx surfaced from
 * fetchWithRetry), and untagged errors (unknown failures fail fast — same stance as
 * fetchWithRetry's 4xx path).
 */
export function isRetryableStreamError(err: unknown): boolean {
	if (!err || typeof err !== "object") return false;
	const e = err as { name?: string; nonRetryable?: boolean; retryable?: boolean };
	if (e.name === "AbortError") return false;
	if (e.nonRetryable) return false;
	return e.retryable === true;
}
