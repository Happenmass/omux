import { describe, it, expect } from "vitest";
import { PromptLoader } from "../../src/llm/prompt-loader.js";

describe("auto-continue gate prompt", () => {
	it("loads and interpolates last_output / agent_status / language_instruction", async () => {
		const loader = new PromptLoader();
		await loader.load();
		const out = loader.resolve("auto-continue", {
			language_instruction: "LANG_SENTINEL",
			last_output: "OUTPUT_SENTINEL",
			agent_status: "STATUS_SENTINEL",
		});
		expect(out).toContain("OUTPUT_SENTINEL");
		expect(out).toContain("STATUS_SENTINEL");
		expect(out).toContain("LANG_SENTINEL");
		expect(out).toContain("driverText");
	});
});
