import type { LLMClient } from "../llm/client.js";
import type { PromptLoader } from "../llm/prompt-loader.js";
import type { DiffFileEntry, SummaryJson } from "./learning-types.js";

export interface SummarizerInput {
	agentPrompts: string[];
	diffForLLM: string;
	filesList: DiffFileEntry[];
	mode: "agent" | "merged";
}

const DIFF_LINE_LIMIT = 2000;
const PER_FILE_HEAD_LINES = 50;

export class LearningSummarizer {
	constructor(
		private llm: LLMClient,
		private prompts: PromptLoader,
	) {}

	async generate(input: SummarizerInput): Promise<SummaryJson> {
		const prompt = this.prompts.resolve("learning-summary", {
			mode: input.mode,
			agent_prompts: input.agentPrompts.map((p, i) => `[${i + 1}] ${p}`).join("\n\n"),
			files_list: input.filesList.map((f) => `- ${f.status.toUpperCase()}  ${f.path}`).join("\n"),
			diff: this.truncateDiff(input.diffForLLM),
		});
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				const res = await this.llm.complete([{ role: "user", content: prompt }], {
					responseFormat: "json",
					temperature: 0.2,
				});
				return this.parseSummary(res.content);
			} catch {
				/* retry */
			}
		}
		return this.skeleton(input);
	}

	private truncateDiff(diff: string): string {
		const lines = diff.split("\n");
		if (lines.length <= DIFF_LINE_LIMIT) return diff;
		const digest: string[] = [];
		let keep = 0;
		let inFile = false;
		for (const line of lines) {
			if (line.startsWith("diff --git ")) {
				digest.push(line);
				inFile = true;
				keep = 0;
				continue;
			}
			if (inFile && keep < PER_FILE_HEAD_LINES) {
				digest.push(line);
				keep++;
			}
		}
		// If diff didn't have `diff --git` lines (e.g. plain text), fall back to first N lines.
		if (digest.length === 0) {
			return `${lines.slice(0, DIFF_LINE_LIMIT).join("\n")}\n[... truncated ...]`;
		}
		return `${digest.join("\n")}\n[... truncated ...]`;
	}

	private parseSummary(text: string): SummaryJson {
		const stripped = text
			.replace(/^```(?:json)?\s*/, "")
			.replace(/\s*```\s*$/, "")
			.trim();
		const parsed = JSON.parse(stripped);
		if (typeof parsed.title !== "string" || typeof parsed.what_changed !== "string") {
			throw new Error("missing required fields");
		}
		return {
			title: parsed.title,
			what_changed: parsed.what_changed,
			why: parsed.why ?? "",
			key_files: Array.isArray(parsed.key_files) ? parsed.key_files : [],
			design_points: Array.isArray(parsed.design_points) ? parsed.design_points : [],
			learning_hooks: Array.isArray(parsed.learning_hooks) ? parsed.learning_hooks : [],
		};
	}

	private skeleton(input: SummarizerInput): SummaryJson {
		return {
			title: "Untitled (LLM error)",
			what_changed: `LLM summary unavailable. ${input.filesList.length} files changed.`,
			why: "",
			key_files: input.filesList.map((f) => ({ path: f.path, role: "" })),
			design_points: [],
			learning_hooks: [],
		};
	}
}
