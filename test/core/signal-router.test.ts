import { describe, it, expect, beforeEach, vi } from "vitest";
import { SignalRouter } from "../../src/core/signal-router.js";
import type { Signal } from "../../src/core/signal-router.js";
import type { PaneAnalysis } from "../../src/tmux/state-detector.js";

function createMockStateDetector() {
	let callback: ((analysis: PaneAnalysis, content: string) => void) | null = null;
	return {
		onStateChange: vi.fn((cb: any) => {
			callback = cb;
			return () => {
				callback = null;
			};
		}),
		startMonitoring: vi.fn(),
		stopMonitoring: vi.fn(),
		// Helper to simulate signals in tests
		_emit: (analysis: PaneAnalysis, content: string) => {
			callback?.(analysis, content);
		},
	};
}

function createMockBridge() {
	return {
		capturePane: vi.fn().mockResolvedValue({ content: "pane content", lines: 50, timestamp: Date.now() }),
	} as any;
}

function createMockContextManager() {
	return {
		addMessage: vi.fn(),
		getMessages: vi.fn().mockReturnValue([]),
	} as any;
}

describe("SignalRouter", () => {
	let router: SignalRouter;
	let mockDetector: ReturnType<typeof createMockStateDetector>;
	let mockBridge: ReturnType<typeof createMockBridge>;
	let mockCtx: ReturnType<typeof createMockContextManager>;

	beforeEach(() => {
		mockDetector = createMockStateDetector();
		mockBridge = createMockBridge();
		mockCtx = createMockContextManager();
		router = new SignalRouter(mockDetector as any, mockBridge, mockCtx);
	});

	describe("signal routing", () => {
		it("should route active with high confidence to fast path (no handler call for active)", async () => {
			const handler = vi.fn();
			router.onSignal(handler);
			router.startMonitoring("test:0.0", "goal context");

			mockDetector._emit({ status: "active", confidence: 0.8, detail: "Working" }, "spinner output");

			await new Promise((r) => setTimeout(r, 10));

			// Active fast path does NOT call the signal handler
			expect(handler).not.toHaveBeenCalled();
		});

		it("should route completed to DECISION_NEEDED (let LLM decide)", async () => {
			const handler = vi.fn();
			router.onSignal(handler);
			router.startMonitoring("test:0.0", "goal context");

			mockDetector._emit({ status: "completed", confidence: 0.92, detail: "Done" }, "> ");

			await new Promise((r) => setTimeout(r, 10));

			// In goal-driven mode, all non-active states go to DECISION_NEEDED
			expect(handler).toHaveBeenCalledWith(
				expect.objectContaining({ type: "DECISION_NEEDED" }),
			);
		});

		it("should route waiting_input to DECISION_NEEDED", async () => {
			const handler = vi.fn();
			router.onSignal(handler);
			router.startMonitoring("test:0.0", "goal context");

			mockDetector._emit({ status: "waiting_input", confidence: 0.6, detail: "Waiting" }, "(y/n)");

			await new Promise((r) => setTimeout(r, 10));

			expect(handler).toHaveBeenCalledWith(
				expect.objectContaining({ type: "DECISION_NEEDED" }),
			);
		});

		it("should route error to DECISION_NEEDED", async () => {
			const handler = vi.fn();
			router.onSignal(handler);
			router.startMonitoring("test:0.0", "goal context");

			mockDetector._emit({ status: "error", confidence: 0.9, detail: "Error found" }, "Error: ...");

			await new Promise((r) => setTimeout(r, 10));

			expect(handler).toHaveBeenCalledWith(
				expect.objectContaining({ type: "DECISION_NEEDED" }),
			);
		});

		it("should route idle to DECISION_NEEDED", async () => {
			const handler = vi.fn();
			router.onSignal(handler);
			router.startMonitoring("test:0.0", "goal context");

			mockDetector._emit({ status: "idle", confidence: 0.5, detail: "Idle" }, "> ");

			await new Promise((r) => setTimeout(r, 10));

			expect(handler).toHaveBeenCalledWith(
				expect.objectContaining({ type: "DECISION_NEEDED" }),
			);
		});
	});

	describe("execution control", () => {
		it("should track stop requested state", () => {
			expect(router.isStopRequested()).toBe(false);
			router.stop();
			expect(router.isStopRequested()).toBe(true);
			router.resume();
			expect(router.isStopRequested()).toBe(false);
		});

		it("should emit log events on stop/resume", () => {
			const logSpy = vi.fn();
			router.on("log", logSpy);

			router.stop();
			expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Stop requested"));

			router.resume();
			expect(logSpy).toHaveBeenCalledWith("Execution resumed");
		});
	});

	describe("adaptive capture", () => {
		it("should return default lines normally", () => {
			expect(router.getCaptureLines()).toBe(50);
		});

		it("should expand lines when pane contains spec keywords", () => {
			expect(router.getCaptureLines("reading proposal.md")).toBe(300);
			expect(router.getCaptureLines("editing design.md")).toBe(300);
		});

		it("should not expand for ordinary pane content", () => {
			expect(router.getCaptureLines("implementing the login page")).toBe(50);
		});
	});

	describe("stop monitoring", () => {
		it("should unsubscribe and stop detector", () => {
			router.startMonitoring("test:0.0", "ctx");
			router.stopMonitoring();

			expect(mockDetector.stopMonitoring).toHaveBeenCalled();
		});
	});
});
