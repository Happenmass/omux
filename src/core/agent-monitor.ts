import type { AgentCharacteristics } from "../agents/adapter.js";
import type { TmuxBridge } from "../tmux/bridge.js";
import type { StateDetector } from "../tmux/state-detector.js";
import { logger } from "../utils/logger.js";
import type { WorkQueue } from "./work-queue.js";

export interface TaskInfo {
	taskId: string;
	agentId: string;
	status: "running" | "waiting_input";
	summary: string;
	taskContext: string;
	preHash: string;
	startedAt: number;
	abortController: AbortController;
	/** Adapter-specific state-detection patterns for this agent's pane. */
	characteristics?: AgentCharacteristics;
	/** Set by cleanup()/shutdown() before aborting, so the polling loop skips the (always spurious) "aborted" settle callback. */
	suppressSettleCallback?: boolean;
}

export type DispatchResult = { dispatched: true; task: TaskInfo } | { dispatched: false; busy: BusyResult };

export interface BusyResult {
	agentId: string;
	currentTask: TaskInfo;
	paneContent: string;
}

interface AgentMonitorOptions {
	stateDetector: StateDetector;
	bridge: TmuxBridge;
	workQueue: WorkQueue;
}

export class AgentMonitor {
	private stateDetector: StateDetector;
	private bridge: TmuxBridge;
	private workQueue: WorkQueue;

	private tasks = new Map<string, TaskInfo>();
	private paneTargets = new Map<string, string>();
	private taskCounter = 0;

	constructor(opts: AgentMonitorOptions) {
		this.stateDetector = opts.stateDetector;
		this.bridge = opts.bridge;
		this.workQueue = opts.workQueue;
	}

	dispatch(
		agentId: string,
		paneTarget: string,
		opts: { preHash: string; summary: string; taskContext?: string; characteristics?: AgentCharacteristics },
	): DispatchResult {
		const existing = this.tasks.get(agentId);
		if (existing) {
			return {
				dispatched: false,
				busy: {
					agentId,
					currentTask: existing,
					paneContent: "(agent busy)",
				},
			};
		}

		this.taskCounter++;
		const taskId = `task_${this.taskCounter}`;
		const taskContext = opts.taskContext ?? opts.summary;

		const task: TaskInfo = {
			taskId,
			agentId,
			status: "running",
			summary: opts.summary,
			taskContext,
			preHash: opts.preHash,
			startedAt: Date.now(),
			abortController: new AbortController(),
			characteristics: opts.characteristics,
		};

		this.tasks.set(agentId, task);
		this.paneTargets.set(agentId, paneTarget);

		// Fire-and-forget background polling
		this.startPolling(agentId, paneTarget, task);

		return { dispatched: true, task };
	}

	resumeTask(agentId: string, newPreHash: string): boolean {
		const task = this.tasks.get(agentId);
		if (!task || task.status !== "waiting_input") {
			return false;
		}

		const paneTarget = this.paneTargets.get(agentId);
		if (!paneTarget) {
			return false;
		}

		task.preHash = newPreHash;
		task.status = "running";

		// Restart polling
		this.startPolling(agentId, paneTarget, task);

		return true;
	}

	isBusy(agentId: string): boolean {
		return this.tasks.has(agentId);
	}

	getTask(agentId: string): TaskInfo | null {
		return this.tasks.get(agentId) ?? null;
	}

	getAllTasks(): TaskInfo[] {
		return Array.from(this.tasks.values());
	}

	cleanup(agentId: string): void {
		const task = this.tasks.get(agentId);
		if (task) {
			task.suppressSettleCallback = true;
			task.abortController.abort();
			this.tasks.delete(agentId);
			this.paneTargets.delete(agentId);
		}
	}

	shutdown(): void {
		for (const [_agentId, task] of this.tasks) {
			task.suppressSettleCallback = true;
			task.abortController.abort();
		}
		this.tasks.clear();
		this.paneTargets.clear();
	}

	private startPolling(agentId: string, paneTarget: string, task: TaskInfo): void {
		const poll = async () => {
			try {
				const result = await this.stateDetector.waitForSettled(paneTarget, task.taskContext, {
					preHash: task.preHash,
					isAborted: () => task.abortController.signal.aborted,
					characteristics: task.characteristics,
				});

				// Check if aborted
				if (task.abortController.signal.aborted) {
					// Aborts are only triggered by cleanup()/shutdown() (interrupt_agent /
					// kill_agent / server stop), which set suppressSettleCallback. Firing an
					// "aborted" event here would deliver a stale callback for an agent the
					// caller deliberately tore down — skip it.
					if (!task.suppressSettleCallback) {
						const duration = Math.round((Date.now() - task.startedAt) / 1000);
						this.fireCallback(task, "aborted", "Task was aborted", duration);
					}
					this.tasks.delete(agentId);
					this.paneTargets.delete(agentId);
					return;
				}

				const status = result.analysis.status;
				const duration = Math.round((Date.now() - task.startedAt) / 1000);
				const paneContent = await this.capturePaneContent(paneTarget);

				if (status === "waiting_input") {
					task.status = "waiting_input";
					this.fireCallback(task, "waiting_input", result.analysis.detail, duration, paneContent);
					// Do NOT delete from Map — wait for resumeTask
					return;
				}

				if (result.timedOut) {
					this.fireCallback(task, "timeout", result.analysis.detail, duration, paneContent);
					this.tasks.delete(agentId);
					this.paneTargets.delete(agentId);
					return;
				}

				// Terminal states: completed, error, or anything else
				this.fireCallback(task, status, result.analysis.detail, duration, paneContent);
				this.tasks.delete(agentId);
				this.paneTargets.delete(agentId);
			} catch (err: any) {
				const duration = Math.round((Date.now() - task.startedAt) / 1000);
				const paneContent = await this.capturePaneContent(paneTarget);
				this.fireCallback(task, "error", `Exception: ${err.message}`, duration, paneContent);
				this.tasks.delete(agentId);
				this.paneTargets.delete(agentId);
			}
		};

		// Fire-and-forget
		poll().catch((err) => {
			logger.error("agent-monitor", `Unexpected polling error for ${agentId}: ${err.message}`);
		});
	}

	private fireCallback(
		task: TaskInfo,
		status: string,
		detail: string,
		durationSeconds: number,
		paneContent?: string,
	): void {
		logger.info("agent-monitor", `Task ${task.taskId} settled: ${status} (${durationSeconds}s)`);

		this.workQueue.enqueueAgentEvent({
			agentId: task.agentId,
			taskId: task.taskId,
			status: status as "waiting_input" | "completed" | "error" | "timeout" | "aborted",
			detail,
			paneContent: paneContent ?? "",
			summary: task.summary,
			durationSeconds,
			timestamp: Date.now(),
		});
	}

	private async capturePaneContent(paneTarget: string, lines = 100): Promise<string> {
		try {
			const capture = await this.bridge.capturePane(paneTarget, { startLine: -lines });
			return capture.content;
		} catch {
			return "(failed to capture pane content)";
		}
	}
}
