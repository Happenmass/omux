import { describe, it, expect, vi } from "vitest";
import { WorkQueue, type AgentEvent } from "../../src/core/work-queue.js";

function makeAgentEvent(overrides: Partial<AgentEvent> = {}): AgentEvent {
	return {
		agentId: "cliclaw-test-1",
		taskId: "task_1",
		status: "completed",
		detail: "Agent finished",
		paneContent: "$ done",
		summary: "Do something",
		durationSeconds: 5,
		timestamp: Date.now(),
		...overrides,
	};
}

describe("WorkQueue", () => {
	it("dequeue returns null on empty queue", () => {
		const q = new WorkQueue();
		expect(q.dequeue()).toBeNull();
		expect(q.isEmpty()).toBe(true);
		expect(q.size()).toBe(0);
	});

	it("user messages maintain FIFO order", () => {
		const q = new WorkQueue();
		q.enqueueUserMessage("first");
		q.enqueueUserMessage("second");
		q.enqueueUserMessage("third");

		expect(q.dequeue()).toEqual({ kind: "user_message", content: "first" });
		expect(q.dequeue()).toEqual({ kind: "user_message", content: "second" });
		expect(q.dequeue()).toEqual({ kind: "user_message", content: "third" });
		expect(q.dequeue()).toBeNull();
	});

	it("agent events maintain FIFO order", () => {
		const q = new WorkQueue();
		const e1 = makeAgentEvent({ taskId: "task_1" });
		const e2 = makeAgentEvent({ taskId: "task_2" });
		q.enqueueAgentEvent(e1);
		q.enqueueAgentEvent(e2);

		const item1 = q.dequeue()!;
		const item2 = q.dequeue()!;
		expect(item1).toEqual({ kind: "agent_event", event: e1 });
		expect(item2).toEqual({ kind: "agent_event", event: e2 });
	});

	it("user messages have priority over agent events", () => {
		const q = new WorkQueue();
		const event = makeAgentEvent({ taskId: "task_1" });

		// Agent event enqueued first
		q.enqueueAgentEvent(event);
		// User message enqueued second
		q.enqueueUserMessage("urgent");

		// User message should come out first
		expect(q.dequeue()).toEqual({ kind: "user_message", content: "urgent" });
		expect(q.dequeue()).toEqual({ kind: "agent_event", event });
	});

	it("multiple user messages all sort before agent events", () => {
		const q = new WorkQueue();
		const e1 = makeAgentEvent({ taskId: "task_1" });
		const e2 = makeAgentEvent({ taskId: "task_2" });

		q.enqueueAgentEvent(e1);
		q.enqueueUserMessage("msg1");
		q.enqueueAgentEvent(e2);
		q.enqueueUserMessage("msg2");

		// User messages first (FIFO), then agent events (FIFO)
		expect(q.dequeue()).toEqual({ kind: "user_message", content: "msg1" });
		expect(q.dequeue()).toEqual({ kind: "user_message", content: "msg2" });
		expect(q.dequeue()).toEqual({ kind: "agent_event", event: e1 });
		expect(q.dequeue()).toEqual({ kind: "agent_event", event: e2 });
	});

	it("interleaved enqueue maintains correct priority ordering", () => {
		const q = new WorkQueue();
		const e1 = makeAgentEvent({ taskId: "task_1" });

		q.enqueueUserMessage("first_user");
		q.enqueueAgentEvent(e1);
		q.enqueueUserMessage("second_user");

		// second_user should be after first_user but before e1
		expect(q.dequeue()).toEqual({ kind: "user_message", content: "first_user" });
		expect(q.dequeue()).toEqual({ kind: "user_message", content: "second_user" });
		expect(q.dequeue()).toEqual({ kind: "agent_event", event: e1 });
	});

	it("peek returns first item without removing", () => {
		const q = new WorkQueue();
		q.enqueueUserMessage("hello");

		expect(q.peek()).toEqual({ kind: "user_message", content: "hello" });
		expect(q.size()).toBe(1);
		expect(q.peek()).toEqual({ kind: "user_message", content: "hello" });
	});

	it("peek returns null on empty queue", () => {
		const q = new WorkQueue();
		expect(q.peek()).toBeNull();
	});

	it("size tracks queue length", () => {
		const q = new WorkQueue();
		expect(q.size()).toBe(0);

		q.enqueueUserMessage("a");
		q.enqueueAgentEvent(makeAgentEvent());
		expect(q.size()).toBe(2);

		q.dequeue();
		expect(q.size()).toBe(1);
	});

	it("emits item_available on enqueueUserMessage", () => {
		const q = new WorkQueue();
		const handler = vi.fn();
		q.on("item_available", handler);

		q.enqueueUserMessage("hello");

		expect(handler).toHaveBeenCalledOnce();
		expect(handler).toHaveBeenCalledWith({ kind: "user_message", content: "hello" });
	});

	it("emits item_available on enqueueAgentEvent", () => {
		const q = new WorkQueue();
		const handler = vi.fn();
		q.on("item_available", handler);

		const event = makeAgentEvent();
		q.enqueueAgentEvent(event);

		expect(handler).toHaveBeenCalledOnce();
		expect(handler).toHaveBeenCalledWith({ kind: "agent_event", event });
	});

	it("removeAgentEventsByAgentId removes only matching agent events", () => {
		const q = new WorkQueue();
		q.enqueueUserMessage("keep me");
		q.enqueueAgentEvent(makeAgentEvent({ agentId: "session-A", taskId: "t1" }));
		q.enqueueAgentEvent(makeAgentEvent({ agentId: "session-A", taskId: "t2" }));
		q.enqueueAgentEvent(makeAgentEvent({ agentId: "session-B", taskId: "t3" }));

		const removed = q.removeAgentEventsByAgentId("session-A");

		expect(removed).toBe(2);
		expect(q.size()).toBe(2); // user message + session-B event
		expect(q.dequeue()).toEqual({ kind: "user_message", content: "keep me" });
		expect(q.dequeue()!.kind).toBe("agent_event");
	});

	it("removeAgentEventsByAgentId returns 0 when no match", () => {
		const q = new WorkQueue();
		q.enqueueAgentEvent(makeAgentEvent({ agentId: "session-A" }));
		q.enqueueUserMessage("msg");

		const removed = q.removeAgentEventsByAgentId("session-X");

		expect(removed).toBe(0);
		expect(q.size()).toBe(2);
	});

	it("getAgentEvents returns only agent event items", () => {
		const q = new WorkQueue();
		const e1 = makeAgentEvent({ taskId: "t1" });
		const e2 = makeAgentEvent({ taskId: "t2" });

		q.enqueueUserMessage("msg");
		q.enqueueAgentEvent(e1);
		q.enqueueUserMessage("msg2");
		q.enqueueAgentEvent(e2);

		const events = q.getAgentEvents();
		expect(events).toHaveLength(2);
		expect(events[0]).toBe(e1);
		expect(events[1]).toBe(e2);

		// Queue unchanged
		expect(q.size()).toBe(4);
	});

	it("getAgentEvents returns empty array when no agent events", () => {
		const q = new WorkQueue();
		q.enqueueUserMessage("msg");
		expect(q.getAgentEvents()).toEqual([]);
	});
});
