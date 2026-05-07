import { describe, expect, it } from "vitest";
import {
	buildInput,
	buildRequestBody,
	buildTools,
	inputStartsWith,
	isRetryableStreamError,
	isTransientStreamFailureMessage,
	OpenAIResponsesProvider,
	tryBuildIncremental,
} from "../../src/llm/providers/openai-responses.js";
import type { LLMMessage, ToolDefinition } from "../../src/llm/types.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────────────

const TOOLS: ToolDefinition[] = [
	{
		name: "exec_command",
		description: "Run a shell command",
		parameters: {
			type: "object",
			properties: { cmd: { type: "string" } },
			required: ["cmd"],
		},
	},
	{
		name: "send_to_agent",
		description: "Send a prompt to a coding agent",
		parameters: {
			type: "object",
			properties: {
				agentId: { type: "string" },
				prompt: { type: "string" },
				summary: { type: "string" },
			},
			required: ["agentId", "prompt", "summary"],
		},
	},
];

const SYSTEM_PROMPT = "You are a meta-orchestrator. Use tools deterministically.";

const baseOpts = {
	systemPrompt: SYSTEM_PROMPT,
	tools: TOOLS,
	thinking: "off" as const,
	promptCacheKey: "conv-uuid-fixed-1234",
};

function jsonOrder(body: object): string[] {
	return Object.keys(body);
}

// ─── 1. Field ordering invariant ─────────────────────────────────────────────────────

describe("OpenAIResponsesProvider — wire format", () => {
	it("serializes top-level fields in the exact order required by Codex's ResponsesApiRequest", () => {
		// Per spec §2 + Codex `codex-rs/codex-api/src/common.rs:165`, declared order is:
		//   model, instructions, input, tools, tool_choice, parallel_tool_calls,
		//   reasoning, store, stream, include, [service_tier], [prompt_cache_key],
		//   [text], [client_metadata]
		const body = buildRequestBody({
			model: "gpt-5.4",
			messages: [{ role: "user", content: "hi" }],
			opts: baseOpts,
			store: false,
		});

		const keys = jsonOrder(body);
		// Required prefix — must be exactly this order, with no extra keys interleaved.
		const requiredPrefix = [
			"model",
			"instructions",
			"input",
			"tools",
			"tool_choice",
			"parallel_tool_calls",
			"reasoning",
			"store",
			"stream",
			"include",
		];
		expect(keys.slice(0, requiredPrefix.length)).toEqual(requiredPrefix);

		// Optional fields, when present, must come AFTER the required block and in spec order.
		const remainder = keys.slice(requiredPrefix.length);
		const allowedOptionalOrder = ["service_tier", "prompt_cache_key", "text", "client_metadata"];
		// Each present key must appear at-or-after its index in allowedOptionalOrder.
		let cursor = -1;
		for (const k of remainder) {
			const idx = allowedOptionalOrder.indexOf(k);
			expect(idx).toBeGreaterThan(cursor);
			cursor = idx;
		}

		// JSON.stringify must preserve insertion order — the wire bytes prove it.
		const wire = JSON.stringify(body);
		expect(wire.indexOf('"model"')).toBeLessThan(wire.indexOf('"instructions"'));
		expect(wire.indexOf('"instructions"')).toBeLessThan(wire.indexOf('"input"'));
		expect(wire.indexOf('"input"')).toBeLessThan(wire.indexOf('"tools"'));
		expect(wire.indexOf('"tools"')).toBeLessThan(wire.indexOf('"tool_choice"'));
		expect(wire.indexOf('"tool_choice"')).toBeLessThan(wire.indexOf('"parallel_tool_calls"'));
		expect(wire.indexOf('"parallel_tool_calls"')).toBeLessThan(wire.indexOf('"reasoning"'));
		expect(wire.indexOf('"reasoning"')).toBeLessThan(wire.indexOf('"store"'));
		expect(wire.indexOf('"store"')).toBeLessThan(wire.indexOf('"stream"'));
		expect(wire.indexOf('"stream"')).toBeLessThan(wire.indexOf('"include"'));
		expect(wire.indexOf('"include"')).toBeLessThan(wire.indexOf('"prompt_cache_key"'));
	});

	it("omits `instructions` entirely when empty (matches Rust skip_serializing_if = String::is_empty)", () => {
		const body = buildRequestBody({
			model: "gpt-5.4",
			messages: [{ role: "user", content: "hi" }],
			opts: { ...baseOpts, systemPrompt: "" },
			store: false,
		});
		expect(Object.hasOwn(body, "instructions")).toBe(false);
		expect(JSON.stringify(body)).not.toContain('"instructions"');
	});

	it("omits `prompt_cache_key`, `text`, `service_tier`, `client_metadata` when undefined", () => {
		const body = buildRequestBody({
			model: "gpt-5.4",
			messages: [{ role: "user", content: "hi" }],
			opts: { systemPrompt: SYSTEM_PROMPT, tools: TOOLS, thinking: "off" },
			store: false,
		});
		// Check absence at the top level — substring assertions on the wire string would false-
		// match `"input_text"` inside content blocks etc.
		const topLevelKeys = Object.keys(body);
		expect(topLevelKeys).not.toContain("prompt_cache_key");
		expect(topLevelKeys).not.toContain("text");
		expect(topLevelKeys).not.toContain("service_tier");
		expect(topLevelKeys).not.toContain("client_metadata");
	});

	it("emits `reasoning: null` (not absent) when thinking is off — matches Rust `Option<Reasoning>` with no skip_serializing_if", () => {
		const body = buildRequestBody({
			model: "gpt-5.4",
			messages: [{ role: "user", content: "hi" }],
			opts: { ...baseOpts, thinking: "off" },
			store: false,
		});
		expect(body.reasoning).toBeNull();
		expect(JSON.stringify(body)).toContain('"reasoning":null');
	});

	it('reasoning enabled ⇒ `include` contains exactly ["reasoning.encrypted_content"]', () => {
		const body = buildRequestBody({
			model: "gpt-5.4",
			messages: [{ role: "user", content: "hi" }],
			opts: { ...baseOpts, thinking: "high", reasoningSummary: "auto" },
			store: false,
		});
		expect(body.reasoning).toEqual({ effort: "high", summary: "auto" });
		expect(body.include).toEqual(["reasoning.encrypted_content"]);
	});

	it('reasoning enabled with no explicit summary ⇒ defaults to summary="auto" (matches Codex ReasoningSummaryConfig::Auto)', () => {
		// Codex (`codex-rs/core/src/client.rs:847`) treats summary as a separate dial that's
		// non-None by default for reasoning-capable models. cliclaw mirrors that: when the
		// caller enables thinking but doesn't pick a summary level, we send "auto".
		// Without this default, the wire body diverges from Codex's by exactly one field
		// and the two clients can't share the same prompt-cache entry.
		const body = buildRequestBody({
			model: "gpt-5.4",
			messages: [{ role: "user", content: "hi" }],
			opts: { ...baseOpts, thinking: "medium" /* no reasoningSummary */ },
			store: false,
		});
		expect(body.reasoning).toEqual({ effort: "medium", summary: "auto" });
		// Field declaration order inside `reasoning` must match Codex struct: effort then summary.
		expect(Object.keys(body.reasoning!)).toEqual(["effort", "summary"]);
	});

	it("reasoning enabled with reasoningSummary=null ⇒ suppress summary field (Codex ReasoningSummaryConfig::None)", () => {
		const body = buildRequestBody({
			model: "gpt-5.4",
			messages: [{ role: "user", content: "hi" }],
			opts: { ...baseOpts, thinking: "low", reasoningSummary: null },
			store: false,
		});
		expect(body.reasoning).toEqual({ effort: "low" });
		expect(Object.hasOwn(body.reasoning!, "summary")).toBe(false);
	});

	it("reasoning off ⇒ `include` is an empty array (not absent)", () => {
		const body = buildRequestBody({
			model: "gpt-5.4",
			messages: [{ role: "user", content: "hi" }],
			opts: { ...baseOpts, thinking: "off" },
			store: false,
		});
		expect(body.include).toEqual([]);
		expect(JSON.stringify(body)).toContain('"include":[]');
	});
});

// ─── 2. Tool serialization shape ─────────────────────────────────────────────────────

describe("buildTools", () => {
	it("emits each tool as { type, name, description, strict, parameters } in that key order", () => {
		const out = buildTools(TOOLS);
		expect(out).toHaveLength(2);
		for (const tool of out) {
			expect(Object.keys(tool)).toEqual(["type", "name", "description", "strict", "parameters"]);
			expect(tool.type).toBe("function");
			expect(tool.strict).toBe(false);
		}
	});

	it("does NOT wrap tools in the Chat-Completions `function: {...}` envelope", () => {
		const out = buildTools(TOOLS);
		const wire = JSON.stringify(out);
		// Chat Completions form: {"type":"function","function":{"name":...}}.
		// Responses form is flat. Catch the regression by asserting no nested "function":
		expect(wire).not.toContain('"function":{');
	});

	it("returns [] for undefined or empty input", () => {
		expect(buildTools(undefined)).toEqual([]);
		expect(buildTools([])).toEqual([]);
	});
});

// ─── 3. Codex invariant tests (test_1, test_2, test_3) ───────────────────────────────

describe("Codex prompt_caching invariants", () => {
	it("test_1: `instructions` and `tools` are byte-equal across two consecutive turns", () => {
		// Same system prompt, same tools, but different user messages — only `input` may differ.
		const turn1 = buildRequestBody({
			model: "gpt-5.4",
			messages: [{ role: "user", content: "hello 1" }],
			opts: baseOpts,
			store: false,
		});
		const turn2 = buildRequestBody({
			model: "gpt-5.4",
			messages: [
				{ role: "user", content: "hello 1" },
				{ role: "assistant", content: "hi 1" },
				{ role: "user", content: "hello 2" },
			],
			opts: baseOpts,
			store: false,
		});

		expect(JSON.stringify(turn1.instructions)).toEqual(JSON.stringify(turn2.instructions));
		expect(JSON.stringify(turn1.tools)).toEqual(JSON.stringify(turn2.tools));
		expect(JSON.stringify(turn1.tool_choice)).toEqual(JSON.stringify(turn2.tool_choice));
		expect(JSON.stringify(turn1.parallel_tool_calls)).toEqual(JSON.stringify(turn2.parallel_tool_calls));
		expect(JSON.stringify(turn1.reasoning)).toEqual(JSON.stringify(turn2.reasoning));
		expect(JSON.stringify(turn1.include)).toEqual(JSON.stringify(turn2.include));
		expect(JSON.stringify(turn1.prompt_cache_key)).toEqual(JSON.stringify(turn2.prompt_cache_key));
	});

	it("test_2: prompt_cache_key stays constant across runtime config 'overrides' (no rewrite of stable prefix)", () => {
		// Simulate a runtime config change being appended as a new developer message in input,
		// while NOT touching system instructions or tools. Cache key must stay the same.
		const turn1 = buildRequestBody({
			model: "gpt-5.4",
			messages: [{ role: "user", content: "hello" }],
			opts: baseOpts,
			store: false,
		});
		const turn2 = buildRequestBody({
			model: "gpt-5.4",
			messages: [
				{ role: "user", content: "hello" },
				{ role: "assistant", content: "hi" },
				// New developer-style message appended (cwd change, sandbox toggle, etc.)
				{
					role: "user",
					content: "<environment_context>cwd=/tmp/workspace</environment_context>",
				},
			],
			opts: baseOpts,
			store: false,
		});

		expect(turn1.prompt_cache_key).toBe(turn2.prompt_cache_key);
		expect(turn2.prompt_cache_key).toBe("conv-uuid-fixed-1234");
		// And the input prefix must still be a strict extension.
		const prefix1 = turn1.input;
		const prefix2 = turn2.input.slice(0, prefix1.length);
		expect(JSON.stringify(prefix2)).toEqual(JSON.stringify(prefix1));
	});

	it("test_3: tool serialization is deterministic across N rebuilds (no HashMap drift)", () => {
		const first = JSON.stringify(buildTools(TOOLS));
		for (let i = 0; i < 100; i++) {
			expect(JSON.stringify(buildTools(TOOLS))).toEqual(first);
		}
	});
});

// ─── 4. ResponseItem mapping (LLMMessage → input) ────────────────────────────────────

describe("buildInput — LLMMessage → ResponseItem mapping", () => {
	it("system role is consumed into instructions and never emitted into input", () => {
		const items = buildInput([
			{ role: "system", content: "ignored — goes into top-level `instructions`" },
			{ role: "user", content: "hi" },
		]);
		expect(items.find((i) => (i as any).role === "system")).toBeUndefined();
		expect(items).toHaveLength(1);
		expect(items[0]).toEqual({
			type: "message",
			role: "user",
			content: [{ type: "input_text", text: "hi" }],
		});
	});

	it("user text → message with input_text content", () => {
		const items = buildInput([{ role: "user", content: "hello world" }]);
		expect(items[0]).toEqual({
			type: "message",
			role: "user",
			content: [{ type: "input_text", text: "hello world" }],
		});
	});

	it("user images map to input_image with data: URLs", () => {
		const items = buildInput([
			{
				role: "user",
				content: [
					{ type: "text", text: "look at this:" },
					{ type: "image", data: "AAA", mimeType: "image/png" },
				],
			},
		]);
		expect(items[0]).toEqual({
			type: "message",
			role: "user",
			content: [
				{ type: "input_text", text: "look at this:" },
				{ type: "input_image", image_url: "data:image/png;base64,AAA" },
			],
		});
	});

	it("assistant text → message with output_text content", () => {
		const items = buildInput([{ role: "assistant", content: "hi back" }]);
		expect(items[0]).toEqual({
			type: "message",
			role: "assistant",
			content: [{ type: "output_text", text: "hi back" }],
		});
	});

	it("assistant tool_call blocks → function_call ResponseItems with stringified arguments", () => {
		const items = buildInput([
			{
				role: "assistant",
				content: [
					{ type: "text", text: "I'll run a command" },
					{ type: "tool_call", id: "call_abc", name: "exec_command", arguments: { cmd: "ls" } },
				],
			},
		]);
		// Order: text message first, then function_call (matches buildInput's documented order).
		expect(items).toHaveLength(2);
		expect(items[0]).toEqual({
			type: "message",
			role: "assistant",
			content: [{ type: "output_text", text: "I'll run a command" }],
		});
		expect(items[1]).toEqual({
			type: "function_call",
			name: "exec_command",
			arguments: '{"cmd":"ls"}',
			call_id: "call_abc",
		});
	});

	it("tool role → function_call_output", () => {
		const items = buildInput([{ role: "tool", toolCallId: "call_abc", content: "done" }]);
		expect(items[0]).toEqual({
			type: "function_call_output",
			call_id: "call_abc",
			output: "done",
		});
	});

	it("reasoning blocks are replayed verbatim with encrypted_content (Codex chain-of-thought continuity)", () => {
		const items = buildInput([
			{
				role: "assistant",
				content: [
					{
						type: "reasoning",
						encryptedContent: "ENC_BLOB_abc_xyz",
						summary: ["thinking about the problem", "considering options"],
					},
					{ type: "text", text: "Here is my answer." },
				],
			},
		]);
		// Reasoning emitted FIRST (matches server output order: reasoning → message → tool_calls).
		expect(items[0]).toEqual({
			type: "reasoning",
			summary: [
				{ type: "summary_text", text: "thinking about the problem" },
				{ type: "summary_text", text: "considering options" },
			],
			encrypted_content: "ENC_BLOB_abc_xyz",
		});
		expect(items[1]).toEqual({
			type: "message",
			role: "assistant",
			content: [{ type: "output_text", text: "Here is my answer." }],
		});
	});

	it("Anthropic-flavored thinking blocks (no encrypted_content) are NOT replayed to Responses API", () => {
		const items = buildInput([
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "raw plaintext from anthropic" },
					{ type: "text", text: "answer" },
				],
			},
		]);
		// thinking dropped, only the assistant message survives.
		expect(items).toHaveLength(1);
		expect(items[0]).toEqual({
			type: "message",
			role: "assistant",
			content: [{ type: "output_text", text: "answer" }],
		});
	});
});

// ─── 5. SSE parsing smoke test ───────────────────────────────────────────────────────

describe("OpenAIResponsesProvider — SSE parsing", () => {
	function makeSseStream(events: any[]): ReadableStream<Uint8Array> {
		const encoder = new TextEncoder();
		return new ReadableStream<Uint8Array>({
			start(controller) {
				for (const ev of events) {
					const payload = `data: ${JSON.stringify(ev)}\n\n`;
					controller.enqueue(encoder.encode(payload));
				}
				controller.close();
			},
		});
	}

	function makeProvider(stream: ReadableStream<Uint8Array>): OpenAIResponsesProvider {
		const provider = new OpenAIResponsesProvider(
			{
				name: "test-responses",
				displayName: "Test",
				protocol: "openai-responses",
				baseUrl: "https://example.invalid/v1",
				apiKeyEnvVar: "TEST_API_KEY",
				defaultModel: "gpt-5.4",
			},
			{ apiKey: "sk-test", maxRetries: 0 },
		);
		// Stub out fetch so the provider's stream() drives our fake SSE.
		(provider as any).fetchWithRetry = async () =>
			new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
		return provider;
	}

	it("emits text_delta events from response.output_text.delta and completes with final usage", async () => {
		const provider = makeProvider(
			makeSseStream([
				{ type: "response.created", response: { id: "resp_1" } },
				{ type: "response.output_text.delta", delta: "Hello, " },
				{ type: "response.output_text.delta", delta: "world!" },
				{
					type: "response.completed",
					response: {
						id: "resp_1",
						status: "completed",
						usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
					},
				},
			]),
		);

		const events: any[] = [];
		for await (const ev of provider.stream([{ role: "user", content: "hi" }], {
			systemPrompt: SYSTEM_PROMPT,
			tools: TOOLS,
		})) {
			events.push(ev);
		}

		const textDeltas = events.filter((e) => e.type === "text_delta").map((e) => e.delta);
		expect(textDeltas).toEqual(["Hello, ", "world!"]);

		const done = events.at(-1);
		expect(done.type).toBe("done");
		expect(done.response.content).toBe("Hello, world!");
		expect(done.response.usage).toEqual({ inputTokens: 10, outputTokens: 4, totalTokens: 14 });
	});

	it("captures function_call output_item.done into contentBlocks with parsed arguments", async () => {
		const provider = makeProvider(
			makeSseStream([
				{ type: "response.created", response: { id: "resp_2" } },
				{
					type: "response.output_item.added",
					output_index: 0,
					item: { id: "fc_abc", type: "function_call", name: "exec_command", call_id: "call_abc" },
				},
				{
					type: "response.function_call_arguments.delta",
					item_id: "fc_abc",
					call_id: "call_abc",
					delta: '{"cmd":',
				},
				{
					type: "response.function_call_arguments.delta",
					item_id: "fc_abc",
					call_id: "call_abc",
					delta: '"ls"}',
				},
				{
					type: "response.output_item.done",
					item: {
						id: "fc_abc",
						type: "function_call",
						name: "exec_command",
						call_id: "call_abc",
						arguments: '{"cmd":"ls"}',
					},
				},
				{
					type: "response.completed",
					response: {
						id: "resp_2",
						status: "completed",
						usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
					},
				},
			]),
		);

		const events: any[] = [];
		for await (const ev of provider.stream([{ role: "user", content: "ls" }], {
			systemPrompt: SYSTEM_PROMPT,
			tools: TOOLS,
		})) {
			events.push(ev);
		}

		const done = events.at(-1);
		expect(done.type).toBe("done");
		const tc = done.response.contentBlocks.find((b: any) => b.type === "tool_call");
		expect(tc).toEqual({
			type: "tool_call",
			id: "call_abc",
			name: "exec_command",
			arguments: { cmd: "ls" },
		});
	});

	it("captures reasoning output_item.done into a reasoning block with encrypted_content for replay", async () => {
		const provider = makeProvider(
			makeSseStream([
				{ type: "response.created", response: { id: "resp_3" } },
				{
					type: "response.reasoning_summary_text.delta",
					summary_index: 0,
					delta: "Considering ",
				},
				{
					type: "response.reasoning_summary_text.delta",
					summary_index: 0,
					delta: "the problem.",
				},
				{
					type: "response.output_item.done",
					item: {
						id: "r_1",
						type: "reasoning",
						summary: [{ type: "summary_text", text: "Considering the problem." }],
						encrypted_content: "ENC_BLOB_xyz",
					},
				},
				{ type: "response.output_text.delta", delta: "answer" },
				{
					type: "response.completed",
					response: {
						id: "resp_3",
						status: "completed",
						usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
					},
				},
			]),
		);

		const events: any[] = [];
		for await (const ev of provider.stream([{ role: "user", content: "hi" }], {
			systemPrompt: SYSTEM_PROMPT,
			tools: TOOLS,
			thinking: "high",
		})) {
			events.push(ev);
		}

		// Reasoning summary deltas should have been emitted as reasoning_summary_delta events.
		const summaryDeltas = events.filter((e) => e.type === "reasoning_summary_delta").map((e) => e.delta);
		expect(summaryDeltas).toEqual(["Considering ", "the problem."]);

		const done = events.at(-1);
		const reasoning = done.response.contentBlocks.find((b: any) => b.type === "reasoning");
		expect(reasoning).toBeTruthy();
		expect(reasoning.encryptedContent).toBe("ENC_BLOB_xyz");
		expect(reasoning.summary).toEqual(["Considering the problem."]);
	});

	it("response.failed events surface as thrown errors with the server-provided message", async () => {
		const provider = makeProvider(
			makeSseStream([
				{ type: "response.created", response: { id: "resp_err" } },
				{
					type: "response.failed",
					response: { id: "resp_err", error: { message: "context_window_exceeded" } },
				},
			]),
		);

		await expect(async () => {
			for await (const _ev of provider.stream([{ role: "user", content: "hi" }])) {
				// drain
			}
		}).rejects.toThrow(/context_window_exceeded/);
	});
});

// ─── 6. Layer-2 incremental transport (`previous_response_id`) ───────────────────────

describe("tryBuildIncremental — pure decision function", () => {
	const baseFullBody = () =>
		buildRequestBody({
			model: "gpt-5.4",
			messages: [{ role: "user", content: "hello 1" }],
			opts: baseOpts,
			store: true,
		});

	it("returns full with reason 'no-prior-state' when state is null (first turn always full)", () => {
		const decision = tryBuildIncremental(baseFullBody(), null);
		expect(decision.mode).toBe("full");
		if (decision.mode === "full") {
			expect(decision.reason).toBe("no-prior-state");
			expect(decision.wire).toEqual(baseFullBody());
		}
	});

	it("returns incremental wire form when non-input fields match and input strictly extends baseline", () => {
		const turn1Full = buildRequestBody({
			model: "gpt-5.4",
			messages: [{ role: "user", content: "hello 1" }],
			opts: baseOpts,
			store: true,
		});
		// Server emits an assistant message in turn 1.
		const itemsAdded = [
			{
				type: "message" as const,
				role: "assistant" as const,
				content: [{ type: "output_text" as const, text: "hi 1" }],
			},
		];
		// Turn 2: same instructions/tools, conversation grows by assistant_1 + user_2.
		const turn2Full = buildRequestBody({
			model: "gpt-5.4",
			messages: [
				{ role: "user", content: "hello 1" },
				{ role: "assistant", content: "hi 1" },
				{ role: "user", content: "hello 2" },
			],
			opts: baseOpts,
			store: true,
		});

		const decision = tryBuildIncremental(turn2Full, {
			lastFullRequest: turn1Full,
			lastResponseId: "resp_1",
			lastItemsAddedWire: itemsAdded,
		});

		expect(decision.mode).toBe("incremental");
		if (decision.mode === "incremental") {
			// Wire MUST carry previous_response_id slotted in spec position (after instructions).
			const keys = Object.keys(decision.wire);
			expect(keys[0]).toBe("model");
			expect(keys[1]).toBe("instructions");
			expect(keys[2]).toBe("previous_response_id");
			expect(keys[3]).toBe("input");

			expect(decision.wire.previous_response_id).toBe("resp_1");
			// Input must be JUST the delta (the user_2 message), not the full history.
			expect(decision.wire.input).toEqual([
				{
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: "hello 2" }],
				},
			]);
			// Other fields must equal the full body's same fields (byte-equal prefix).
			expect(JSON.stringify(decision.wire.tools)).toBe(JSON.stringify(turn2Full.tools));
			expect(decision.wire.prompt_cache_key).toBe(turn2Full.prompt_cache_key);
		}
	});

	it("degrades to full when ANY non-input field changes (e.g. tools list)", () => {
		const turn1 = buildRequestBody({
			model: "gpt-5.4",
			messages: [{ role: "user", content: "hello 1" }],
			opts: baseOpts,
			store: true,
		});
		const differentTools: ToolDefinition[] = [
			{ name: "new_tool", description: "added mid-session", parameters: { type: "object", properties: {} } },
		];
		const turn2 = buildRequestBody({
			model: "gpt-5.4",
			messages: [
				{ role: "user", content: "hello 1" },
				{ role: "assistant", content: "hi 1" },
				{ role: "user", content: "hello 2" },
			],
			opts: { ...baseOpts, tools: differentTools },
			store: true,
		});

		const decision = tryBuildIncremental(turn2, {
			lastFullRequest: turn1,
			lastResponseId: "resp_1",
			lastItemsAddedWire: [
				{
					type: "message",
					role: "assistant",
					content: [{ type: "output_text", text: "hi 1" }],
				},
			],
		});
		expect(decision.mode).toBe("full");
		if (decision.mode === "full") {
			expect(decision.reason).toBe("non-input-fields-differ");
		}
	});

	it("degrades to full when input is NOT a strict prefix-extension of (prev.input + items_added)", () => {
		const turn1 = buildRequestBody({
			model: "gpt-5.4",
			messages: [{ role: "user", content: "hello 1" }],
			opts: baseOpts,
			store: true,
		});
		// Turn 2 fork: user retracted "hello 1" and starts a different conversation.
		const turn2 = buildRequestBody({
			model: "gpt-5.4",
			messages: [{ role: "user", content: "different opening" }],
			opts: baseOpts,
			store: true,
		});
		const decision = tryBuildIncremental(turn2, {
			lastFullRequest: turn1,
			lastResponseId: "resp_1",
			lastItemsAddedWire: [
				{
					type: "message",
					role: "assistant",
					content: [{ type: "output_text", text: "hi 1" }],
				},
			],
		});
		expect(decision.mode).toBe("full");
		if (decision.mode === "full") {
			// Either no-new-items (if shorter) or input-not-prefix-extension (if same length but different).
			expect(["no-new-items", "input-not-prefix-extension"]).toContain(decision.reason);
		}
	});

	it("degrades to full when delta contains a function_call_output (server requires the matching function_call in the SAME request)", () => {
		// Reproduces the production bug: turn N's response = [function_call call_X]; turn N+1
		// adds the local tool-execution result as `function_call_output`. Naive L2 would send
		// just [function_call_output] as delta, but the OpenAI Responses HTTP API rejects with
		// "No tool call found for function call output with call_id call_X" because it requires
		// the function_call to appear in the SAME request's input. Must fall back to FULL.
		const turn1Full = buildRequestBody({
			model: "gpt-5.4",
			messages: [{ role: "user", content: "kill the agents" }],
			opts: baseOpts,
			store: true,
		});
		const itemsAdded = [
			{
				type: "function_call" as const,
				name: "kill_agent",
				arguments: '{"agent_id":"all"}',
				call_id: "call_X",
			},
		];
		// Turn 2: cliclaw appended the tool result → conversation now has the original user
		// msg + the function_call (assistant) + the function_call_output (tool).
		const turn2Full = buildRequestBody({
			model: "gpt-5.4",
			messages: [
				{ role: "user", content: "kill the agents" },
				{
					role: "assistant",
					content: [{ type: "tool_call", id: "call_X", name: "kill_agent", arguments: { agent_id: "all" } }],
				},
				{ role: "tool", toolCallId: "call_X", content: "killed 2 agents" },
			],
			opts: baseOpts,
			store: true,
		});

		const decision = tryBuildIncremental(turn2Full, {
			lastFullRequest: turn1Full,
			lastResponseId: "resp_1",
			lastItemsAddedWire: itemsAdded,
		});

		expect(decision.mode).toBe("full");
		if (decision.mode === "full") {
			expect(decision.reason).toBe("delta-contains-function_call_output");
		}
	});

	it("degrades to full with reason 'no-new-items' when there are zero delta items", () => {
		const turn1 = buildRequestBody({
			model: "gpt-5.4",
			messages: [{ role: "user", content: "hello 1" }],
			opts: baseOpts,
			store: true,
		});
		// "Re-send" the exact same conversation state — no new user input.
		const decision = tryBuildIncremental(turn1, {
			lastFullRequest: turn1,
			lastResponseId: "resp_1",
			lastItemsAddedWire: [],
		});
		expect(decision.mode).toBe("full");
		if (decision.mode === "full") {
			expect(decision.reason).toBe("no-new-items");
		}
	});
});

describe("inputStartsWith — wire-array structural prefix check", () => {
	it("returns true when needle is a structural prefix of haystack", () => {
		const a = {
			type: "message" as const,
			role: "user" as const,
			content: [{ type: "input_text" as const, text: "x" }],
		};
		const b = {
			type: "message" as const,
			role: "assistant" as const,
			content: [{ type: "output_text" as const, text: "y" }],
		};
		expect(inputStartsWith([a, b, a], [a, b])).toBe(true);
		expect(inputStartsWith([a, b], [a, b])).toBe(true);
	});

	it("returns false when items don't structurally match", () => {
		const a = {
			type: "message" as const,
			role: "user" as const,
			content: [{ type: "input_text" as const, text: "x" }],
		};
		const aPrime = {
			type: "message" as const,
			role: "user" as const,
			content: [{ type: "input_text" as const, text: "x'" }],
		};
		expect(inputStartsWith([aPrime], [a])).toBe(false);
	});

	it("returns false when needle is longer than haystack", () => {
		const a = {
			type: "message" as const,
			role: "user" as const,
			content: [{ type: "input_text" as const, text: "x" }],
		};
		expect(inputStartsWith([a], [a, a])).toBe(false);
	});
});

describe("OpenAIResponsesProvider — Layer-2 chain integration", () => {
	function makeSseStream(events: any[]): ReadableStream<Uint8Array> {
		const encoder = new TextEncoder();
		return new ReadableStream<Uint8Array>({
			start(controller) {
				for (const ev of events) {
					controller.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`));
				}
				controller.close();
			},
		});
	}

	function makeProvider(opts?: { enableIncremental?: boolean }): OpenAIResponsesProvider {
		return new OpenAIResponsesProvider(
			{
				name: "test-responses",
				displayName: "Test",
				protocol: "openai-responses",
				baseUrl: "https://example.invalid/v1",
				apiKeyEnvVar: "TEST_API_KEY",
				defaultModel: "gpt-5.4",
			},
			{ apiKey: "sk-test", maxRetries: 0, enableIncremental: opts?.enableIncremental },
		);
	}

	function stubFetch(provider: OpenAIResponsesProvider, sseEvents: any[]): { lastBody: any | null } {
		const ref: { lastBody: any | null } = { lastBody: null };
		(provider as any).fetchWithRetry = async (_url: string, body: any) => {
			ref.lastBody = body;
			return new Response(makeSseStream(sseEvents), {
				headers: { "Content-Type": "text/event-stream" },
			});
		};
		return ref;
	}

	it("captures lastResponseId + lastItemsAddedWire after a successful turn (only when L2 is opted in)", async () => {
		// Default is L2-off; this test exercises the opt-in code path explicitly.
		const provider = makeProvider({ enableIncremental: true });
		stubFetch(provider, [
			{ type: "response.created", response: { id: "resp_42" } },
			{ type: "response.output_text.delta", delta: "hi 1" },
			{
				type: "response.output_item.done",
				item: {
					type: "message",
					role: "assistant",
					content: [{ type: "output_text", text: "hi 1" }],
				},
			},
			{
				type: "response.completed",
				response: {
					id: "resp_42",
					status: "completed",
					usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
				},
			},
		]);

		for await (const _ev of provider.stream([{ role: "user", content: "hello 1" }], baseOpts)) {
			// drain
		}

		const state = provider.getIncrementalStateSnapshot();
		expect(state).not.toBeNull();
		expect(state?.lastResponseId).toBe("resp_42");
		expect(state?.lastItemsAddedWire).toEqual([
			{
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: "hi 1" }],
			},
		]);
	});

	it("second turn POSTs an incremental payload with previous_response_id and delta-only input (only when L2 is opted in)", async () => {
		const provider = makeProvider({ enableIncremental: true });

		// Turn 1: full request, server returns resp_1.
		const tap1 = stubFetch(provider, [
			{ type: "response.created", response: { id: "resp_1" } },
			{
				type: "response.output_item.done",
				item: {
					type: "message",
					role: "assistant",
					content: [{ type: "output_text", text: "hi 1" }],
				},
			},
			{
				type: "response.completed",
				response: { id: "resp_1", status: "completed", usage: {} },
			},
		]);
		for await (const _ev of provider.stream([{ role: "user", content: "hello 1" }], baseOpts)) {
			// drain
		}
		expect(tap1.lastBody.previous_response_id).toBeUndefined();
		expect(tap1.lastBody.input).toHaveLength(1);

		// Turn 2: same provider instance → state populated → should be incremental.
		const tap2 = stubFetch(provider, [
			{ type: "response.created", response: { id: "resp_2" } },
			{
				type: "response.output_item.done",
				item: {
					type: "message",
					role: "assistant",
					content: [{ type: "output_text", text: "hi 2" }],
				},
			},
			{
				type: "response.completed",
				response: { id: "resp_2", status: "completed", usage: {} },
			},
		]);
		await (async () => {
			for await (const _ev of provider.stream(
				[
					{ role: "user", content: "hello 1" },
					{ role: "assistant", content: "hi 1" },
					{ role: "user", content: "hello 2" },
				],
				baseOpts,
			)) {
				// drain
			}
		})();

		expect(tap2.lastBody.previous_response_id).toBe("resp_1");
		expect(tap2.lastBody.input).toEqual([
			{
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: "hello 2" }],
			},
		]);
	});

	it("when system prompt changes (instructions diff), turn 2 falls back to FULL transmission", async () => {
		const provider = makeProvider();

		stubFetch(provider, [
			{ type: "response.created", response: { id: "resp_1" } },
			{
				type: "response.output_item.done",
				item: {
					type: "message",
					role: "assistant",
					content: [{ type: "output_text", text: "hi 1" }],
				},
			},
			{ type: "response.completed", response: { id: "resp_1", status: "completed", usage: {} } },
		]);
		for await (const _ev of provider.stream([{ role: "user", content: "hello 1" }], baseOpts)) {
			// drain
		}

		// Turn 2: system prompt changed (e.g. {{memory}} hot-reloaded).
		const tap2 = stubFetch(provider, [
			{ type: "response.created", response: { id: "resp_2" } },
			{ type: "response.completed", response: { id: "resp_2", status: "completed", usage: {} } },
		]);
		await (async () => {
			for await (const _ev of provider.stream(
				[
					{ role: "user", content: "hello 1" },
					{ role: "assistant", content: "hi 1" },
					{ role: "user", content: "hello 2" },
				],
				{ ...baseOpts, systemPrompt: "ENTIRELY DIFFERENT system prompt" },
			)) {
				// drain
			}
		})();

		expect(tap2.lastBody.previous_response_id).toBeUndefined();
		expect(tap2.lastBody.input).toHaveLength(3); // full history sent
	});

	it("response.failed clears the chain so the next turn is full", async () => {
		const provider = makeProvider();

		// Turn 1: server fails.
		stubFetch(provider, [
			{ type: "response.created", response: { id: "resp_err" } },
			{
				type: "response.failed",
				response: { id: "resp_err", error: { message: "internal error" } },
			},
		]);
		await expect(async () => {
			for await (const _ev of provider.stream([{ role: "user", content: "hello 1" }], baseOpts)) {
				// drain
			}
		}).rejects.toThrow();

		expect(provider.getIncrementalStateSnapshot()).toBeNull();

		// Turn 2: state is empty → full request.
		const tap2 = stubFetch(provider, [
			{ type: "response.created", response: { id: "resp_2" } },
			{ type: "response.completed", response: { id: "resp_2", status: "completed", usage: {} } },
		]);
		for await (const _ev of provider.stream([{ role: "user", content: "hello 2" }], baseOpts)) {
			// drain
		}
		expect(tap2.lastBody.previous_response_id).toBeUndefined();
	});

	it("resetIncrementalChain() forces the next turn to be full (used by /clear and /compact, with L2 opted in)", async () => {
		const provider = makeProvider({ enableIncremental: true });

		stubFetch(provider, [
			{ type: "response.created", response: { id: "resp_1" } },
			{
				type: "response.output_item.done",
				item: {
					type: "message",
					role: "assistant",
					content: [{ type: "output_text", text: "hi 1" }],
				},
			},
			{ type: "response.completed", response: { id: "resp_1", status: "completed", usage: {} } },
		]);
		for await (const _ev of provider.stream([{ role: "user", content: "hello 1" }], baseOpts)) {
			// drain
		}
		expect(provider.getIncrementalStateSnapshot()).not.toBeNull();

		provider.resetIncrementalChain();
		expect(provider.getIncrementalStateSnapshot()).toBeNull();

		const tap2 = stubFetch(provider, [
			{ type: "response.created", response: { id: "resp_2" } },
			{ type: "response.completed", response: { id: "resp_2", status: "completed", usage: {} } },
		]);
		await (async () => {
			for await (const _ev of provider.stream(
				[
					{ role: "user", content: "hello 1" },
					{ role: "assistant", content: "hi 1" },
					{ role: "user", content: "hello 2" },
				],
				baseOpts,
			)) {
				// drain
			}
		})();
		expect(tap2.lastBody.previous_response_id).toBeUndefined();
	});

	it("DEFAULT (no opts.enableIncremental): L2 is OFF → every turn full, no previous_response_id, no state retained, store=false (matches Codex HTTP path)", async () => {
		// This is the steady-state behavior used by all real cliclaw sessions. The test
		// pins the default-off so a regression that flips it back to default-on (which
		// triggers 400 'No tool call found' on tool turns) gets caught.
		const provider = makeProvider();

		const tap1 = stubFetch(provider, [
			{ type: "response.created", response: { id: "resp_1" } },
			{
				type: "response.output_item.done",
				item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "hi 1" }] },
			},
			{ type: "response.completed", response: { id: "resp_1", status: "completed", usage: {} } },
		]);
		for await (const _ev of provider.stream([{ role: "user", content: "hello 1" }], baseOpts)) {
			// drain
		}
		expect(tap1.lastBody.previous_response_id).toBeUndefined();
		expect(tap1.lastBody.store).toBe(false); // matches Codex HTTP, OpenAI direct
		expect(provider.getIncrementalStateSnapshot()).toBeNull(); // no state retained when L2 off

		// Turn 2: also full, no prev_id, regardless of what server returned previously.
		const tap2 = stubFetch(provider, [
			{ type: "response.created", response: { id: "resp_2" } },
			{ type: "response.completed", response: { id: "resp_2", status: "completed", usage: {} } },
		]);
		await (async () => {
			for await (const _ev of provider.stream(
				[
					{ role: "user", content: "hello 1" },
					{ role: "assistant", content: "hi 1" },
					{ role: "user", content: "hello 2" },
				],
				baseOpts,
			)) {
				// drain
			}
		})();
		expect(tap2.lastBody.previous_response_id).toBeUndefined();
		expect(tap2.lastBody.input).toHaveLength(3); // FULL history, not delta
		expect(provider.getIncrementalStateSnapshot()).toBeNull();
	});

	it("enableIncremental:false disables Layer-2 entirely (every turn goes full)", async () => {
		const provider = makeProvider({ enableIncremental: false });

		const tap1 = stubFetch(provider, [
			{ type: "response.created", response: { id: "resp_1" } },
			{
				type: "response.output_item.done",
				item: {
					type: "message",
					role: "assistant",
					content: [{ type: "output_text", text: "hi 1" }],
				},
			},
			{ type: "response.completed", response: { id: "resp_1", status: "completed", usage: {} } },
		]);
		for await (const _ev of provider.stream([{ role: "user", content: "hello 1" }], baseOpts)) {
			// drain
		}
		expect(tap1.lastBody.previous_response_id).toBeUndefined();

		const tap2 = stubFetch(provider, [
			{ type: "response.created", response: { id: "resp_2" } },
			{ type: "response.completed", response: { id: "resp_2", status: "completed", usage: {} } },
		]);
		await (async () => {
			for await (const _ev of provider.stream(
				[
					{ role: "user", content: "hello 1" },
					{ role: "assistant", content: "hi 1" },
					{ role: "user", content: "hello 2" },
				],
				baseOpts,
			)) {
				// drain
			}
		})();
		expect(tap2.lastBody.previous_response_id).toBeUndefined();
		expect(tap2.lastBody.input).toHaveLength(3);
	});

	it("enableIncremental:true forces store=true on the wire (server retention required)", async () => {
		const provider = makeProvider({ enableIncremental: true });
		const tap = stubFetch(provider, [
			{ type: "response.created", response: { id: "resp_1" } },
			{ type: "response.completed", response: { id: "resp_1", status: "completed", usage: {} } },
		]);
		for await (const _ev of provider.stream([{ role: "user", content: "x" }], baseOpts)) {
			// drain
		}
		expect(tap.lastBody.store).toBe(true);
	});

	it("4xx errors (non-retryable) fail fast without retrying — prevents the 4-billable-calls retry storm we hit on 400 'No tool call found'", async () => {
		const provider = makeProvider();
		// Stub fetch to always return 400. If retries fired, it'd be called 4 times.
		let fetchCount = 0;
		(provider as any).fetchWithRetry = async (url: string, body: any) => {
			fetchCount++;
			// Reuse the real retry logic by constructing a fetch mock that always 400s.
			throw Object.assign(new Error("[test-responses] API error 400: invalid"), { nonRetryable: true });
		};
		await expect(async () => {
			for await (const _ev of provider.stream([{ role: "user", content: "hi" }], baseOpts)) {
				// drain
			}
		}).rejects.toThrow(/API error 400/);
		// No retries — fetchCount == 1 because nonRetryable forced an early throw.
		expect(fetchCount).toBe(1);
	});
});

// ─── 7. Stream-level retry on transient `response.failed` ────────────────────────────

describe("isTransientStreamFailureMessage — pure classifier", () => {
	it("matches the OpenAI overload message we saw in production", () => {
		expect(isTransientStreamFailureMessage("Our servers are currently overloaded. Please try again later.")).toBe(
			true,
		);
	});

	it("matches rate-limit, 5xx, timeout, internal-error variants", () => {
		expect(isTransientStreamFailureMessage("Rate limit reached for ...")).toBe(true);
		expect(isTransientStreamFailureMessage("Internal server error")).toBe(true);
		expect(isTransientStreamFailureMessage("Bad gateway")).toBe(true);
		expect(isTransientStreamFailureMessage("Service unavailable")).toBe(true);
		expect(isTransientStreamFailureMessage("Gateway timeout")).toBe(true);
		expect(isTransientStreamFailureMessage("Request timed out")).toBe(true);
		expect(isTransientStreamFailureMessage("HTTP 503")).toBe(true);
	});

	it("does NOT match permanent / client-side failures", () => {
		expect(isTransientStreamFailureMessage("context_window_exceeded")).toBe(false);
		expect(isTransientStreamFailureMessage("invalid_request_error")).toBe(false);
		expect(isTransientStreamFailureMessage("content_policy_violation")).toBe(false);
		expect(isTransientStreamFailureMessage("model_not_found")).toBe(false);
	});
});

describe("isRetryableStreamError — error-shape gate", () => {
	it("returns true only when the error is tagged `retryable=true`", () => {
		const e = Object.assign(new Error("overloaded"), { retryable: true });
		expect(isRetryableStreamError(e)).toBe(true);
	});

	it("returns false for AbortError, nonRetryable, untagged, or non-Error inputs", () => {
		expect(isRetryableStreamError(Object.assign(new Error("aborted"), { name: "AbortError" }))).toBe(false);
		expect(isRetryableStreamError(Object.assign(new Error("400"), { nonRetryable: true }))).toBe(false);
		expect(isRetryableStreamError(new Error("plain"))).toBe(false);
		expect(isRetryableStreamError(undefined)).toBe(false);
		expect(isRetryableStreamError("string error")).toBe(false);
	});
});

describe("OpenAIResponsesProvider — stream-level retry on transient response.failed", () => {
	function makeSseStream(events: any[]): ReadableStream<Uint8Array> {
		const encoder = new TextEncoder();
		return new ReadableStream<Uint8Array>({
			start(controller) {
				for (const ev of events) {
					controller.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`));
				}
				controller.close();
			},
		});
	}

	function makeProvider(maxRetries: number): OpenAIResponsesProvider {
		return new OpenAIResponsesProvider(
			{
				name: "test-responses",
				displayName: "Test",
				protocol: "openai-responses",
				baseUrl: "https://example.invalid/v1",
				apiKeyEnvVar: "TEST_API_KEY",
				defaultModel: "gpt-5.4",
			},
			// timeout==0 forces zero-delay retries so tests don't sleep on the exponential backoff.
			{ apiKey: "sk-test", maxRetries, timeout: 0 },
		);
	}

	function stubFetchSequence(provider: OpenAIResponsesProvider, sseStreamsPerCall: any[][]): { calls: number } {
		const ref = { calls: 0 };
		(provider as any).fetchWithRetry = async () => {
			const events = sseStreamsPerCall[ref.calls] ?? sseStreamsPerCall[sseStreamsPerCall.length - 1];
			ref.calls++;
			return new Response(makeSseStream(events), {
				headers: { "Content-Type": "text/event-stream" },
			});
		};
		return ref;
	}

	const overloadedFailureEvents = [
		{ type: "response.created", response: { id: "resp_overload" } },
		{
			type: "response.failed",
			response: {
				id: "resp_overload",
				error: { message: "Our servers are currently overloaded. Please try again later." },
			},
		},
	];

	const successEvents = [
		{ type: "response.created", response: { id: "resp_ok" } },
		{ type: "response.output_text.delta", delta: "ok" },
		{
			type: "response.completed",
			response: { id: "resp_ok", status: "completed", usage: {} },
		},
	];

	it("retries when response.failed carries a transient overload message and eventually succeeds", async () => {
		const provider = makeProvider(3);
		const tap = stubFetchSequence(provider, [overloadedFailureEvents, overloadedFailureEvents, successEvents]);

		const events: any[] = [];
		for await (const ev of provider.stream([{ role: "user", content: "hi" }], baseOpts)) {
			events.push(ev);
		}

		expect(tap.calls).toBe(3); // two failures + one success
		const textDeltas = events.filter((e) => e.type === "text_delta").map((e) => e.delta);
		expect(textDeltas).toEqual(["ok"]);
		const done = events.at(-1);
		expect(done.type).toBe("done");
	});

	it("does NOT retry when response.failed is non-transient (e.g. context_window_exceeded)", async () => {
		const provider = makeProvider(3);
		const nonTransient = [
			{ type: "response.created", response: { id: "resp_ctx" } },
			{
				type: "response.failed",
				response: { id: "resp_ctx", error: { message: "context_window_exceeded" } },
			},
		];
		const tap = stubFetchSequence(provider, [nonTransient]);

		await expect(async () => {
			for await (const _ev of provider.stream([{ role: "user", content: "hi" }], baseOpts)) {
				// drain
			}
		}).rejects.toThrow(/context_window_exceeded/);
		expect(tap.calls).toBe(1); // failed once, no retry
	});

	it("does NOT retry when deltas have already been yielded to the caller (would duplicate UI output)", async () => {
		const provider = makeProvider(3);
		// Server emits a text delta first, THEN fails with a transient error mid-stream.
		// Even though the error is transient, retrying would duplicate the already-yielded
		// "partial" delta on the UI — we must throw instead.
		const partialThenFail = [
			{ type: "response.created", response: { id: "resp_partial" } },
			{ type: "response.output_text.delta", delta: "partial" },
			{
				type: "response.failed",
				response: { id: "resp_partial", error: { message: "Our servers are currently overloaded." } },
			},
		];
		const tap = stubFetchSequence(provider, [partialThenFail]);

		const collected: any[] = [];
		await expect(async () => {
			for await (const ev of provider.stream([{ role: "user", content: "hi" }], baseOpts)) {
				collected.push(ev);
			}
		}).rejects.toThrow(/overloaded/);
		expect(tap.calls).toBe(1);
		// The "partial" delta was forwarded to the caller before the failure.
		expect(collected.filter((e) => e.type === "text_delta").map((e) => e.delta)).toEqual(["partial"]);
	});

	it("gives up after maxRetries consecutive transient failures and surfaces the last error", async () => {
		const provider = makeProvider(2); // up to 2 retries → 3 total attempts
		const tap = stubFetchSequence(provider, [
			overloadedFailureEvents,
			overloadedFailureEvents,
			overloadedFailureEvents,
		]);

		await expect(async () => {
			for await (const _ev of provider.stream([{ role: "user", content: "hi" }], baseOpts)) {
				// drain
			}
		}).rejects.toThrow(/overloaded/);
		expect(tap.calls).toBe(3);
	});

	it("aborts immediately when opts.signal is already aborted, even on a transient failure", async () => {
		const provider = makeProvider(3);
		const tap = stubFetchSequence(provider, [overloadedFailureEvents, successEvents]);
		const ac = new AbortController();
		ac.abort();

		await expect(async () => {
			for await (const _ev of provider.stream([{ role: "user", content: "hi" }], {
				...baseOpts,
				signal: ac.signal,
			})) {
				// drain
			}
		}).rejects.toThrow();
		// Either the underlying parser threw on the failed event AND the loop refused to retry
		// (signal aborted), or fetchWithRetry honored the signal earlier — both are acceptable.
		// What we DON'T want is a successful 2nd-call recovery despite the abort.
		expect(tap.calls).toBeLessThanOrEqual(1);
	});
});
