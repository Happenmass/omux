import { describe, it, expect, beforeEach, vi } from "vitest";
import { ContextManager } from "../../src/core/context-manager.js";

function createMockPromptLoader(template: string) {
	return {
		getRaw: vi.fn().mockReturnValue(template),
		resolve: vi.fn().mockReturnValue("You are a history compressor."),
		load: vi.fn(),
		setGlobalContext: vi.fn(),
	} as any;
}

function createMockLLMClient(compressedResult = "## Completed Tasks\n- #1 Setup: done") {
	return {
		complete: vi.fn().mockResolvedValue({ content: compressedResult }),
		completeJson: vi.fn(),
		stream: vi.fn(),
	} as any;
}

describe("ContextManager", () => {
	let contextManager: ContextManager;
	let mockLLM: ReturnType<typeof createMockLLMClient>;
	let mockPromptLoader: ReturnType<typeof createMockPromptLoader>;

	const template = "Goal: {{goal}}\nTasks: {{task_graph_summary}}\nHistory: {{compressed_history}}\nMemory: {{memory}}";

	beforeEach(() => {
		mockLLM = createMockLLMClient();
		mockPromptLoader = createMockPromptLoader(template);
		contextManager = new ContextManager({
			llmClient: mockLLM,
			promptLoader: mockPromptLoader,
		});
	});

	describe("module replacement", () => {
		it("should replace template variables with module values", () => {
			contextManager.updateModule("goal", "Build an API");
			contextManager.updateModule("task_graph_summary", "[✓]#1 [ ]#2");

			const prompt = contextManager.getSystemPrompt();
			expect(prompt).toContain("Goal: Build an API");
			expect(prompt).toContain("Tasks: [✓]#1 [ ]#2");
		});

		it("should clear unreplaced variables", () => {
			contextManager.updateModule("goal", "Test");

			const prompt = contextManager.getSystemPrompt();
			expect(prompt).not.toContain("{{");
			expect(prompt).toContain("Goal: Test");
			expect(prompt).toContain("History: ");
		});

		it("should update modules dynamically", () => {
			contextManager.updateModule("goal", "v1");
			expect(contextManager.getSystemPrompt()).toContain("Goal: v1");

			contextManager.updateModule("goal", "v2");
			expect(contextManager.getSystemPrompt()).toContain("Goal: v2");
		});
	});

	describe("conversation management", () => {
		it("should start with empty conversation", () => {
			expect(contextManager.getMessages()).toHaveLength(0);
		});

		it("should add messages to conversation", () => {
			contextManager.addMessage({ role: "user", content: "hello" });
			contextManager.addMessage({ role: "assistant", content: "hi" });

			const msgs = contextManager.getMessages();
			expect(msgs).toHaveLength(2);
			expect(msgs[0].role).toBe("user");
			expect(msgs[1].role).toBe("assistant");
		});

		it("should track conversation length", () => {
			expect(contextManager.getConversationLength()).toBe(0);
			contextManager.addMessage({ role: "user", content: "test" });
			expect(contextManager.getConversationLength()).toBe(1);
		});
	});

	describe("shouldCompress", () => {
		it("should return false when under threshold", () => {
			contextManager.addMessage({ role: "user", content: "short message" });
			expect(contextManager.shouldCompress()).toBe(false);
		});

		it("should return true when over threshold", () => {
			// With default 500000 limit and 0.7 threshold = 350000 tokens
			// Each char ~0.25 tokens, so need ~1400000 chars
			const longContent = "x".repeat(1_400_001);
			contextManager.addMessage({ role: "user", content: longContent });
			expect(contextManager.shouldCompress()).toBe(true);
		});

		it("should respect custom thresholds", () => {
			const smallCtx = new ContextManager({
				llmClient: mockLLM,
				promptLoader: mockPromptLoader,
				contextWindowLimit: 1000,
				compressionThreshold: 0.5,
				flushThreshold: 0.3, // Must be < compressionThreshold
			});
			// Threshold: 1000 * 0.5 = 500 tokens = ~2000 chars
			smallCtx.addMessage({ role: "user", content: "x".repeat(2100) });
			expect(smallCtx.shouldCompress()).toBe(true);
		});
	});

	describe("compress", () => {
		it("should call LLM with conversation and existing history", async () => {
			contextManager.updateModule("goal", "Build API");
			contextManager.updateModule("task_graph_summary", "[✓]#1");
			contextManager.updateModule("compressed_history", "Previous context");
			contextManager.addMessage({ role: "user", content: "[TASK_READY] Task #2" });
			contextManager.addMessage({ role: "assistant", content: "Starting task" });

			await contextManager.compress();

			expect(mockLLM.complete).toHaveBeenCalledOnce();
			const callArgs = mockLLM.complete.mock.calls[0];
			const input = JSON.parse(callArgs[0][0].content);
			expect(input.existing_history).toBe("Previous context");
			expect(input.new_conversation).toHaveLength(2);
			expect(input.current_goal).toBe("Build API");
		});

		it("should update compressed_history module and clear conversation", async () => {
			contextManager.addMessage({ role: "user", content: "test" });
			contextManager.addMessage({ role: "user", content: "test2" });

			await contextManager.compress();

			// After compress, conversation has 1 post-compaction context message
			expect(contextManager.getMessages()).toHaveLength(1);
			expect(contextManager.getMessages()[0].content).toContain("CONTEXT_RECOVERY");
			expect(contextManager.getSystemPrompt()).toContain("## Completed Tasks");
		});

		it("should handle empty existing history", async () => {
			contextManager.addMessage({ role: "user", content: "first message" });

			await contextManager.compress();

			const callArgs = mockLLM.complete.mock.calls[0];
			const input = JSON.parse(callArgs[0][0].content);
			expect(input.existing_history).toBe("");
		});
	});

	// ─── Task 7.9: New upgrade tests ─────────────────────

	describe("prepareForLLM", () => {
		it("should return system prompt and deep-cloned messages", () => {
			contextManager.updateModule("goal", "Build API");
			contextManager.addMessage({ role: "user", content: "hello" });
			contextManager.addMessage({ role: "assistant", content: "hi" });

			const prepared = contextManager.prepareForLLM();

			expect(prepared.system).toContain("Goal: Build API");
			expect(prepared.messages).toHaveLength(2);
			expect(prepared.messages[0].content).toBe("hello");
		});

		it("should preserve original conversation (tool messages are shallow-copied)", () => {
			contextManager.addMessage({ role: "tool", content: "original-tool-result", toolCallId: "t1" });

			const prepared = contextManager.prepareForLLM();

			// Mutate the prepared tool message content
			(prepared.messages[0] as any).content = "mutated";

			// Original should be unchanged (tool messages are shallow-copied)
			expect(contextManager.getMessages()[0].content).toBe("original-tool-result");
		});

		it("should not modify the original conversation after transformContext", () => {
			// Add a large tool result that would be truncated
			contextManager.addMessage({ role: "user", content: "call tool" });
			contextManager.addMessage({
				role: "tool",
				content: "x".repeat(300000), // Very large tool result
				tool_use_id: "t1",
			});

			const original = contextManager.getMessages();
			const originalToolContent = (original[1] as any).content;

			contextManager.prepareForLLM();

			// Original should be unchanged
			expect(contextManager.getMessages()[1].content).toBe(originalToolContent);
		});
	});

	describe("transformContext", () => {
		it("should truncate single tool result exceeding 50% of context window", () => {
			const smallCtx = new ContextManager({
				llmClient: mockLLM,
				promptLoader: mockPromptLoader,
				contextWindowLimit: 1000, // 50% cap = 500 tokens = 2000 chars
				flushThreshold: 0.3,
			});

			smallCtx.addMessage({ role: "user", content: "test" });
			smallCtx.addMessage({
				role: "tool",
				content: "x".repeat(3000), // exceeds 2000 char cap
				tool_use_id: "t1",
			});

			const prepared = smallCtx.prepareForLLM();
			const toolMsg = prepared.messages.find((m) => m.role === "tool");

			expect((toolMsg as any).content.length).toBeLessThan(3000);
			expect((toolMsg as any).content).toContain("[truncated]");
		});

		it("should compact oldest tool results when budget overflow (75% cap)", () => {
			const smallCtx = new ContextManager({
				llmClient: mockLLM,
				promptLoader: mockPromptLoader,
				contextWindowLimit: 200, // 75% = 150 tokens = 600 chars
				flushThreshold: 0.3,
			});

			// Add multiple tool results that collectively exceed budget
			smallCtx.addMessage({ role: "user", content: "call tool 1" });
			smallCtx.addMessage({ role: "tool", content: "A".repeat(400), tool_use_id: "t1" });
			smallCtx.addMessage({ role: "user", content: "call tool 2" });
			smallCtx.addMessage({ role: "tool", content: "B".repeat(400), tool_use_id: "t2" });

			const prepared = smallCtx.prepareForLLM();

			// The oldest tool result should be compacted
			const firstToolMsg = prepared.messages.find((m) => m.role === "tool");
			expect((firstToolMsg as any).content).toContain("compacted");
		});
	});

	describe("sliding window compaction", () => {
		function buildToolRound(id: string, toolName: string, args: Record<string, any>, result: string) {
			return {
				assistant: {
					role: "assistant" as const,
					content: [{ type: "tool_call" as const, id, name: toolName, arguments: args }],
				},
				tool: {
					role: "tool" as const,
					content: result,
					toolCallId: id,
				},
			};
		}

		it("should keep all tool results when under retention window", () => {
			const ctx = new ContextManager({
				llmClient: mockLLM,
				promptLoader: mockPromptLoader,
				toolResultRetention: 5,
			});

			// Add 3 tool rounds (under retention of 5)
			for (let i = 0; i < 3; i++) {
				const round = buildToolRound(`tc_${i}`, "exec_command", { command: "ls" }, `file${i}.ts`);
				ctx.addMessage(round.assistant);
				ctx.addMessage(round.tool);
			}

			const prepared = ctx.prepareForLLM();
			const toolMsgs = prepared.messages.filter((m) => m.role === "tool");

			expect(toolMsgs).toHaveLength(3);
			for (let i = 0; i < 3; i++) {
				expect(toolMsgs[i].content).toBe(`file${i}.ts`);
			}
		});

		it("should summarize old tool results and keep recent ones intact", () => {
			const ctx = new ContextManager({
				llmClient: mockLLM,
				promptLoader: mockPromptLoader,
				toolResultRetention: 2,
			});

			// Add 4 tool rounds (retention = 2, so first 2 get summarized)
			const rounds = [
				buildToolRound("tc_0", "create_agent", { agent_name: "test" }, 'Agent "cliclaw-test" created in /tmp'),
				buildToolRound("tc_1", "send_to_agent", { prompt: "do stuff" }, "[Agent completed] (Task done)\nLong output..."),
				buildToolRound("tc_2", "exec_command", { command: "ls" }, "src/ test/ package.json"),
				buildToolRound("tc_3", "respond_to_agent", { value: "y" }, "[Agent completed] (Confirmed)\nMore output"),
			];
			for (const r of rounds) {
				ctx.addMessage(r.assistant);
				ctx.addMessage(r.tool);
			}

			const prepared = ctx.prepareForLLM();
			const toolMsgs = prepared.messages.filter((m) => m.role === "tool");

			// First 2 should be summarized
			expect(toolMsgs[0].content).toBe('[create_agent → ✓] Agent "cliclaw-test" created in /tmp');
			expect(toolMsgs[1].content).toBe("[send_to_agent → ✓] [Agent completed] (Task done)");

			// Last 2 should be intact
			expect(toolMsgs[2].content).toBe("src/ test/ package.json");
			expect(toolMsgs[3].content).toBe("[Agent completed] (Confirmed)\nMore output");
		});

		it("should detect failure status from Error: prefix", () => {
			const ctx = new ContextManager({
				llmClient: mockLLM,
				promptLoader: mockPromptLoader,
				toolResultRetention: 1,
			});

			const rounds = [
				buildToolRound("tc_0", "send_to_agent", { prompt: "x" }, "Error: No active agent. Call create_agent first."),
				buildToolRound("tc_1", "exec_command", { command: "ls" }, "ok"),
			];
			for (const r of rounds) {
				ctx.addMessage(r.assistant);
				ctx.addMessage(r.tool);
			}

			const prepared = ctx.prepareForLLM();
			const toolMsgs = prepared.messages.filter((m) => m.role === "tool");
			expect(toolMsgs[0].content).toContain("send_to_agent → ✗");
		});

		it("should detect failure status from Failed prefix", () => {
			const ctx = new ContextManager({
				llmClient: mockLLM,
				promptLoader: mockPromptLoader,
				toolResultRetention: 1,
			});

			const rounds = [
				buildToolRound("tc_0", "create_agent", { agent_name: "x" }, "Failed to create agent: timeout"),
				buildToolRound("tc_1", "exec_command", { command: "ls" }, "ok"),
			];
			for (const r of rounds) {
				ctx.addMessage(r.assistant);
				ctx.addMessage(r.tool);
			}

			const prepared = ctx.prepareForLLM();
			const toolMsgs = prepared.messages.filter((m) => m.role === "tool");
			expect(toolMsgs[0].content).toContain("create_agent → ✗");
		});

		it("should detect failure status from [exit code: pattern", () => {
			const ctx = new ContextManager({
				llmClient: mockLLM,
				promptLoader: mockPromptLoader,
				toolResultRetention: 1,
			});

			const rounds = [
				buildToolRound("tc_0", "exec_command", { command: "bad" }, "[exit code: 1]\ncommand not found"),
				buildToolRound("tc_1", "exec_command", { command: "ls" }, "ok"),
			];
			for (const r of rounds) {
				ctx.addMessage(r.assistant);
				ctx.addMessage(r.tool);
			}

			const prepared = ctx.prepareForLLM();
			const toolMsgs = prepared.messages.filter((m) => m.role === "tool");
			expect(toolMsgs[0].content).toContain("exec_command → ✗");
		});

		it("should truncate tool_call arguments for compacted results", () => {
			const ctx = new ContextManager({
				llmClient: mockLLM,
				promptLoader: mockPromptLoader,
				toolResultRetention: 1,
			});

			const longPrompt = "x".repeat(500);
			const rounds = [
				buildToolRound("tc_0", "send_to_agent", { prompt: longPrompt }, "[Agent completed] (Done)\noutput"),
				buildToolRound("tc_1", "exec_command", { command: "ls" }, "ok"),
			];
			for (const r of rounds) {
				ctx.addMessage(r.assistant);
				ctx.addMessage(r.tool);
			}

			const prepared = ctx.prepareForLLM();
			const assistantMsg = prepared.messages.find(
				(m) => m.role === "assistant" && Array.isArray(m.content) && m.content.some((b: any) => b.id === "tc_0"),
			);
			const toolCallBlock = (assistantMsg!.content as any[]).find((b: any) => b.id === "tc_0");
			expect(toolCallBlock.arguments.prompt.length).toBeLessThanOrEqual(203); // 200 + "..."
			expect(toolCallBlock.arguments.prompt).toContain("...");
		});

		it("should not truncate short tool_call arguments", () => {
			const ctx = new ContextManager({
				llmClient: mockLLM,
				promptLoader: mockPromptLoader,
				toolResultRetention: 1,
			});

			const rounds = [
				buildToolRound("tc_0", "respond_to_agent", { value: "y" }, "[Agent completed] (Done)"),
				buildToolRound("tc_1", "exec_command", { command: "ls" }, "ok"),
			];
			for (const r of rounds) {
				ctx.addMessage(r.assistant);
				ctx.addMessage(r.tool);
			}

			const prepared = ctx.prepareForLLM();
			const assistantMsg = prepared.messages.find(
				(m) => m.role === "assistant" && Array.isArray(m.content) && m.content.some((b: any) => b.id === "tc_0"),
			);
			const toolCallBlock = (assistantMsg!.content as any[]).find((b: any) => b.id === "tc_0");
			expect(toolCallBlock.arguments.value).toBe("y");
		});

		it("should return 'unknown' when toolCallId has no matching tool_call", () => {
			const ctx = new ContextManager({
				llmClient: mockLLM,
				promptLoader: mockPromptLoader,
				toolResultRetention: 1,
			});

			// Add a tool result without a preceding assistant tool_call
			ctx.addMessage({ role: "tool", content: "orphan result", toolCallId: "nonexistent" });
			ctx.addMessage({
				role: "assistant",
				content: [{ type: "tool_call", id: "tc_1", name: "exec_command", arguments: { command: "ls" } }],
			});
			ctx.addMessage({ role: "tool", content: "ok", toolCallId: "tc_1" });

			const prepared = ctx.prepareForLLM();
			const toolMsgs = prepared.messages.filter((m) => m.role === "tool");
			expect(toolMsgs[0].content).toContain("unknown → ✓");
		});

		it("should not re-compact already-summarized results in Step 2 budget overflow", () => {
			const ctx = new ContextManager({
				llmClient: mockLLM,
				promptLoader: mockPromptLoader,
				contextWindowLimit: 500, // Very small to trigger budget overflow
				toolResultRetention: 1,
				flushThreshold: 0.3,
			});

			// Add 3 tool rounds — first 2 get summarized by Step 0
			const rounds = [
				buildToolRound("tc_0", "exec_command", { command: "ls" }, "file1.ts\nfile2.ts"),
				buildToolRound("tc_1", "send_to_agent", { prompt: "do" }, "[Agent completed] (Done)\n" + "x".repeat(2000)),
				buildToolRound("tc_2", "exec_command", { command: "pwd" }, "/home/user/project"),
			];
			for (const r of rounds) {
				ctx.addMessage(r.assistant);
				ctx.addMessage(r.tool);
			}

			const prepared = ctx.prepareForLLM();
			const toolMsgs = prepared.messages.filter((m) => m.role === "tool");

			// First 2 should be summarized by Step 0 (start with "[")
			expect(toolMsgs[0].content).toMatch(/^\[exec_command/);
			expect(toolMsgs[1].content).toMatch(/^\[send_to_agent/);

			// They should NOT be replaced by COMPACTED_PLACEHOLDER
			expect(toolMsgs[0].content).not.toContain("compacted");
			expect(toolMsgs[1].content).not.toContain("compacted");
		});
	});

	describe("hybrid token counting", () => {
		it("should accumulate pending chars from addMessage", () => {
			contextManager.addMessage({ role: "user", content: "hello" }); // 5 chars
			contextManager.addMessage({ role: "assistant", content: "world" }); // 5 chars

			// getCurrentTokenEstimate: lastKnownTokenCount(0) + ceil(10/4) = 3
			const estimate = contextManager.getCurrentTokenEstimate();
			expect(estimate).toBe(3); // ceil(10/4)
		});

		it("should reset pending chars on reportUsage", () => {
			contextManager.addMessage({ role: "user", content: "hello" });

			contextManager.reportUsage({ inputTokens: 50, outputTokens: 20 });

			// After report: lastKnown = 70, pending = 0
			expect(contextManager.getCurrentTokenEstimate()).toBe(70);
		});

		it("should combine lastKnown + pending estimate", () => {
			contextManager.reportUsage({ inputTokens: 100, outputTokens: 50 });
			// lastKnown = 150, pending = 0

			contextManager.addMessage({ role: "user", content: "x".repeat(40) });
			// pending = 40, pendingTokens = ceil(40/4) = 10

			expect(contextManager.getCurrentTokenEstimate()).toBe(160); // 150 + 10
		});

		it("should use hybrid counting in shouldCompress when usage reported", () => {
			const smallCtx = new ContextManager({
				llmClient: mockLLM,
				promptLoader: mockPromptLoader,
				contextWindowLimit: 200, // threshold at 0.7 = 140 tokens
				flushThreshold: 0.3,
			});

			// Report 150 tokens — exceeds 140 threshold
			smallCtx.reportUsage({ inputTokens: 100, outputTokens: 50 });

			expect(smallCtx.shouldCompress()).toBe(true);
		});

		it("should fall back to char estimation when no usage reported", () => {
			const smallCtx = new ContextManager({
				llmClient: mockLLM,
				promptLoader: mockPromptLoader,
				contextWindowLimit: 1000,
				compressionThreshold: 0.5,
				flushThreshold: 0.3,
			});

			// No reportUsage called — falls back to estimateTokens
			smallCtx.addMessage({ role: "user", content: "x".repeat(2100) });
			expect(smallCtx.shouldCompress()).toBe(true);
		});
	});

	describe("memory flush trigger logic", () => {
		it("should not trigger flush when no memoryStore", () => {
			// Default contextManager has no memoryStore
			expect(contextManager.shouldRunMemoryFlush()).toBe(false);
		});

		it("should not trigger flush when under threshold", () => {
			const ctx = new ContextManager({
				llmClient: mockLLM,
				promptLoader: mockPromptLoader,
				contextWindowLimit: 1000,
				flushThreshold: 0.3,
				memoryStore: { write: vi.fn(), close: vi.fn() } as any,
			});

			// Token estimate is 0 — well under 300 (1000 * 0.3)
			expect(ctx.shouldRunMemoryFlush()).toBe(false);
		});

		it("should trigger flush when above threshold with memoryStore", () => {
			const ctx = new ContextManager({
				llmClient: mockLLM,
				promptLoader: mockPromptLoader,
				contextWindowLimit: 200,
				flushThreshold: 0.3, // 200 * 0.3 = 60 tokens
				memoryStore: { write: vi.fn(), close: vi.fn() } as any,
			});

			// Report 70 tokens — exceeds 60 threshold
			ctx.reportUsage({ inputTokens: 50, outputTokens: 20 });

			expect(ctx.shouldRunMemoryFlush()).toBe(true);
		});

		it("should not trigger flush twice in same compaction cycle", async () => {
			const mockStore = { write: vi.fn(), close: vi.fn() } as any;
			const mockLLMWithToolCalls = {
				...mockLLM,
				complete: vi.fn().mockResolvedValue({
					content: "flushed",
					contentBlocks: [{ type: "text", text: "flushed" }],
				}),
			};

			const ctx = new ContextManager({
				llmClient: mockLLMWithToolCalls,
				promptLoader: mockPromptLoader,
				contextWindowLimit: 200,
				flushThreshold: 0.3,
				memoryStore: mockStore,
			});

			ctx.reportUsage({ inputTokens: 50, outputTokens: 20 }); // > 60

			expect(ctx.shouldRunMemoryFlush()).toBe(true);

			// Simulate running flush (updates lastFlushCompactionCount)
			await ctx.runMemoryFlush();

			// Should not trigger again in same cycle
			expect(ctx.shouldRunMemoryFlush()).toBe(false);
		});

		it("should re-enable flush after compaction", async () => {
			const mockStore = { write: vi.fn(), close: vi.fn() } as any;
			const ctx = new ContextManager({
				llmClient: mockLLM,
				promptLoader: mockPromptLoader,
				contextWindowLimit: 200,
				flushThreshold: 0.3,
				memoryStore: mockStore,
			});

			ctx.reportUsage({ inputTokens: 50, outputTokens: 20 });
			expect(ctx.shouldRunMemoryFlush()).toBe(true);

			// Simulate flush
			await ctx.runMemoryFlush();
			expect(ctx.shouldRunMemoryFlush()).toBe(false);

			// Now compress (increments compactionCount)
			ctx.addMessage({ role: "user", content: "test" });
			await ctx.compress();

			// After compaction, token counts reset, so need to report usage again
			ctx.reportUsage({ inputTokens: 50, outputTokens: 20 });

			// Flush should be re-enabled (new compaction cycle)
			expect(ctx.shouldRunMemoryFlush()).toBe(true);
		});

		it("should trigger sync after flush writes memory", async () => {
			const mockStore = { write: vi.fn().mockResolvedValue(undefined), close: vi.fn() } as any;
			const syncMemory = vi.fn().mockResolvedValue(undefined);
			const mockLLMWithToolCalls = {
				...mockLLM,
				complete: vi.fn().mockResolvedValue({
					content: "flushed",
					contentBlocks: [
						{
							type: "tool_call",
							id: "flush-1",
							name: "memory_write",
							arguments: { path: "memory/core.md", content: "- persisted memory" },
						},
					],
				}),
			};

			const ctx = new ContextManager({
				llmClient: mockLLMWithToolCalls,
				promptLoader: mockPromptLoader,
				contextWindowLimit: 200,
				flushThreshold: 0.3,
				memoryStore: mockStore,
				syncMemory,
			});

			ctx.addMessage({ role: "user", content: "remember this" });
			await ctx.runMemoryFlush();

			expect(mockStore.write).toHaveBeenCalledWith({
				path: "memory/core.md",
				content: "- persisted memory",
			});
			expect(syncMemory).toHaveBeenCalledOnce();
		});
	});

	describe("threshold invariant", () => {
		it("should throw if flushThreshold >= compressionThreshold", () => {
			expect(() => {
				new ContextManager({
					llmClient: mockLLM,
					promptLoader: mockPromptLoader,
					flushThreshold: 0.8,
					compressionThreshold: 0.7,
				});
			}).toThrow("flushThreshold (0.8) must be less than compressionThreshold (0.7)");
		});

		it("should throw if flushThreshold equals compressionThreshold", () => {
			expect(() => {
				new ContextManager({
					llmClient: mockLLM,
					promptLoader: mockPromptLoader,
					flushThreshold: 0.7,
					compressionThreshold: 0.7,
				});
			}).toThrow("flushThreshold (0.7) must be less than compressionThreshold (0.7)");
		});

		it("should accept valid flush < compress thresholds", () => {
			expect(() => {
				new ContextManager({
					llmClient: mockLLM,
					promptLoader: mockPromptLoader,
					flushThreshold: 0.5,
					compressionThreshold: 0.7,
				});
			}).not.toThrow();
		});
	});
});
