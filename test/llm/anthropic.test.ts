import { describe, expect, it } from "vitest";
import { AnthropicProvider } from "../../src/llm/providers/anthropic.js";
import type { LLMMessage, ProviderConfig, ToolDefinition } from "../../src/llm/types.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────────────

const CONFIG: ProviderConfig = {
	name: "anthropic",
	displayName: "Anthropic",
	protocol: "anthropic",
	baseUrl: "https://api.anthropic.com",
	apiKeyEnvVar: "ANTHROPIC_API_KEY",
	defaultModel: "claude-sonnet-4-5",
};

const TOOLS: ToolDefinition[] = [
	{
		name: "exec_command",
		description: "Run a shell command",
		parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
	},
	{
		name: "send_to_agent",
		description: "Send a prompt to an agent",
		parameters: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] },
	},
];

function makeProvider(): AnthropicProvider {
	return new AnthropicProvider(CONFIG, { apiKey: "sk-test", model: "claude-sonnet-4-5" });
}

/**
 * Build a fake Anthropic SDK message-content response and capture the params the provider
 * hands to the SDK. Replaces `provider.client` so no network happens.
 */
function stubComplete(provider: AnthropicProvider, responseContent: any[]): { captured: { params: any } } {
	const captured: { params: any } = { params: null };
	(provider as any).client = {
		messages: {
			create: async (params: any) => {
				captured.params = params;
				return {
					content: responseContent,
					usage: { input_tokens: 1, output_tokens: 1 },
					stop_reason: "end_turn",
					model: "claude-sonnet-4-5",
				};
			},
		},
	};
	return { captured };
}

/** Fake MessageStream: async-iterable over `events`, then `finalMessage()` returns `final`. */
function makeFakeStream(events: any[], final: any) {
	return {
		async *[Symbol.asyncIterator]() {
			for (const ev of events) yield ev;
		},
		finalMessage: async () => final,
	};
}

function stubStream(provider: AnthropicProvider, events: any[], final: any): { captured: { params: any } } {
	const captured: { params: any } = { params: null };
	(provider as any).client = {
		messages: {
			stream: (params: any) => {
				captured.params = params;
				return makeFakeStream(events, final);
			},
		},
	};
	return { captured };
}

// ─── LLM-3: prompt caching breakpoints ───────────────────────────────────────────────

describe("AnthropicProvider — prompt caching (LLM-3)", () => {
	it("puts a cache_control breakpoint on the system block, last tool, and last message", async () => {
		const provider = makeProvider();
		const { captured } = stubComplete(provider, [{ type: "text", text: "ok" }]);

		await provider.complete([{ role: "user", content: "hi" }], {
			systemPrompt: "You are an orchestrator.",
			tools: TOOLS,
		});

		const p = captured.params;

		// System is converted to a text block array carrying cache_control.
		expect(Array.isArray(p.system)).toBe(true);
		expect(p.system[0]).toMatchObject({ type: "text", cache_control: { type: "ephemeral" } });

		// Only the LAST tool carries cache_control.
		expect(p.tools).toHaveLength(2);
		expect(p.tools[0].cache_control).toBeUndefined();
		expect(p.tools[1].cache_control).toEqual({ type: "ephemeral" });

		// Last message's last block carries cache_control (string content is normalized to a block).
		const lastMsg = p.messages[p.messages.length - 1];
		const lastBlock = lastMsg.content[lastMsg.content.length - 1];
		expect(lastBlock.cache_control).toEqual({ type: "ephemeral" });

		// Total breakpoints must stay within Anthropic's max of 4.
		const wire = JSON.stringify(p);
		const count = wire.split('"cache_control"').length - 1;
		expect(count).toBeLessThanOrEqual(4);
		expect(count).toBe(3);
	});
});

// ─── LLM-4: thinking signature capture + replay ──────────────────────────────────────

describe("AnthropicProvider — thinking signature (LLM-4)", () => {
	it("captures the signature from a thinking block in the response", async () => {
		const provider = makeProvider();
		stubComplete(provider, [
			{ type: "thinking", thinking: "reasoning…", signature: "SIG_ABC" },
			{ type: "text", text: "answer" },
		]);

		const res = await provider.complete([{ role: "user", content: "hi" }], { thinking: "high" });
		const thinkingBlock = res.contentBlocks.find((b) => b.type === "thinking") as any;
		expect(thinkingBlock.signature).toBe("SIG_ABC");
	});

	it("replays a thinking block WITH its signature when one is present", async () => {
		const provider = makeProvider();
		const { captured } = stubComplete(provider, [{ type: "text", text: "ok" }]);

		await provider.complete(
			[
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "reasoning…", signature: "SIG_ABC" } as any,
						{ type: "text", text: "hi" },
					],
				},
				{ role: "user", content: "continue" },
			],
			{ thinking: "high" },
		);

		const assistantMsg = captured.params.messages.find((m: any) => m.role === "assistant");
		const thinkingPart = assistantMsg.content.find((b: any) => b.type === "thinking");
		expect(thinkingPart).toBeTruthy();
		expect(thinkingPart.signature).toBe("SIG_ABC");
	});

	it("DROPS a signature-less thinking block on replay (legacy history)", async () => {
		const provider = makeProvider();
		const { captured } = stubComplete(provider, [{ type: "text", text: "ok" }]);

		await provider.complete(
			[
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "legacy reasoning without sig" } as any,
						{ type: "text", text: "hi" },
					],
				},
				{ role: "user", content: "continue" },
			],
			{ thinking: "high" },
		);

		const assistantMsg = captured.params.messages.find((m: any) => m.role === "assistant");
		const thinkingPart = assistantMsg.content.find((b: any) => b.type === "thinking");
		expect(thinkingPart).toBeUndefined();
		// The text block still survives.
		expect(assistantMsg.content.some((b: any) => b.type === "text")).toBe(true);
	});
});

// ─── LLM-5: coalesce consecutive tool results ────────────────────────────────────────

describe("AnthropicProvider — tool_result coalescing (LLM-5)", () => {
	it("merges consecutive tool messages into a single user message with multiple tool_result blocks", async () => {
		const provider = makeProvider();
		const { captured } = stubComplete(provider, [{ type: "text", text: "ok" }]);

		const messages: LLMMessage[] = [
			{ role: "user", content: "do two things" },
			{
				role: "assistant",
				content: [
					{ type: "tool_call", id: "call_1", name: "exec_command", arguments: { cmd: "ls" } },
					{ type: "tool_call", id: "call_2", name: "exec_command", arguments: { cmd: "pwd" } },
				],
			},
			{ role: "tool", toolCallId: "call_1", content: "file list" },
			{ role: "tool", toolCallId: "call_2", content: "/root" },
		];

		await provider.complete(messages, { tools: TOOLS });

		// The two tool results must live in ONE user message, not two.
		const toolResultMsgs = captured.params.messages.filter(
			(m: any) =>
				m.role === "user" && Array.isArray(m.content) && m.content.some((b: any) => b.type === "tool_result"),
		);
		expect(toolResultMsgs).toHaveLength(1);
		const blocks = toolResultMsgs[0].content.filter((b: any) => b.type === "tool_result");
		expect(blocks).toHaveLength(2);
		expect(blocks[0].tool_use_id).toBe("call_1");
		expect(blocks[1].tool_use_id).toBe("call_2");
	});

	it("does not coalesce tool results separated by a non-tool message", async () => {
		const provider = makeProvider();
		const { captured } = stubComplete(provider, [{ type: "text", text: "ok" }]);

		const messages: LLMMessage[] = [
			{ role: "tool", toolCallId: "call_1", content: "a" },
			{ role: "assistant", content: "thinking" },
			{ role: "tool", toolCallId: "call_2", content: "b" },
		];

		await provider.complete(messages, {});

		const toolResultMsgs = captured.params.messages.filter(
			(m: any) =>
				m.role === "user" && Array.isArray(m.content) && m.content.some((b: any) => b.type === "tool_result"),
		);
		expect(toolResultMsgs).toHaveLength(2);
	});
});

// ─── LLM-6: streaming tool_call_delta carries id + name ──────────────────────────────

describe("AnthropicProvider — streaming tool_call events (LLM-6)", () => {
	it("carries id and name on tool_call_delta events (from content_block_start)", async () => {
		const provider = makeProvider();
		stubStream(
			provider,
			[
				{
					type: "content_block_start",
					index: 0,
					content_block: { type: "tool_use", id: "call_xyz", name: "exec_command", input: {} },
				},
				{
					type: "content_block_delta",
					index: 0,
					delta: { type: "input_json_delta", partial_json: '{"cmd":' },
				},
				{
					type: "content_block_delta",
					index: 0,
					delta: { type: "input_json_delta", partial_json: '"ls"}' },
				},
			],
			{
				content: [{ type: "tool_use", id: "call_xyz", name: "exec_command", input: { cmd: "ls" } }],
				usage: { input_tokens: 1, output_tokens: 1 },
				stop_reason: "tool_use",
				model: "claude-sonnet-4-5",
			},
		);

		const events: any[] = [];
		for await (const ev of provider.stream([{ role: "user", content: "ls" }], { tools: TOOLS })) {
			events.push(ev);
		}

		const toolDeltas = events.filter((e) => e.type === "tool_call_delta");
		// Every tool_call_delta must carry id and name (not just index+args).
		expect(toolDeltas.length).toBeGreaterThan(0);
		for (const d of toolDeltas) {
			expect(d.id).toBe("call_xyz");
			expect(d.name).toBe("exec_command");
			expect(d.index).toBe(0);
		}
		// The argument deltas are surfaced too.
		const args = toolDeltas.map((d) => d.argumentsDelta).join("");
		expect(args).toBe('{"cmd":"ls"}');
	});
});
