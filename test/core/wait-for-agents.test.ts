import { beforeEach, describe, expect, it, vi } from "vitest";
import { MainAgent } from "../../src/core/main-agent.js";

/**
 * Tests for the wait_for_agents tool — it reports running sub-agent status and
 * parks the execution loop (terminal: true) only when a future callback is
 * guaranteed to wake the MainAgent, so the model stops polling inspect_agent /
 * list_agent_tasks in a tight loop.
 */

function createAgent() {
	const broadcaster = {
		broadcast: vi.fn(),
		addClient: vi.fn(),
		removeClient: vi.fn(),
		getClientCount: vi.fn(),
	} as any;

	const agent = new MainAgent({
		contextManager: {
			addMessage: vi.fn(),
			getMessages: vi.fn().mockReturnValue([]),
			getCurrentTokenEstimate: vi.fn().mockReturnValue(0),
			getContextWindowLimit: vi.fn().mockReturnValue(200000),
			setCompactTuning: vi.fn(),
		} as any,
		llmClient: {} as any,
		adapter: { getCharacteristics: vi.fn().mockReturnValue({}) } as any,
		bridge: { capturePane: vi.fn() } as any,
		createAgentSettleMs: 0,
		stateDetector: { onStateChange: vi.fn() } as any,
		broadcaster,
	});

	return { agent, broadcaster };
}

function task(agentId: string, status: "running" | "waiting_input", summary: string) {
	return {
		taskId: `task_${agentId}`,
		agentId,
		status,
		summary,
		taskContext: summary,
		preHash: "h",
		startedAt: Date.now() - 5000,
		abortController: new AbortController(),
	};
}

function call(agent: MainAgent) {
	return (agent as any).executeTool({
		type: "tool_call",
		id: "tc1",
		name: "wait_for_agents",
		arguments: {},
	});
}

describe("wait_for_agents", () => {
	let agent: MainAgent;
	let broadcaster: any;

	beforeEach(() => {
		({ agent, broadcaster } = createAgent());
	});

	it("parks (terminal) when at least one agent is still running", async () => {
		(agent as any).agentMonitor = {
			getAllTasks: () => [task("cliclaw-a", "running", "build core")],
		};

		const result = await call(agent);

		expect(result.terminal).toBe(true);
		expect(result.output).toContain("Parked");
		expect(result.output).toContain("cliclaw-a");
		expect(broadcaster.broadcast).toHaveBeenCalledWith(
			expect.objectContaining({ type: "system", message: expect.stringContaining("Parked, waiting for") }),
		);
	});

	it("parks when an agent event is already queued even with no running task", async () => {
		(agent as any).agentMonitor = { getAllTasks: () => [] };
		(agent as any).workQueue.enqueueAgentEvent({
			agentId: "cliclaw-b",
			taskId: "task_1",
			status: "completed",
			detail: "done",
			paneContent: "",
			summary: "finish notify",
			durationSeconds: 10,
			timestamp: Date.now(),
		});

		const result = await call(agent);

		expect(result.terminal).toBe(true);
		expect(result.output).toContain("event(s) already queued");
		expect(result.output).toContain("cliclaw-b");
	});

	it("does NOT park when there is nothing to wait for, and surfaces the drive-or-finish decision", async () => {
		(agent as any).agentMonitor = { getAllTasks: () => [] };

		const result = await call(agent);

		expect(result.terminal).toBe(false);
		expect(result.output).toContain("nothing to wait for");
		// Must offer BOTH paths so the model judges instead of auto-finishing.
		expect(result.output).toContain("send_to_agent");
		expect(result.output).toContain("final summary");
		expect(broadcaster.broadcast).not.toHaveBeenCalled();
	});

	it("does NOT park when agents are only waiting_input — nudges respond_to_agent", async () => {
		(agent as any).agentMonitor = {
			getAllTasks: () => [task("cliclaw-c", "waiting_input", "confirm overwrite?")],
		};

		const result = await call(agent);

		expect(result.terminal).toBe(false);
		expect(result.output).toContain("respond_to_agent");
		expect(result.output).toContain("cliclaw-c");
	});

	it("parks but still surfaces waiting_input agents when others are running", async () => {
		(agent as any).agentMonitor = {
			getAllTasks: () => [
				task("cliclaw-run", "running", "implement"),
				task("cliclaw-ask", "waiting_input", "which port?"),
			],
		};

		const result = await call(agent);

		expect(result.terminal).toBe(true);
		expect(result.output).toContain("cliclaw-run");
		expect(result.output).toContain("cliclaw-ask");
		expect(result.output).toContain("respond_to_agent");
	});
});
