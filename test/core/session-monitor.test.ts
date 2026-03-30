import { describe, it, expect, beforeEach, vi } from "vitest";
import { SessionMonitor } from "../../src/core/session-monitor.js";
import type { SettledEvent } from "../../src/core/session-monitor.js";
import { AgentEventQueue, type AgentEvent } from "../../src/core/agent-event-queue.js";
import type { SettledResult, PaneAnalysis } from "../../src/tmux/state-detector.js";

function createMockStateDetector() {
	let settledResolve: ((result: SettledResult) => void) | null = null;
	let settledReject: ((err: Error) => void) | null = null;

	return {
		waitForSettled: vi.fn(
			(_paneTarget: string, _taskContext: string, _opts: any) =>
				new Promise<SettledResult>((resolve, reject) => {
					settledResolve = resolve;
					settledReject = reject;
				}),
		),
		captureHash: vi.fn().mockResolvedValue("hash123"),
		// Test helpers
		_resolve: (result: SettledResult) => settledResolve?.(result),
		_reject: (err: Error) => settledReject?.(err),
	};
}

function createMockBridge() {
	return {
		capturePane: vi.fn().mockResolvedValue({ content: "pane content", lines: ["pane content"], timestamp: Date.now() }),
	} as any;
}

function createMockSignalRouter() {
	return {
		notifyPromptSent: vi.fn(),
	} as any;
}

function settledResult(status: PaneAnalysis["status"], detail = "done", timedOut = false): SettledResult {
	return {
		analysis: { status, confidence: 0.9, detail },
		content: "line1\nline2\nline3",
		timedOut,
	};
}

describe("SessionMonitor", () => {
	let monitor: SessionMonitor;
	let mockDetector: ReturnType<typeof createMockStateDetector>;
	let mockBridge: ReturnType<typeof createMockBridge>;
	let mockSignalRouter: ReturnType<typeof createMockSignalRouter>;
	let agentEventQueue: AgentEventQueue;
	let onSettled: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		mockDetector = createMockStateDetector();
		mockBridge = createMockBridge();
		mockSignalRouter = createMockSignalRouter();
		agentEventQueue = new AgentEventQueue();
		onSettled = vi.fn();

		monitor = new SessionMonitor({
			stateDetector: mockDetector as any,
			bridge: mockBridge,
			signalRouter: mockSignalRouter,
			agentEventQueue,
			onSettled,
		});
	});

	describe("constructor", () => {
		it("should create with no active tasks", () => {
			expect(monitor.getAllTasks()).toEqual([]);
			expect(monitor.isBusy("any-session")).toBe(false);
		});
	});

	describe("dispatch", () => {
		it("should return dispatched=true with TaskInfo", () => {
			const result = monitor.dispatch("session-1", "session-1:0.0", {
				preHash: "abc123",
				summary: "Fix the bug",
			});

			expect(result.dispatched).toBe(true);
			if (result.dispatched) {
				expect(result.task.taskId).toBe("task_1");
				expect(result.task.sessionId).toBe("session-1");
				expect(result.task.status).toBe("running");
				expect(result.task.summary).toBe("Fix the bug");
				expect(result.task.preHash).toBe("abc123");
				expect(result.task.startedAt).toBeGreaterThan(0);
			}
		});

		it("should mark session as busy after dispatch", () => {
			monitor.dispatch("session-1", "session-1:0.0", {
				preHash: "abc123",
				summary: "Fix the bug",
			});

			expect(monitor.isBusy("session-1")).toBe(true);
		});

		it("should support multiple sessions concurrently", () => {
			const r1 = monitor.dispatch("session-1", "session-1:0.0", {
				preHash: "hash1",
				summary: "Task 1",
			});
			const r2 = monitor.dispatch("session-2", "session-2:0.0", {
				preHash: "hash2",
				summary: "Task 2",
			});

			expect(r1.dispatched).toBe(true);
			expect(r2.dispatched).toBe(true);
			expect(monitor.getAllTasks()).toHaveLength(2);

			if (r1.dispatched && r2.dispatched) {
				expect(r1.task.taskId).toBe("task_1");
				expect(r2.task.taskId).toBe("task_2");
			}
		});

		it("should call notifyPromptSent on signalRouter", () => {
			monitor.dispatch("session-1", "session-1:0.0", {
				preHash: "abc123",
				summary: "Fix the bug",
				taskContext: "context for /opsx",
			});

			expect(mockSignalRouter.notifyPromptSent).toHaveBeenCalledWith("context for /opsx");
		});

		it("should use summary as taskContext when taskContext is not provided", () => {
			monitor.dispatch("session-1", "session-1:0.0", {
				preHash: "abc123",
				summary: "Fix the bug",
			});

			expect(mockSignalRouter.notifyPromptSent).toHaveBeenCalledWith("Fix the bug");
		});

		it("should call waitForSettled with correct arguments", () => {
			monitor.dispatch("session-1", "session-1:0.0", {
				preHash: "abc123",
				summary: "Fix the bug",
				taskContext: "Fix the critical bug in auth",
			});

			expect(mockDetector.waitForSettled).toHaveBeenCalledWith("session-1:0.0", "Fix the critical bug in auth", {
				preHash: "abc123",
				isAborted: expect.any(Function),
			});
		});
	});

	describe("dispatch when busy", () => {
		it("should return dispatched=false with BusyResult when session already has task", () => {
			monitor.dispatch("session-1", "session-1:0.0", {
				preHash: "abc123",
				summary: "First task",
			});

			const result = monitor.dispatch("session-1", "session-1:0.0", {
				preHash: "def456",
				summary: "Second task",
			});

			expect(result.dispatched).toBe(false);
			if (!result.dispatched) {
				expect(result.busy.sessionId).toBe("session-1");
				expect(result.busy.currentTask.summary).toBe("First task");
				expect(result.busy.paneContent).toBe("(session busy)");
			}
		});
	});

	describe("getTask", () => {
		it("should return task when exists", () => {
			monitor.dispatch("session-1", "session-1:0.0", {
				preHash: "abc123",
				summary: "Fix the bug",
			});

			const task = monitor.getTask("session-1");
			expect(task).not.toBeNull();
			expect(task!.taskId).toBe("task_1");
		});

		it("should return null when task does not exist", () => {
			expect(monitor.getTask("nonexistent")).toBeNull();
		});
	});

	describe("background polling — completed", () => {
		it("should enqueue AgentEvent with completed status", async () => {
			monitor.dispatch("session-1", "session-1:0.0", {
				preHash: "abc123",
				summary: "Fix the bug",
			});

			mockDetector._resolve(settledResult("completed", "Task finished successfully"));

			await vi.waitFor(() => {
				expect(agentEventQueue.size()).toBe(1);
			});

			const event = agentEventQueue.dequeue()!;
			expect(event.sessionId).toBe("session-1");
			expect(event.taskId).toBe("task_1");
			expect(event.status).toBe("completed");
			expect(event.detail).toBe("Task finished successfully");
			expect(event.summary).toBe("Fix the bug");
			expect(event.retryCount).toBe(0);
			expect(event.paneContent).toBe("pane content");

			// Task should be cleaned up
			expect(monitor.isBusy("session-1")).toBe(false);
		});
	});

	describe("background polling — error", () => {
		it("should enqueue AgentEvent with error status", async () => {
			monitor.dispatch("session-1", "session-1:0.0", {
				preHash: "abc123",
				summary: "Build project",
			});

			mockDetector._resolve(settledResult("error", "Build failed with exit code 1"));

			await vi.waitFor(() => {
				expect(agentEventQueue.size()).toBe(1);
			});

			const event = agentEventQueue.dequeue()!;
			expect(event.status).toBe("error");
			expect(event.detail).toBe("Build failed with exit code 1");

			expect(monitor.isBusy("session-1")).toBe(false);
		});
	});

	describe("background polling — timeout", () => {
		it("should enqueue AgentEvent with timeout status", async () => {
			monitor.dispatch("session-1", "session-1:0.0", {
				preHash: "abc123",
				summary: "Long running task",
			});

			mockDetector._resolve(settledResult("active", "Timeout after 1800000ms", true));

			await vi.waitFor(() => {
				expect(agentEventQueue.size()).toBe(1);
			});

			const event = agentEventQueue.dequeue()!;
			expect(event.status).toBe("timeout");
			expect(monitor.isBusy("session-1")).toBe(false);
		});
	});

	describe("background polling — waiting_input", () => {
		it("should enqueue AgentEvent with waiting_input status and keep task in Map", async () => {
			monitor.dispatch("session-1", "session-1:0.0", {
				preHash: "abc123",
				summary: "Interactive task",
			});

			mockDetector._resolve(settledResult("waiting_input", "Agent needs user input"));

			await vi.waitFor(() => {
				expect(agentEventQueue.size()).toBe(1);
			});

			const event = agentEventQueue.dequeue()!;
			expect(event.status).toBe("waiting_input");

			// Task should remain in Map with updated status
			expect(monitor.isBusy("session-1")).toBe(true);
			const task = monitor.getTask("session-1");
			expect(task!.status).toBe("waiting_input");
		});
	});

	describe("background polling — exception", () => {
		it("should enqueue AgentEvent with error status on exception", async () => {
			monitor.dispatch("session-1", "session-1:0.0", {
				preHash: "abc123",
				summary: "Crashing task",
			});

			mockDetector._reject(new Error("Connection lost"));

			await vi.waitFor(() => {
				expect(agentEventQueue.size()).toBe(1);
			});

			const event = agentEventQueue.dequeue()!;
			expect(event.status).toBe("error");
			expect(event.detail).toBe("Exception: Connection lost");
			expect(monitor.isBusy("session-1")).toBe(false);
		});
	});

	describe("background polling — emits event_available signal", () => {
		it("should emit event_available when fireCallback enqueues", async () => {
			const handler = vi.fn();
			agentEventQueue.on("event_available", handler);

			monitor.dispatch("session-1", "session-1:0.0", {
				preHash: "abc123",
				summary: "Signal test",
			});

			mockDetector._resolve(settledResult("completed", "Done"));

			await vi.waitFor(() => {
				expect(handler).toHaveBeenCalledOnce();
			});

			const event = handler.mock.calls[0][0] as AgentEvent;
			expect(event.status).toBe("completed");
			expect(event.sessionId).toBe("session-1");
		});
	});

	describe("onSettled", () => {
		it("should fire for completed status", async () => {
			monitor.dispatch("session-1", "session-1:0.0", {
				preHash: "abc123",
				summary: "Fix the bug",
			});

			mockDetector._resolve(settledResult("completed", "Done"));

			await vi.waitFor(() => {
				expect(onSettled).toHaveBeenCalledTimes(1);
			});

			const event = onSettled.mock.calls[0][0] as SettledEvent;
			expect(event.runId).toBe("task_1");
			expect(event.toolName).toBe("send_to_agent");
			expect(event.summary).toBe("Fix the bug");
			expect(event.pane).toBeDefined();
			expect(event.pane!.content).toContain("line1");
		});

		it("should fire for error status", async () => {
			monitor.dispatch("session-1", "session-1:0.0", {
				preHash: "abc123",
				summary: "Build",
			});

			mockDetector._resolve(settledResult("error", "Failed"));

			await vi.waitFor(() => {
				expect(onSettled).toHaveBeenCalledTimes(1);
			});
		});

		it("should fire for timeout", async () => {
			monitor.dispatch("session-1", "session-1:0.0", {
				preHash: "abc123",
				summary: "Slow task",
			});

			mockDetector._resolve(settledResult("active", "Timed out", true));

			await vi.waitFor(() => {
				expect(onSettled).toHaveBeenCalledTimes(1);
			});
		});

		it("should NOT fire for waiting_input", async () => {
			monitor.dispatch("session-1", "session-1:0.0", {
				preHash: "abc123",
				summary: "Interactive",
			});

			mockDetector._resolve(settledResult("waiting_input", "Need input"));

			await vi.waitFor(() => {
				expect(agentEventQueue.size()).toBe(1);
			});

			expect(onSettled).not.toHaveBeenCalled();
		});

		it("should NOT fire for aborted tasks", async () => {
			monitor.dispatch("session-1", "session-1:0.0", {
				preHash: "abc123",
				summary: "Will be aborted",
			});

			// Abort before settling
			monitor.cleanup("session-1");

			// The waitForSettled will resolve but abort check should prevent settled event
			await new Promise((r) => setTimeout(r, 50));
			expect(onSettled).not.toHaveBeenCalled();
		});

		it("should not fire when onSettled callback is not provided", async () => {
			const monitorNoSettled = new SessionMonitor({
				stateDetector: mockDetector as any,
				bridge: mockBridge,
				signalRouter: mockSignalRouter,
				agentEventQueue,
			});

			monitorNoSettled.dispatch("session-1", "session-1:0.0", {
				preHash: "abc123",
				summary: "No settled handler",
			});

			mockDetector._resolve(settledResult("completed", "Done"));

			await vi.waitFor(() => {
				expect(agentEventQueue.size()).toBe(1);
			});

			// Should not throw even without onSettled
		});
	});

	describe("pane content in AgentEvent", () => {
		it("should include captured pane content in event", async () => {
			monitor.dispatch("session-1", "session-1:0.0", {
				preHash: "abc123",
				summary: "Check pane content",
			});

			mockDetector._resolve(settledResult("completed", "Done"));

			await vi.waitFor(() => {
				expect(agentEventQueue.size()).toBe(1);
			});

			const event = agentEventQueue.dequeue()!;
			expect(event.paneContent).toBe("pane content");
			expect(mockBridge.capturePane).toHaveBeenCalled();
		});
	});

	describe("duration in AgentEvent", () => {
		it("should include durationSeconds", async () => {
			monitor.dispatch("session-1", "session-1:0.0", {
				preHash: "abc123",
				summary: "Timed task",
			});

			mockDetector._resolve(settledResult("completed", "Done"));

			await vi.waitFor(() => {
				expect(agentEventQueue.size()).toBe(1);
			});

			const event = agentEventQueue.dequeue()!;
			expect(event.durationSeconds).toBeGreaterThanOrEqual(0);
		});
	});

	describe("resumeTask", () => {
		it("should resume a waiting_input task and restart polling", async () => {
			monitor.dispatch("session-1", "session-1:0.0", {
				preHash: "abc123",
				summary: "Interactive task",
			});

			// First settle as waiting_input
			mockDetector._resolve(settledResult("waiting_input", "Need input"));

			await vi.waitFor(() => {
				expect(agentEventQueue.size()).toBe(1);
			});

			expect(monitor.getTask("session-1")!.status).toBe("waiting_input");
			agentEventQueue.dequeue(); // consume the event

			// Resume with new preHash
			const resumed = monitor.resumeTask("session-1", "newhash456");
			expect(resumed).toBe(true);
			expect(monitor.getTask("session-1")!.status).toBe("running");
			expect(monitor.getTask("session-1")!.preHash).toBe("newhash456");

			// waitForSettled should be called again
			expect(mockDetector.waitForSettled).toHaveBeenCalledTimes(2);

			// Now complete
			mockDetector._resolve(settledResult("completed", "All done"));

			await vi.waitFor(() => {
				expect(agentEventQueue.size()).toBe(1);
			});

			const event = agentEventQueue.dequeue()!;
			expect(event.status).toBe("completed");
			expect(monitor.isBusy("session-1")).toBe(false);
		});

		it("should return false for non-existent session", () => {
			expect(monitor.resumeTask("nonexistent", "hash")).toBe(false);
		});

		it("should return false for running task (not waiting_input)", () => {
			monitor.dispatch("session-1", "session-1:0.0", {
				preHash: "abc123",
				summary: "Running task",
			});

			expect(monitor.resumeTask("session-1", "newhash")).toBe(false);
		});
	});

	describe("cleanup", () => {
		it("should abort and remove task", () => {
			const result = monitor.dispatch("session-1", "session-1:0.0", {
				preHash: "abc123",
				summary: "Cleanup target",
			});

			expect(result.dispatched).toBe(true);
			if (result.dispatched) {
				const abortSpy = vi.spyOn(result.task.abortController, "abort");

				monitor.cleanup("session-1");

				expect(abortSpy).toHaveBeenCalled();
				expect(monitor.isBusy("session-1")).toBe(false);
				expect(monitor.getTask("session-1")).toBeNull();
			}
		});

		it("should be a no-op for non-existent session", () => {
			// Should not throw
			monitor.cleanup("nonexistent");
		});
	});

	describe("shutdown", () => {
		it("should abort all tasks and clear maps", () => {
			const r1 = monitor.dispatch("session-1", "session-1:0.0", {
				preHash: "hash1",
				summary: "Task 1",
			});
			const r2 = monitor.dispatch("session-2", "session-2:0.0", {
				preHash: "hash2",
				summary: "Task 2",
			});

			expect(r1.dispatched && r2.dispatched).toBe(true);
			if (r1.dispatched && r2.dispatched) {
				const abort1 = vi.spyOn(r1.task.abortController, "abort");
				const abort2 = vi.spyOn(r2.task.abortController, "abort");

				monitor.shutdown();

				expect(abort1).toHaveBeenCalled();
				expect(abort2).toHaveBeenCalled();
			}

			expect(monitor.getAllTasks()).toEqual([]);
			expect(monitor.isBusy("session-1")).toBe(false);
			expect(monitor.isBusy("session-2")).toBe(false);
		});
	});

	describe("pane snippet in settled event", () => {
		it("should include last 100 lines capped at 10000 chars", async () => {
			monitor.dispatch("session-1", "session-1:0.0", {
				preHash: "abc123",
				summary: "Pane test",
			});

			// Create content with many lines
			const lines = Array.from({ length: 150 }, (_, i) => `line ${i + 1}`);
			const content = lines.join("\n");

			mockDetector._resolve({
				analysis: { status: "completed", confidence: 0.9, detail: "Done" },
				content,
				timedOut: false,
			});

			await vi.waitFor(() => {
				expect(onSettled).toHaveBeenCalledTimes(1);
			});

			const event = onSettled.mock.calls[0][0] as SettledEvent;
			expect(event.pane).toBeDefined();
			// Should only have last 100 lines
			expect(event.pane!.lines).toBe(100);
			expect(event.pane!.content).toContain("line 51");
			expect(event.pane!.content).toContain("line 150");
			expect(event.pane!.content).not.toContain("line 1\n");
		});
	});
});
