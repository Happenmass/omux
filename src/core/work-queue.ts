import { EventEmitter } from "node:events";

export interface AgentEvent {
	agentId: string;
	taskId: string;
	status: "waiting_input" | "completed" | "error" | "timeout" | "aborted";
	detail: string;
	paneContent: string;
	summary: string;
	durationSeconds: number;
	timestamp: number;
}

export type WorkItem = { kind: "user_message"; content: string } | { kind: "agent_event"; event: AgentEvent };

export class WorkQueue extends EventEmitter {
	private queue: WorkItem[] = [];

	/** Insert user message before all agent_event items (priority). */
	enqueueUserMessage(content: string): void {
		const idx = this.queue.findIndex((item) => item.kind === "agent_event");
		const item: WorkItem = { kind: "user_message", content };
		if (idx === -1) {
			this.queue.push(item);
		} else {
			this.queue.splice(idx, 0, item);
		}
		this.emit("item_available", item);
	}

	/** Append agent event to the tail of the queue. */
	enqueueAgentEvent(event: AgentEvent): void {
		const item: WorkItem = { kind: "agent_event", event };
		this.queue.push(item);
		this.emit("item_available", item);
	}

	dequeue(): WorkItem | null {
		return this.queue.shift() ?? null;
	}

	peek(): WorkItem | null {
		return this.queue[0] ?? null;
	}

	isEmpty(): boolean {
		return this.queue.length === 0;
	}

	size(): number {
		return this.queue.length;
	}

	/** Number of pending user messages in the queue (excludes agent_event items). */
	pendingUserMessages(): number {
		return this.queue.reduce((n, item) => n + (item.kind === "user_message" ? 1 : 0), 0);
	}

	/** Remove all agent_event items matching agentId. Returns count removed. */
	removeAgentEventsByAgentId(agentId: string): number {
		const before = this.queue.length;
		this.queue = this.queue.filter((item) => !(item.kind === "agent_event" && item.event.agentId === agentId));
		return before - this.queue.length;
	}

	/** Get a snapshot of all agent events in the queue (for list_agent_tasks). */
	getAgentEvents(): AgentEvent[] {
		return this.queue
			.filter((item): item is Extract<WorkItem, { kind: "agent_event" }> => item.kind === "agent_event")
			.map((item) => item.event);
	}
}
