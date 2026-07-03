import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentCharacteristics } from "../../src/agents/adapter.js";
import type { LLMClient } from "../../src/llm/client.js";
import type { PromptLoader } from "../../src/llm/prompt-loader.js";
import type { TmuxBridge } from "../../src/tmux/bridge.js";
import { StateDetector } from "../../src/tmux/state-detector.js";

function hash(content: string): string {
	return createHash("md5").update(content).digest("hex");
}

function createMockBridge(initialContent = "> "): {
	bridge: TmuxBridge;
	setContent: (c: string) => void;
	failNext: (times: number) => void;
} {
	let content = initialContent;
	let failuresRemaining = 0;
	const bridge = {
		capturePane: vi.fn(async () => {
			if (failuresRemaining > 0) {
				failuresRemaining--;
				throw new Error("tmux session not found");
			}
			return {
				content,
				lines: content.split("\n"),
				timestamp: Date.now(),
			};
		}),
	} as any;
	return {
		bridge,
		setContent: (c: string) => {
			content = c;
		},
		// Make the next `times` capturePane() calls throw (simulates an unreachable pane).
		failNext: (times: number) => {
			failuresRemaining = times;
		},
	};
}

function createMockLLM(): LLMClient {
	return {
		completeJson: vi.fn().mockResolvedValue({
			status: "completed",
			confidence: 0.9,
			detail: "Task completed",
		}),
	} as any;
}

function createMockPromptLoader(): PromptLoader {
	return {
		resolve: vi.fn().mockReturnValue("system prompt"),
	} as any;
}

const characteristics: AgentCharacteristics = {
	waitingPatterns: [/\(y\/n\)/i, /\bAllow\b.*\?/i, /❯\s*\d+[.)]\s/],
	completionPatterns: [/❯\s*$/m],
	errorPatterns: [/^\s*Error:/m],
	activePatterns: [/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/],
};

describe("StateDetector.waitForSettled", () => {
	let llm: LLMClient;
	let promptLoader: PromptLoader;

	beforeEach(() => {
		llm = createMockLLM();
		promptLoader = createMockPromptLoader();
	});

	// Task 4.1: Phase 1 → Phase 2 normal flow — idle prompt detected as completed
	it("should complete Phase 1 → Phase 2 normal flow with idle prompt", async () => {
		const { bridge, setContent } = createMockBridge("initial content");
		const detector = new StateDetector(
			bridge,
			llm,
			{
				pollIntervalMs: 50,
				stableThresholdMs: 200,
				captureLines: 50,
			},
			promptLoader,
		);

		const preHash = hash("initial content");

		// After 100ms, agent starts producing output — with a live spinner so the
		// detector observes activity (SD-1b: completion requires prior activity).
		setTimeout(() => setContent("⠋ working on task..."), 100);
		// After 200ms, agent finishes — content shows idle prompt ❯
		setTimeout(() => setContent("All tests passed!\n❯ "), 200);

		const result = await detector.waitForSettled("test:0.0", "test task", {
			preHash,
			timeoutMs: 5000,
			characteristics,
		});

		expect(result.timedOut).toBe(false);
		// Should detect completion from ❯ idle prompt (not waiting_input)
		expect(result.analysis.status).toBe("completed");
	});

	// Task 4.2: Phase 1 timeout (hash never changes)
	it("should timeout if hash never changes (Phase 1 stuck)", async () => {
		const { bridge } = createMockBridge("static content");
		const detector = new StateDetector(
			bridge,
			llm,
			{
				pollIntervalMs: 50,
				stableThresholdMs: 200,
				captureLines: 50,
			},
			promptLoader,
		);

		const preHash = hash("static content");

		const result = await detector.waitForSettled("test:0.0", "test task", {
			preHash,
			timeoutMs: 300,
			characteristics,
		});

		expect(result.timedOut).toBe(true);
		expect(result.analysis.detail).toContain("Timeout");
	});

	// Task 4.3: error goes through the stability window (SD-1a — no fast escape).
	// A stable error with no active pattern present is reported as error.
	it("should return error after the stability window when error pattern is stable", async () => {
		const { bridge, setContent } = createMockBridge("initial content");
		const detector = new StateDetector(
			bridge,
			llm,
			{
				pollIntervalMs: 50,
				stableThresholdMs: 150,
				captureLines: 50,
			},
			promptLoader,
		);

		const preHash = hash("initial content");

		// Agent starts working
		setTimeout(() => setContent("compiling..."), 80);
		// Agent hits error and stops (no active pattern) — stable error
		setTimeout(() => setContent("Error: compilation failed"), 160);

		const result = await detector.waitForSettled("test:0.0", "test task", {
			preHash,
			timeoutMs: 10000,
			characteristics,
		});

		expect(result.timedOut).toBe(false);
		expect(result.analysis.status).toBe("error");
	});

	// SD-1a: an error string quoted mid-work (spinner still on screen) must NOT be
	// classified as a terminal error. The pane keeps changing (spinner) so the
	// error text never stabilizes, then the agent finishes at the idle prompt.
	it("should NOT return error while the agent is still actively working (quoted 'Error:')", async () => {
		const { bridge, setContent } = createMockBridge("initial content");
		const detector = new StateDetector(
			bridge,
			llm,
			{
				pollIntervalMs: 40,
				stableThresholdMs: 150,
				captureLines: 50,
			},
			promptLoader,
		);

		const preHash = hash("initial content");

		// Agent is actively working AND its transcript quotes an "Error:" line.
		// The live spinner frame changes each poll, so content is never stable, and
		// the co-present active pattern suppresses the error classification anyway.
		let frame = 0;
		const anim = setInterval(() => {
			frame++;
			const spinner = ["⠋", "⠙", "⠹", "⠸"][frame % 4];
			setContent(`${spinner} Running tests…\nError: expected 200 but got 404 (asserted in transcript)`);
		}, 45);
		// After the spinner stops, the agent lands on the idle prompt (completed).
		setTimeout(() => {
			clearInterval(anim);
			setContent("All checks passed\n❯ ");
		}, 400);

		const result = await detector.waitForSettled("test:0.0", "test task", {
			preHash,
			timeoutMs: 10000,
			characteristics,
		});

		clearInterval(anim);
		expect(result.timedOut).toBe(false);
		// Must NOT be error — the agent was busy the whole time and finished cleanly.
		expect(result.analysis.status).toBe("completed");
	});

	// Task 4.4: Phase 2 — active with high confidence resets waiting
	it("should continue waiting when active pattern detected after stability", async () => {
		const { bridge, setContent } = createMockBridge("initial content");
		const detector = new StateDetector(
			bridge,
			llm,
			{
				pollIntervalMs: 50,
				stableThresholdMs: 150,
				captureLines: 50,
			},
			promptLoader,
		);

		const preHash = hash("initial content");

		// Phase 1→2: content changes
		setTimeout(() => setContent("⠋ Processing step 1..."), 80);
		// Content becomes "stable" with active spinner — should reset and continue
		// After more waiting, content changes to final state (idle prompt)
		setTimeout(() => setContent("Done\n❯ "), 400);

		const result = await detector.waitForSettled("test:0.0", "test task", {
			preHash,
			timeoutMs: 5000,
			characteristics,
		});

		expect(result.timedOut).toBe(false);
		expect(result.analysis.status).toBe("completed");
	});

	// Task 4.5: Abort mid-wait
	it("should return immediately when aborted", async () => {
		const { bridge, setContent } = createMockBridge("initial content");
		const detector = new StateDetector(
			bridge,
			llm,
			{
				pollIntervalMs: 50,
				stableThresholdMs: 2000,
				captureLines: 50,
			},
			promptLoader,
		);

		const preHash = hash("initial content");
		let aborted = false;

		// Content changes so we enter Phase 2
		setTimeout(() => setContent("working..."), 80);
		// Abort after 200ms
		setTimeout(() => {
			aborted = true;
		}, 200);

		const startTime = Date.now();
		const result = await detector.waitForSettled("test:0.0", "test task", {
			preHash,
			timeoutMs: 10000,
			isAborted: () => aborted,
			characteristics,
		});
		const elapsed = Date.now() - startTime;

		expect(result.timedOut).toBe(false);
		expect(result.analysis.status).toBe("unknown");
		expect(result.analysis.detail).toBe("Aborted by user");
		expect(elapsed).toBeLessThan(1000);
	});

	// Task 4.1 supplement: captureHash helper
	it("captureHash should return md5 hash of pane content", async () => {
		const { bridge } = createMockBridge("test content");
		const detector = new StateDetector(
			bridge,
			llm,
			{
				pollIntervalMs: 100,
				stableThresholdMs: 2000,
				captureLines: 50,
			},
			promptLoader,
		);

		const result = await detector.captureHash("test:0.0");
		expect(result).toBe(hash("test content"));
	});

	// waiting_input fast escape during content changes
	it("should return immediately on waiting_input pattern during Phase 2 content changes", async () => {
		const { bridge, setContent } = createMockBridge("initial content");
		const detector = new StateDetector(
			bridge,
			llm,
			{
				pollIntervalMs: 50,
				stableThresholdMs: 2000, // Long threshold — waiting_input should escape before this
				captureLines: 50,
			},
			promptLoader,
		);

		const preHash = hash("initial content");

		// Agent starts working
		setTimeout(() => setContent("compiling..."), 80);
		// Agent shows permission prompt (content changes again, hash differs)
		setTimeout(() => setContent("Do you want to proceed?\n❯ 1. Yes\n  2. No"), 160);

		const startTime = Date.now();
		const result = await detector.waitForSettled("test:0.0", "test task", {
			preHash,
			timeoutMs: 10000,
			characteristics,
		});
		const elapsed = Date.now() - startTime;

		expect(result.timedOut).toBe(false);
		expect(result.analysis.status).toBe("waiting_input");
		// Should return much faster than stableThresholdMs (2000ms)
		expect(elapsed).toBeLessThan(1000);
	});

	// Animation and numbered option menu coexist
	it("should detect waiting_input even when animation causes continuous hash changes", async () => {
		const { bridge, setContent } = createMockBridge("initial content");
		const detector = new StateDetector(
			bridge,
			llm,
			{
				pollIntervalMs: 50,
				stableThresholdMs: 2000,
				captureLines: 50,
			},
			promptLoader,
		);

		const preHash = hash("initial content");
		let animFrame = 0;

		// Simulate animation: content keeps changing (different spinner frame each poll)
		// but the permission prompt is always present at the bottom
		const animInterval = setInterval(() => {
			animFrame++;
			const spinner = ["⏺", "⏻", "⏼"][animFrame % 3];
			setContent(
				`${spinner} Searching for 1 pattern…\n` +
					`\n` +
					`Bash command\n` +
					`  find /Users/test -name "*.kt"\n` +
					`Do you want to proceed?\n` +
					`❯ 1. Yes\n` +
					`  2. Yes, allow reading\n` +
					`  3. No`,
			);
		}, 60);

		const startTime = Date.now();
		const result = await detector.waitForSettled("test:0.0", "test task", {
			preHash,
			timeoutMs: 10000,
			characteristics,
		});
		const elapsed = Date.now() - startTime;
		clearInterval(animInterval);

		expect(result.timedOut).toBe(false);
		expect(result.analysis.status).toBe("waiting_input");
		// Should detect quickly despite continuous animation
		expect(elapsed).toBeLessThan(1000);
	});

	// Core bug fix: idle prompt after output must be "completed", not "waiting_input"
	it("should detect completed (not waiting_input) when agent returns to ❯ prompt after work", async () => {
		const { bridge, setContent } = createMockBridge("initial content");
		const detector = new StateDetector(
			bridge,
			llm,
			{
				pollIntervalMs: 50,
				stableThresholdMs: 200, // short for test speed
				captureLines: 50,
			},
			promptLoader,
		);

		const preHash = hash("initial content");

		// Agent works (with a spinner so activity is observed — SD-1b), then returns
		// to idle prompt — this is the exact scenario that previously caused false
		// waiting_input due to /\?.*:?\s*$/m matching any line with a "?" in output.
		setTimeout(() => setContent("⠋ Running tests...\n核心流程全部测试通过！"), 80);
		setTimeout(() => setContent("Running tests...\n核心流程全部测试通过！\nWhat files were changed?\n❯ "), 200);

		const result = await detector.waitForSettled("test:0.0", "test task", {
			preHash,
			timeoutMs: 10000,
			characteristics,
		});

		expect(result.timedOut).toBe(false);
		// Must be "completed" — the ❯ idle prompt means the agent is done
		expect(result.analysis.status).toBe("completed");
		// completed now waits for stableThresholdMs before reporting (no fast escape),
		// so we only assert correctness, not timing
	});

	// SD-1b: a slow silent start where the prompt echo satisfied Phase 1 but the
	// agent never actually ran. The idle glyph is present but no activity was ever
	// observed. Layer 2 (mock → "completed") acts as the tiebreaker; the key is
	// that the pattern path does NOT short-circuit to "completed" prematurely.
	it("should defer to Layer 2 when idle glyph appears but no activity was ever seen", async () => {
		const { bridge, setContent } = createMockBridge("initial content");
		const detector = new StateDetector(
			bridge,
			llm,
			{
				pollIntervalMs: 30,
				stableThresholdMs: 100,
				captureLines: 50,
			},
			promptLoader,
		);

		const preHash = hash("initial content");

		// Phase 1 is satisfied by the prompt's own echo — idle glyph, no spinner,
		// no active output. The agent never actually produced work.
		setTimeout(() => setContent("run the build\n❯ "), 60);

		const result = await detector.waitForSettled("test:0.0", "test task", {
			preHash,
			timeoutMs: 5000,
			characteristics,
		});

		expect(result.timedOut).toBe(false);
		// With no observed activity, the pattern-based "completed" is not trusted at
		// the base stable threshold — Layer 2 is consulted as the tiebreaker.
		expect((llm.completeJson as any).mock.calls.length).toBeGreaterThan(0);
		// Layer 2 mock returns "completed".
		expect(result.analysis.status).toBe("completed");
	});

	// SD-1b: when activity WAS observed, the idle glyph is trusted at the base
	// stability threshold without needing Layer 2.
	it("should trust the idle glyph as completed at the base threshold once activity was seen", async () => {
		const { bridge, setContent } = createMockBridge("initial content");
		const detector = new StateDetector(
			bridge,
			llm,
			{
				pollIntervalMs: 30,
				stableThresholdMs: 100,
				captureLines: 50,
			},
			promptLoader,
		);

		const preHash = hash("initial content");

		// Agent visibly works (spinner) then lands on the idle prompt.
		setTimeout(() => setContent("⠋ compiling…"), 50);
		setTimeout(() => setContent("build succeeded\n❯ "), 130);

		const result = await detector.waitForSettled("test:0.0", "test task", {
			preHash,
			timeoutMs: 5000,
			characteristics,
		});

		expect(result.timedOut).toBe(false);
		expect(result.analysis.status).toBe("completed");
		// Pattern path handled it — no Layer 2 needed because activity was observed.
		expect((llm.completeJson as any).mock.calls.length).toBe(0);
	});

	// Verify that "?" in output does NOT trigger false waiting_input
	it("should not misdetect waiting_input from question marks in output text", async () => {
		const { bridge, setContent } = createMockBridge("initial content");
		const detector = new StateDetector(
			bridge,
			llm,
			{
				pollIntervalMs: 50,
				stableThresholdMs: 200,
				captureLines: 50,
			},
			promptLoader,
		);

		const preHash = hash("initial content");

		// Output contains "?" but agent is idle at ❯ prompt. No activity is ever
		// observed, so Layer 2 (mock → completed) is the tiebreaker.
		setTimeout(() => setContent("What is this file?\nHow does it work?\n❯ "), 80);

		const result = await detector.waitForSettled("test:0.0", "test task", {
			preHash,
			timeoutMs: 5000,
			characteristics,
		});

		expect(result.timedOut).toBe(false);
		// "?" in output must NOT cause waiting_input — ❯ means completed
		expect(result.analysis.status).toBe("completed");
	});

	// Verify Error: in log output does not false-trigger error status
	it("should not misdetect error from 'Error:' appearing mid-line in logs", async () => {
		const { bridge, setContent } = createMockBridge("initial content");
		const detector = new StateDetector(
			bridge,
			llm,
			{
				pollIntervalMs: 50,
				stableThresholdMs: 200,
				captureLines: 50,
			},
			promptLoader,
		);

		const preHash = hash("initial content");

		// "Error:" appears in log output but NOT at start of line; agent idle at ❯.
		setTimeout(() => setContent("  Caught Error: timeout in test helper (expected)\n  Tests: 5 passed\n❯ "), 80);

		const result = await detector.waitForSettled("test:0.0", "test task", {
			preHash,
			timeoutMs: 5000,
			characteristics,
		});

		expect(result.timedOut).toBe(false);
		// "Caught Error:" mid-line should not trigger error — ❯ means completed
		expect(result.analysis.status).toBe("completed");
	});

	// Task 4.1 supplement: Layer 2 LLM analysis fallback
	it("should fall back to Layer 2 LLM analysis when no pattern matches", async () => {
		const { bridge, setContent } = createMockBridge("initial");
		const detector = new StateDetector(
			bridge,
			llm,
			{
				pollIntervalMs: 50,
				stableThresholdMs: 150,
				captureLines: 50,
			},
			promptLoader,
		);
		// No characteristics passed — quickPatternCheck returns null, forcing Layer 2.

		const preHash = hash("initial");

		// Content changes then stabilizes with no recognizable pattern
		setTimeout(() => setContent("some ambiguous output"), 80);

		const result = await detector.waitForSettled("test:0.0", "test task", {
			preHash,
			timeoutMs: 5000,
		});

		expect(result.timedOut).toBe(false);
		// LLM mock returns "completed"
		expect(result.analysis.status).toBe("completed");
		expect((llm.completeJson as any).mock.calls.length).toBeGreaterThan(0);
	});

	// SD-3: an unreachable pane (every capture throws) must give up after N
	// consecutive failures with status "error"/detail "pane unreachable" rather
	// than running out to the multi-hour timeout.
	it("should give up with 'pane unreachable' after consecutive capture failures", async () => {
		const { bridge, failNext } = createMockBridge("initial content");
		const detector = new StateDetector(
			bridge,
			llm,
			{
				pollIntervalMs: 20,
				stableThresholdMs: 200,
				captureLines: 50,
			},
			promptLoader,
		);

		const preHash = hash("initial content");

		// Every capture throws (session killed).
		failNext(1000);

		const startTime = Date.now();
		const result = await detector.waitForSettled("test:0.0", "test task", {
			preHash,
			// Deliberately long timeout — we must exit via the failure counter, not timeout.
			timeoutMs: 60000,
			characteristics,
		});
		const elapsed = Date.now() - startTime;

		expect(result.timedOut).toBe(false);
		expect(result.analysis.status).toBe("error");
		expect(result.analysis.detail).toContain("pane unreachable");
		// 5 failures * 20ms poll interval ≈ 100ms — nowhere near the 60s timeout.
		expect(elapsed).toBeLessThan(5000);
	});

	// SD-3: a single transient capture failure must NOT end the wait — the counter
	// resets on the next successful capture.
	it("should tolerate a transient capture failure and continue", async () => {
		const { bridge, setContent, failNext } = createMockBridge("initial content");
		const detector = new StateDetector(
			bridge,
			llm,
			{
				pollIntervalMs: 30,
				stableThresholdMs: 100,
				captureLines: 50,
			},
			promptLoader,
		);

		const preHash = hash("initial content");

		// One transient failure early, then the agent works and completes normally.
		failNext(1);
		setTimeout(() => setContent("⠋ working…"), 80);
		setTimeout(() => setContent("done\n❯ "), 200);

		const result = await detector.waitForSettled("test:0.0", "test task", {
			preHash,
			timeoutMs: 5000,
			characteristics,
		});

		expect(result.timedOut).toBe(false);
		// The single transient failure did not abort the wait — the agent completed.
		expect(result.analysis.status).toBe("completed");
	});
});
