import { describe, expect, it } from "vitest";
import { PromptTracker } from "../../src/core/prompt-tracker.js";

describe("PromptTracker", () => {
	it("records prompts per sessionId in order", () => {
		const t = new PromptTracker();
		t.record("s1", "first");
		t.record("s1", "second");
		t.record("s2", "other");
		expect(t.getFor("s1")).toEqual(["first", "second"]);
		expect(t.getFor("s2")).toEqual(["other"]);
		expect(t.getFor("unknown")).toEqual([]);
	});

	it("release clears a session", () => {
		const t = new PromptTracker();
		t.record("s1", "a");
		t.release("s1");
		expect(t.getFor("s1")).toEqual([]);
	});
});
