import { describe, expect, it } from "vitest";
import { ClaudeCodeAdapter } from "../../src/agents/claude-code.js";
import { StateDetector } from "../../src/tmux/state-detector.js";

// Regression: a genuinely-busy Claude Code pane must classify as "active",
// not "completed", even when the persistent `❯` input prompt is in view.
// The earlier activePatterns set only knew the braille spinner + 4 capitalized
// verbs, so modern "✻ Pondering… (esc to interrupt)" working states fell through
// to the over-broad completion pattern /❯\s*$/m → false "completed".
describe("ClaudeCodeAdapter activePatterns — busy detection", () => {
	const characteristics = new ClaudeCodeAdapter().getCharacteristics();
	// quickPatternCheck is pure (no bridge/LLM); minimal stubs are fine.
	const detector = new StateDetector(
		{} as any,
		{} as any,
		{ pollIntervalMs: 0, stableThresholdMs: 0, captureLines: 50 },
		{} as any,
	);

	const busyPanes: Array<[string, string]> = [
		[
			"working verb + ellipsis + 'esc to interrupt' (star glyph present but NOT relied on)",
			"✻ Pondering… (esc to interrupt · 12s · ↑ 1.2k tokens)\nsome output\n❯ ",
		],
		[
			"'esc to interrupt' with sparkle glyph above idle-looking prompt",
			"✢ Channelling… (esc to interrupt · 8s)\nworking on it\n❯ ",
		],
		["no glyph, but 'esc to interrupt' present", "Frobnicating the widgets (esc to interrupt · 3s)\n❯ "],
		["whimsical verb + ellipsis before status paren", "Vibing… (15s)\n❯ "],
		["legacy braille spinner still works", "⠹ Processing\n❯ "],
	];

	for (const [label, pane] of busyPanes) {
		it(`classifies busy as active (not completed): ${label}`, () => {
			const result = detector.quickPatternCheck(pane, characteristics);
			expect(result?.status).toBe("active");
		});
	}

	it("still classifies a genuinely idle pane as completed", () => {
		const result = detector.quickPatternCheck("All tests passed!\nDone.\n❯ ", characteristics);
		expect(result?.status).toBe("completed");
	});

	it("does not false-trigger active on a plain idle prompt with no busy markers", () => {
		// A bare summary ending in ellipsis must NOT read as busy (the active
		// ellipsis rule is anchored to "… (" status-line shape, not any "…").
		const result = detector.quickPatternCheck("Summary: refactored the parser…\n❯ ", characteristics);
		expect(result?.status).toBe("completed");
	});

	// Regression for the reverse bug: the COMPLETED summary line "✻ Churned for 1m 9s"
	// reuses the same star glyph as the busy "✻ Pondering…" line. Matching the bare
	// glyph would mark a finished agent as "active" → never settles → 30-min timeout.
	// Must classify as completed (no ellipsis, no "esc to interrupt" → only ❯ matches).
	it("classifies the '✻ Churned for …' done-summary as completed, not active", () => {
		const pane =
			"✻ Churned for 1m 9s\n" +
			"\n" +
			"────────────────────────────────────────\n" +
			"❯ \n" +
			"────────────────────────────────────────\n" +
			"  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents";
		const result = detector.quickPatternCheck(pane, characteristics);
		expect(result?.status).toBe("completed");
	});
});
