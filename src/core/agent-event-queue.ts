import { EventEmitter } from "node:events";

export interface AgentEvent {
	sessionId: string;
	taskId: string;
	status: "waiting_input" | "completed" | "error" | "timeout" | "aborted";
	detail: string;
	paneContent: string;
	summary: string;
	durationSeconds: number;
	timestamp: number;
	retryCount: number;
}

export class AgentEventQueue extends EventEmitter {
	private queue: AgentEvent[] = [];

	enqueue(event: AgentEvent): void {
		this.queue.push(event);
		this.emit("event_available", event);
	}

	dequeue(): AgentEvent | null {
		return this.queue.shift() ?? null;
	}

	peek(): AgentEvent | null {
		return this.queue[0] ?? null;
	}

	isEmpty(): boolean {
		return this.queue.length === 0;
	}

	size(): number {
		return this.queue.length;
	}

	removeBySessionId(sessionId: string): number {
		const before = this.queue.length;
		this.queue = this.queue.filter((e) => e.sessionId !== sessionId);
		return before - this.queue.length;
	}
}
