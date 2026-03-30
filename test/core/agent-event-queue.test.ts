import { describe, it, expect, vi } from "vitest";
import { AgentEventQueue, type AgentEvent } from "../../src/core/agent-event-queue.js";

function makeEvent(overrides: Partial<AgentEvent> = {}): AgentEvent {
	return {
		sessionId: "cliclaw-test-1",
		taskId: "task_1",
		status: "waiting_input",
		detail: "Agent is waiting for input",
		paneContent: "$ _",
		summary: "Implement feature X",
		durationSeconds: 10,
		timestamp: Date.now(),
		retryCount: 0,
		...overrides,
	};
}

describe("AgentEventQueue", () => {
	it("enqueue and dequeue in FIFO order", () => {
		const queue = new AgentEventQueue();
		const eventA = makeEvent({ taskId: "task_1" });
		const eventB = makeEvent({ taskId: "task_2" });

		queue.enqueue(eventA);
		queue.enqueue(eventB);

		expect(queue.dequeue()).toBe(eventA);
		expect(queue.dequeue()).toBe(eventB);
		expect(queue.dequeue()).toBeNull();
	});

	it("emits event_available on enqueue", () => {
		const queue = new AgentEventQueue();
		const handler = vi.fn();
		queue.on("event_available", handler);

		const event = makeEvent();
		queue.enqueue(event);

		expect(handler).toHaveBeenCalledOnce();
		expect(handler).toHaveBeenCalledWith(event);
	});

	it("peek returns first event without removing it", () => {
		const queue = new AgentEventQueue();
		const event = makeEvent();
		queue.enqueue(event);

		expect(queue.peek()).toBe(event);
		expect(queue.size()).toBe(1);
		expect(queue.peek()).toBe(event);
	});

	it("peek returns null on empty queue", () => {
		const queue = new AgentEventQueue();
		expect(queue.peek()).toBeNull();
	});

	it("dequeue returns null on empty queue", () => {
		const queue = new AgentEventQueue();
		expect(queue.dequeue()).toBeNull();
	});

	it("isEmpty returns correct state", () => {
		const queue = new AgentEventQueue();
		expect(queue.isEmpty()).toBe(true);

		queue.enqueue(makeEvent());
		expect(queue.isEmpty()).toBe(false);

		queue.dequeue();
		expect(queue.isEmpty()).toBe(true);
	});

	it("size tracks queue length", () => {
		const queue = new AgentEventQueue();
		expect(queue.size()).toBe(0);

		queue.enqueue(makeEvent({ taskId: "task_1" }));
		queue.enqueue(makeEvent({ taskId: "task_2" }));
		expect(queue.size()).toBe(2);

		queue.dequeue();
		expect(queue.size()).toBe(1);
	});

	it("removeBySessionId removes matching events", () => {
		const queue = new AgentEventQueue();
		queue.enqueue(makeEvent({ sessionId: "session-A", taskId: "task_1" }));
		queue.enqueue(makeEvent({ sessionId: "session-A", taskId: "task_2" }));
		queue.enqueue(makeEvent({ sessionId: "session-B", taskId: "task_3" }));

		const removed = queue.removeBySessionId("session-A");

		expect(removed).toBe(2);
		expect(queue.size()).toBe(1);
		expect(queue.peek()?.sessionId).toBe("session-B");
	});

	it("removeBySessionId returns 0 when no match", () => {
		const queue = new AgentEventQueue();
		queue.enqueue(makeEvent({ sessionId: "session-A" }));

		const removed = queue.removeBySessionId("session-X");

		expect(removed).toBe(0);
		expect(queue.size()).toBe(1);
	});
});
