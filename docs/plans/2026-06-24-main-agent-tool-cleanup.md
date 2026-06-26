# MainAgent Tool-Surface Cleanup Implementation Plan

> **For agentic workers:** Use `spec-forge:executing-plans` to implement this
> plan — it runs one fresh subagent per task via a Workflow, routing each task to
> a model matched to its complexity (or `superpowers:subagent-driven-development`
> if the Superpowers plugin is installed). Steps use checkbox (`- [ ]`) syntax for
> tracking.

**Goal:** Resolve three review findings on MainAgent's LLM tool set — remove the redundant `list_agent_tasks` tool, stop intentional interrupt/kill from emitting a spurious `aborted` callback, and disambiguate the two memory tools in their descriptions.

**Architecture:** Three independent, small edits in `src/core/main-agent.ts` and `src/core/agent-monitor.ts`, plus prompt/doc/test sync. C1 deletes a tool (definition + handler `case`) and lets unknown-tool calls fall through to the existing `default` branch; the read snapshot it provided is already a strict subset of the shipped `wait_for_agents`. C2 adds a `suppressSettleCallback` flag on `TaskInfo` so the polling loop skips the `aborted` callback when an abort was triggered deliberately by `cleanup()`/`shutdown()`. C3 is description-string-only.

**Tech Stack:** TypeScript (ESM, Node16, strict), Vitest, Biome (tabs/width 3). Spec: [main-agent-tool-cleanup-spec.md](../../main-agent-tool-cleanup-spec.md).

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `src/core/main-agent.ts` | Tool definitions + `executeTool` switch + tool descriptions | C1 (remove def+case), C3 (2 description strings) |
| `src/core/agent-monitor.ts` | Task polling + lifecycle | C2 (`TaskInfo` field, `cleanup`/`shutdown`, abort branch) |
| `src/core/work-queue.ts` | Agent-event queue | C1 (reword one doc comment; keep `getAgentEvents()`) |
| `prompts/main-agent.md`, `prompts/main-agent.cn.md` | MainAgent system prompt | C1 (drop `list_agent_tasks` from the "do NOT poll" sentence) |
| `CLAUDE.md` | Architecture doc tool list | C1 (drop `list_agent_tasks`) |
| `test/core/main-agent.test.ts` | MainAgent tool tests | C1 (replace the `list_agent_tasks tool` describe block) |
| `test/core/agent-monitor.test.ts` | AgentMonitor tests | C2 (add suppress + regression tests) |

---

## Task 1: C1 — Remove the `list_agent_tasks` tool

**Files:**
- Modify: `test/core/main-agent.test.ts:1255-1302` (replace the `describe("list_agent_tasks tool", …)` block)
- Modify: `src/core/main-agent.ts:361-370` (delete the tool definition)
- Modify: `src/core/main-agent.ts:1834-1858` (delete the handler `case`)
- Modify: `src/core/work-queue.ts:66` (reword comment)
- Modify: `prompts/main-agent.md:160`, `prompts/main-agent.cn.md:191`
- Modify: `CLAUDE.md:54`

- [ ] **Step 1: Replace the obsolete test block with a removal test**

In `test/core/main-agent.test.ts`, delete the entire existing block (lines ~1255-1302):

```typescript
	describe("list_agent_tasks tool", () => {
		it("returns empty message when no tasks and no pending events", async () => {
			// … existing body …
		});

		it("returns active tasks when agent monitor has tasks", async () => {
			// … existing body …
		});
	});
```

Replace it with this single test (same harness — `setupAgent`, `toolCallResponse`, `textResponse`, `mockCtx` are already defined in this file):

```typescript
	describe("list_agent_tasks removed", () => {
		it("returns 'Unknown tool' when the LLM calls list_agent_tasks", async () => {
			const agent = setupAgent([toolCallResponse("list_agent_tasks", {}, "tc1"), textResponse("ok")]);

			await agent.handleMessage("check agents");

			const calls = (mockCtx.addMessage as any).mock.calls;
			const toolResultMsg = calls.find(
				(c: any) =>
					c[0].role === "tool" &&
					typeof c[0].content === "string" &&
					c[0].content.includes("Unknown tool: list_agent_tasks"),
			);
			expect(toolResultMsg).toBeDefined();
		});
	});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/core/main-agent.test.ts -t "Unknown tool"`
Expected: FAIL — the tool is still registered, so the tool result is the snapshot text (`No active agent tasks or pending events.`), not `Unknown tool: list_agent_tasks`.

- [ ] **Step 3: Delete the tool definition**

In `src/core/main-agent.ts`, remove this entry from the `TOOL_DEFINITIONS` array (it sits between the `exec_command` and `wait_for_agents` entries):

```typescript
	{
		name: "list_agent_tasks",
		description:
			"List all active sub-agent tasks currently being monitored and any pending events in the agent event queue. Use this to get a real-time snapshot of sub-agent status before deciding whether to intervene.",
		parameters: {
			type: "object",
			properties: {},
			required: [],
		},
	},
```

- [ ] **Step 4: Delete the handler case**

In `src/core/main-agent.ts`, remove the entire `case "list_agent_tasks":` block (the case immediately before `case "wait_for_agents":`):

```typescript
			case "list_agent_tasks": {
				const activeTasks = this.agentMonitor?.getAllTasks() ?? [];
				const pendingEvents = this.workQueue.getAgentEvents();

				const lines: string[] = [];

				if (activeTasks.length > 0) {
					lines.push("## Active Agent Tasks");
					for (const task of activeTasks) {
						const elapsedSeconds = Math.round((Date.now() - task.startedAt) / 1000);
						lines.push(
							`- agent=${task.agentId} task=${task.taskId} status=${task.status} elapsed=${elapsedSeconds}s`,
						);
						lines.push(`  summary: ${task.summary}`);
					}
				}

				if (pendingEvents.length > 0) {
					if (lines.length > 0) lines.push("");
					lines.push("## Pending Events (WorkQueue)");
					for (const evt of pendingEvents) {
						lines.push(
							`- agent=${evt.agentId} task=${evt.taskId} status=${evt.status} duration=${evt.durationSeconds}s`,
						);
						lines.push(`  summary: ${evt.summary}`);
						lines.push(`  detail: ${evt.detail}`);
					}
				}

				if (lines.length === 0) {
					return { output: "No active agent tasks or pending events.", terminal: false };
				}

				return { output: lines.join("\n"), terminal: false };
			}
```

Do **not** touch `case "wait_for_agents":` — it also calls `this.workQueue.getAgentEvents()` and must keep working.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/core/main-agent.test.ts -t "Unknown tool"`
Expected: PASS — the call now falls through to the `default` branch which returns `Unknown tool: list_agent_tasks`.

- [ ] **Step 6: Reword the now-stale `getAgentEvents()` comment**

In `src/core/work-queue.ts`, change line 66 from:

```typescript
	/** Get a snapshot of all agent events in the queue (for list_agent_tasks). */
```

to:

```typescript
	/** Get a snapshot of all agent events in the queue (for wait_for_agents). */
```

Keep the `getAgentEvents()` method itself unchanged.

- [ ] **Step 7: Drop `list_agent_tasks` from both prompts**

In `prompts/main-agent.md`, in the "Waiting for running agents — do NOT poll." paragraph, change:

```
sit in a loop calling `inspect_agent` / `list_agent_tasks` (or emitting "still monitoring…" filler)
```

to:

```
sit in a loop calling `inspect_agent` (or emitting "still monitoring…" filler)
```

In `prompts/main-agent.cn.md`, in the "等待运行中的 agent —— 不要轮询。" paragraph, change:

```
靠循环调用 `inspect_agent` / `list_agent_tasks`(或反复输出"继续监控中…"之类的占位文本)
```

to:

```
靠循环调用 `inspect_agent`(或反复输出"继续监控中…"之类的占位文本)
```

- [ ] **Step 8: Drop `list_agent_tasks` from the architecture doc**

In `CLAUDE.md`, on the "Agent interaction" bullet, change:

```
`inspect_agent`, `list_agent_tasks`, `wait_for_agents` (parks the loop
```

to:

```
`inspect_agent`, `wait_for_agents` (parks the loop
```

- [ ] **Step 9: Verify no stale references remain**

Run: `grep -rn "list_agent_tasks" src/ prompts/ CLAUDE.md`
Expected: **zero hits** (the `work-queue.ts` comment now says `wait_for_agents`; no definition, handler, prompt instruction, or doc list item survives).

Run: `grep -rn "list_agent_tasks" test/`
Expected: exactly two hits, both in `test/core/main-agent.test.ts` — the `"list_agent_tasks removed"` describe name and the `includes("Unknown tool: list_agent_tasks")` assertion. These are intentional.

- [ ] **Step 10: Build and run the affected test files**

Run: `npm run build && npx vitest run test/core/main-agent.test.ts test/core/wait-for-agents.test.ts`
Expected: build succeeds; all tests PASS (including `wait_for_agents` which still reads queued events).

- [ ] **Step 11: Commit**

```bash
git add src/core/main-agent.ts src/core/work-queue.ts prompts/main-agent.md prompts/main-agent.cn.md CLAUDE.md test/core/main-agent.test.ts
git commit -m "refactor(main-agent): remove redundant list_agent_tasks tool

Its read snapshot is a strict subset of wait_for_agents, and a non-parking
snapshot re-enabled the inspect/list polling anti-pattern. Unknown calls now
fall through to the default branch.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: C2 — Suppress the spurious `aborted` callback on intentional cleanup

**Risk:** concurrency — touches the background polling loop's abort path; an over-broad suppression could silence genuine settle callbacks.

**Files:**
- Test: `test/core/agent-monitor.test.ts` (add a new describe block near the existing polling tests)
- Modify: `src/core/agent-monitor.ts:7-16` (`TaskInfo` interface)
- Modify: `src/core/agent-monitor.ts:125-132` (`cleanup`)
- Modify: `src/core/agent-monitor.ts:134-140` (`shutdown`)
- Modify: `src/core/agent-monitor.ts:150-157` (abort branch in `startPolling`)

- [ ] **Step 1: Write the failing tests**

Add this describe block to `test/core/agent-monitor.test.ts`, inside the top-level `describe("AgentMonitor", …)` (after the `dispatch` block). It reuses the file's existing `mockDetector`/`workQueue`/`monitor` from `beforeEach` and the `settledResult` helper:

```typescript
	describe("cleanup/shutdown suppress the aborted callback", () => {
		it("does NOT enqueue an aborted event when cleanup() aborts a running task", async () => {
			monitor.dispatch("session-1", "session-1:0.0", { preHash: "h", summary: "task" });

			// Deliberate teardown: aborts the controller and removes the task.
			monitor.cleanup("session-1");

			// Let the awaited waitForSettled resolve so the poll reaches the abort branch.
			mockDetector._resolve(settledResult("completed"));
			await new Promise((r) => setTimeout(r, 0));

			const events: AgentEvent[] = workQueue.getAgentEvents();
			expect(events.some((e) => e.status === "aborted")).toBe(false);
			expect(workQueue.isEmpty()).toBe(true);
			expect(monitor.isBusy("session-1")).toBe(false);
		});

		it("still enqueues a completed event for a task that settles without cleanup", async () => {
			monitor.dispatch("session-2", "session-2:0.0", { preHash: "h", summary: "task" });

			mockDetector._resolve(settledResult("completed"));
			await new Promise((r) => setTimeout(r, 0));

			const events: AgentEvent[] = workQueue.getAgentEvents();
			expect(events).toHaveLength(1);
			expect(events[0].status).toBe("completed");
			expect(events[0].agentId).toBe("session-2");
		});
	});
```

- [ ] **Step 2: Run the tests to verify the first one fails**

Run: `npx vitest run test/core/agent-monitor.test.ts -t "suppress the aborted callback"`
Expected: the "does NOT enqueue an aborted event" test FAILS — today the abort branch fires `fireCallback(task, "aborted", …)`, so `workQueue` contains an `aborted` event. (The "still enqueues a completed event" test should already PASS — it is the regression guard.)

- [ ] **Step 3: Add the `suppressSettleCallback` field to `TaskInfo`**

In `src/core/agent-monitor.ts`, change the interface from:

```typescript
export interface TaskInfo {
	taskId: string;
	agentId: string;
	status: "running" | "waiting_input";
	summary: string;
	taskContext: string;
	preHash: string;
	startedAt: number;
	abortController: AbortController;
}
```

to (append one field):

```typescript
export interface TaskInfo {
	taskId: string;
	agentId: string;
	status: "running" | "waiting_input";
	summary: string;
	taskContext: string;
	preHash: string;
	startedAt: number;
	abortController: AbortController;
	/** Set by cleanup()/shutdown() before aborting, so the polling loop skips the (always spurious) "aborted" settle callback. */
	suppressSettleCallback?: boolean;
}
```

- [ ] **Step 4: Set the flag before aborting in `cleanup()` and `shutdown()`**

In `src/core/agent-monitor.ts`, change `cleanup()` from:

```typescript
	cleanup(agentId: string): void {
		const task = this.tasks.get(agentId);
		if (task) {
			task.abortController.abort();
			this.tasks.delete(agentId);
			this.paneTargets.delete(agentId);
		}
	}
```

to:

```typescript
	cleanup(agentId: string): void {
		const task = this.tasks.get(agentId);
		if (task) {
			task.suppressSettleCallback = true;
			task.abortController.abort();
			this.tasks.delete(agentId);
			this.paneTargets.delete(agentId);
		}
	}
```

And change `shutdown()` from:

```typescript
	shutdown(): void {
		for (const [_agentId, task] of this.tasks) {
			task.abortController.abort();
		}
		this.tasks.clear();
		this.paneTargets.clear();
	}
```

to:

```typescript
	shutdown(): void {
		for (const [_agentId, task] of this.tasks) {
			task.suppressSettleCallback = true;
			task.abortController.abort();
		}
		this.tasks.clear();
		this.paneTargets.clear();
	}
```

- [ ] **Step 5: Guard the abort branch in `startPolling()`**

In `src/core/agent-monitor.ts`, change the abort branch from:

```typescript
				// Check if aborted
				if (task.abortController.signal.aborted) {
					const duration = Math.round((Date.now() - task.startedAt) / 1000);
					this.fireCallback(task, "aborted", "Task was aborted", duration);
					this.tasks.delete(agentId);
					this.paneTargets.delete(agentId);
					return;
				}
```

to:

```typescript
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
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/core/agent-monitor.test.ts -t "suppress the aborted callback"`
Expected: both tests PASS.

- [ ] **Step 7: Run the full agent-monitor suite (regression)**

Run: `npm run build && npx vitest run test/core/agent-monitor.test.ts`
Expected: build succeeds; all tests PASS (no existing test relied on the `aborted` callback).

- [ ] **Step 8: Commit**

```bash
git add src/core/agent-monitor.ts test/core/agent-monitor.test.ts
git commit -m "fix(agent-monitor): suppress spurious aborted callback on intentional teardown

interrupt_agent / kill_agent / shutdown abort the polling controller, which
previously enqueued a stale 'aborted' AGENT_EVENT after the caller already
moved on. cleanup()/shutdown() now mark the task so the abort branch skips it.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: C3 — Disambiguate the two memory-tool descriptions

**Files:**
- Modify: `src/core/main-agent.ts:192-194` (`memory_edit` description)
- Modify: `src/core/main-agent.ts:295-297` (`persistent_memory` description)

This is a description-string-only change (no parameters, handler, or behavior change), so it is verified by `grep` + the existing `memory-tools.test.ts` staying green rather than by a new unit test.

- [ ] **Step 1: Rewrite the `memory_edit` description**

In `src/core/main-agent.ts`, change the `memory_edit` description from:

```typescript
		description:
			"Edit a memory file. Supports append (default), overwrite, search-and-replace, and delete. Only memory/*.md files are allowed.",
```

to:

```typescript
		description:
			"Edit a file in the SEARCHABLE memory store (memory/*.md, indexed for memory_search / memory_get). Supports append (default), overwrite, search-and-replace, and delete. Only memory/*.md files are allowed. This is NOT the always-in-prompt MEMORY.md — to edit the global/project MEMORY.md snapshot, use persistent_memory.",
```

- [ ] **Step 2: Prepend a cross-reference to the `persistent_memory` description**

In `src/core/main-agent.ts`, change the start of the `persistent_memory` description from:

```typescript
			"Read or update a persistent MEMORY.md file. Global scope (`~/.cliclaw/MEMORY.md`) is loaded into your system prompt under {{memory}} ONCE per session
```

to:

```typescript
			"Read or update a persistent MEMORY.md file. (This is the ALWAYS-in-system-prompt memory; for the separate searchable memory/*.md store use memory_edit / memory_search.) Global scope (`~/.cliclaw/MEMORY.md`) is loaded into your system prompt under {{memory}} ONCE per session
```

Leave the rest of the `persistent_memory` description string unchanged.

- [ ] **Step 3: Verify the cross-references exist and are mutual**

Run: `grep -n "use persistent_memory" src/core/main-agent.ts && grep -n "use memory_edit / memory_search" src/core/main-agent.ts`
Expected: one hit each — `memory_edit` points to `persistent_memory`, and `persistent_memory` points to `memory_edit`/`memory_search`.

- [ ] **Step 4: Build, lint, and run the memory tests (no behavior change)**

Run: `npm run build && npx biome check src/core/main-agent.ts && npx vitest run test/core/memory-tools.test.ts`
Expected: build succeeds; Biome clean on `src/core/main-agent.ts`; all memory-tool tests PASS (schemas and handlers untouched).
NOTE: do **not** run whole-repo `npm run check` — the repo has pre-existing Biome debt in unrelated files (`change-tracker.ts`, `context-manager.ts`, `llm/*`, `main.ts`, `learning-*.ts`) that is out of scope for this task. Scope the lint check to the file you changed.

- [ ] **Step 5: Commit**

```bash
git add src/core/main-agent.ts
git commit -m "docs(main-agent): disambiguate memory_edit vs persistent_memory in tool descriptions

Cross-reference the two memory subsystems (searchable memory/*.md vs the
always-in-prompt MEMORY.md) so the model picks the right tool.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final verification

- [ ] **Step 1: Full build + test sweep**

Run: `npm run build && npm test`
Expected: build succeeds; entire Vitest suite PASS.

- [ ] **Step 2: Lint (scoped to changed files)**

Run: `npx biome check src/core/main-agent.ts src/core/agent-monitor.ts src/core/work-queue.ts`
Expected: clean on these three files. Do **not** use whole-repo `npm run check`: the repo carries substantial pre-existing Biome debt in unrelated files (`change-tracker.ts`, `context-manager.ts`, `llm/*`, `main.ts`, `learning-*.ts`) that predates and is out of scope for this work. (Pre-existing warnings in `main-agent.ts` — top-of-file unused imports and the unused private `formatSignal` — also predate this work.)

- [ ] **Step 3: Confirm the spec's acceptance criteria are met**

- C1: `grep -rn "list_agent_tasks" src/ prompts/ CLAUDE.md` → only the assertion literal inside the test (none in `src/`, `prompts/`, `CLAUDE.md`); calling the tool returns `Unknown tool: list_agent_tasks`.
- C2: `AgentMonitor.cleanup()` followed by a settle enqueues no `aborted` event; a normal completion still enqueues `completed`.
- C3: `memory_edit` and `persistent_memory` descriptions reference each other.

---

## Notes

- `aborted` stays a member of the `AgentEvent` status union in `src/core/work-queue.ts` even though it is no longer emitted — leaving the type stable; do not remove it.
- Suggested follow-up release tag: **v2.3.6** (the cleanup follow-up to v2.3.5's `wait_for_agents`). Version bump is **not** part of this plan — handle it separately when cutting the release.
- Out of scope (deferred): `exec_command` read-only enforcement (the 🟠 review item).
