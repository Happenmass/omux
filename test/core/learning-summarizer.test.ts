import { describe, expect, it, vi } from "vitest";
import { LearningSummarizer } from "../../src/core/learning-summarizer.js";

function mockLlm(responses: string[]) {
	const calls: any[] = [];
	let i = 0;
	const stream = async function* () {
		/* unused here */
	};
	return {
		calls,
		complete: vi.fn(async (_messages: any, opts: any) => {
			calls.push({ messages: _messages, opts });
			const content = responses[Math.min(i++, responses.length - 1)];
			return {
				content,
				contentBlocks: [],
				usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
				stopReason: "end_turn",
				model: "x",
			};
		}),
		stream,
	};
}

function mockPromptLoader() {
	return { resolve: vi.fn((_n: string, ctx: any) => `RENDERED\n${JSON.stringify(ctx)}`) };
}

const validJson = JSON.stringify({
	title: "Refactor X",
	what_changed: "changed",
	why: "because",
	key_files: [{ path: "a.ts", role: "core" }],
	design_points: ["p1"],
	learning_hooks: ["h1"],
});

describe("LearningSummarizer", () => {
	it("returns parsed SummaryJson on first success", async () => {
		const llm = mockLlm([validJson]);
		const pl = mockPromptLoader();
		const s = new LearningSummarizer(llm as any, pl as any);
		const out = await s.generate({
			agentPrompts: ["do thing"],
			diffForLLM: "diff",
			filesList: [{ path: "a.ts", status: "modified" }],
			mode: "agent",
		});
		expect(out.title).toBe("Refactor X");
		expect(llm.complete).toHaveBeenCalledTimes(1);
	});

	it("retries once on parse failure then succeeds", async () => {
		const llm = mockLlm(["not json", validJson]);
		const s = new LearningSummarizer(llm as any, mockPromptLoader() as any);
		const out = await s.generate({ agentPrompts: [], diffForLLM: "", filesList: [], mode: "agent" });
		expect(out.title).toBe("Refactor X");
		expect(llm.complete).toHaveBeenCalledTimes(2);
	});

	it("falls back to skeleton after two parse failures", async () => {
		const llm = mockLlm(["bad", "still bad"]);
		const s = new LearningSummarizer(llm as any, mockPromptLoader() as any);
		const out = await s.generate({
			agentPrompts: [],
			diffForLLM: "",
			filesList: [{ path: "x.ts", status: "modified" }],
			mode: "agent",
		});
		expect(out.title).toBe("Untitled (LLM error)");
		expect(out.key_files).toEqual([{ path: "x.ts", role: "" }]);
	});

	it("strips markdown fences from LLM output", async () => {
		const fenced = `\`\`\`json\n${validJson}\n\`\`\``;
		const llm = mockLlm([fenced]);
		const s = new LearningSummarizer(llm as any, mockPromptLoader() as any);
		const out = await s.generate({ agentPrompts: [], diffForLLM: "", filesList: [], mode: "agent" });
		expect(out.title).toBe("Refactor X");
	});

	it("truncates diff over 2000 lines to per-file digest", async () => {
		const llm = mockLlm([validJson]);
		const pl = mockPromptLoader();
		const s = new LearningSummarizer(llm as any, pl as any);
		const bigDiff = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join("\n");
		await s.generate({ agentPrompts: [], diffForLLM: bigDiff, filesList: [], mode: "agent" });
		const ctx = pl.resolve.mock.calls[0][1];
		const diffLen = (ctx.diff as string).split("\n").length;
		expect(diffLen).toBeLessThan(3000);
	});
});
