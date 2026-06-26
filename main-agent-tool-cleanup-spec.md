# MainAgent tool-surface cleanup

Resolve three review findings on MainAgent's LLM tool set: remove the now-redundant `list_agent_tasks`, stop `interrupt_agent`/`kill_agent` from emitting a spurious `aborted` callback, and disambiguate the two memory tools in their descriptions. Consumed by the MainAgent LLM tool loop in `src/core/main-agent.ts`.

## Context & Scope
In scope:
- **C1** — Delete `list_agent_tasks` (definition, handler, doc, prompt mention, tests). Its read snapshot is a strict subset of `wait_for_agents`, and a non-parking snapshot re-enables the polling anti-pattern.
- **C2** — Suppress the post-cleanup `aborted` settle callback so an intentionally interrupted/killed agent does not enqueue a stale `AGENT_EVENT`.
- **C3** — Tighten the `memory_edit` and `persistent_memory` description strings so the model picks the right memory subsystem.

Out of scope:
- `exec_command` read-only enforcement (🟠 lower-priority review item; not built here).
- Any change to `wait_for_agents` behavior, the callback/parking mechanism, or the `AgentEvent` status union. (Shipped in v2.3.5; unchanged.)
- Removing `inspect_agent` or `list_agents` — both retain distinct uses (single-pane raw content; tmux-session listing).

---

## C1 — Remove `list_agent_tasks`

### Behavior Contract
Anchors:
- Definition: `src/core/main-agent.ts:362` — `{ name: "list_agent_tasks", ... }` in `TOOL_DEFINITIONS`.
- Handler: `src/core/main-agent.ts:1834` — `case "list_agent_tasks":`.
- Retained dependency: `src/core/main-agent.ts:1872` — `wait_for_agents` calls `this.workQueue.getAgentEvents()`.
- Method + comment: `src/core/work-queue.ts:66` — `getAgentEvents()` (keep; comment says "for list_agent_tasks").
- Prompts: `prompts/main-agent.md:160`, `prompts/main-agent.cn.md:191` (the "do NOT poll" sentence lists `inspect_agent / list_agent_tasks`).
- Doc: `CLAUDE.md:54` (Agent-interaction tool list).
- Tests: `test/core/main-agent.test.ts:1255` — `describe("list_agent_tasks tool", ...)` (2 cases).

Rules:
- MUST remove the `list_agent_tasks` entry from `TOOL_DEFINITIONS` and its `case` from `executeTool` — the tool no longer appears in the LLM tool set (count 17 → 16).
- MUST keep `WorkQueue.getAgentEvents()` (still called by `wait_for_agents`); only reword its doc comment to reference `wait_for_agents`.
- In both prompts, drop `list_agent_tasks` from the "do NOT poll" sentence, leaving `inspect_agent`.
- Remove the `list_agent_tasks tool` describe block in `main-agent.test.ts`; snapshot coverage lives in `wait-for-agents.test.ts`.

### Edge Cases & Errors
| Condition | Behavior |
|---|---|
| LLM still emits `list_agent_tasks` after removal | falls through to `default` case → `{ output: "Unknown tool: list_agent_tasks", terminal: false }` (existing default at the bottom of `executeTool`); loop continues, no crash |
| `wait_for_agents` needs queued events | unchanged — `getAgentEvents()` retained |

### Acceptance Criteria
- `grep -rn "list_agent_tasks" src/ prompts/ CLAUDE.md` -> only the (reworded) `work-queue.ts` comment, or zero hits — no tool definition, handler `case`, prompt instruction, or doc list item remains.
- `TOOL_DEFINITIONS.length` is `16`; both `wait_for_agents` and `inspect_agent` are still present.
- Given the LLM calls `list_agent_tasks` post-removal, when `executeTool` runs, then it returns `Unknown tool: list_agent_tasks` with `terminal: false` (does not throw).
- `npm test` is green after deleting the obsolete describe block.

---

## C2 — Suppress spurious `aborted` callback on intentional cleanup

### Behavior Contract
Anchors:
- `TaskInfo`: `src/core/agent-monitor.ts:7` (interface; add one optional field).
- `cleanup()`: `src/core/agent-monitor.ts:125`; `shutdown()`: `src/core/agent-monitor.ts:134` — both call `task.abortController.abort()` (lines 128, 136).
- Abort branch: `src/core/agent-monitor.ts:151` — `if (task.abortController.signal.aborted) { fireCallback(task, "aborted", ...); ... }`.
- Callers of `cleanup()`: `src/core/main-agent.ts:1186` (`interrupt_agent`) and `src/core/main-agent.ts:637` (`cleanupAgent` → `kill_agent` single/all).

Decision (from code): `abortController.abort()` is invoked **only** by `cleanup()` and `shutdown()`, both intentional, and no test asserts the `aborted` callback — so the `aborted` settle callback is always post-hoc and unwanted.

Signature delta: add `suppressSettleCallback?: boolean` to `TaskInfo`.

Rules:
- `cleanup(agentId)` and `shutdown()` MUST set `task.suppressSettleCallback = true` **before** calling `task.abortController.abort()`.
- The polling abort branch MUST NOT call `fireCallback(..., "aborted", ...)` when `task.suppressSettleCallback` is true; it MUST still delete the task from `tasks`/`paneTargets` and return.
- No other status path (`completed` / `error` / `waiting_input` / `timeout`) changes.

### Edge Cases & Errors
| Condition | Behavior |
|---|---|
| `interrupt_agent`, then the poll observes the abort | task removed silently; NO `agent_event` with status `aborted` enqueued |
| `kill_agent` (single or `"all"`) | same — no trailing `aborted` event |
| `shutdown()` during active tasks | same — no `aborted` events on server stop |
| genuine completion / error / timeout (no abort) | unchanged — callback fires normally |

### Acceptance Criteria
- Given a running task, when `AgentMonitor.cleanup(agentId)` runs and the poll subsequently sees the abort, then `WorkQueue` receives **no** `agent_event` with `status: "aborted"` for that `agentId`.
- Given a running task that settles normally (never aborted), when it completes, then a `completed` `agent_event` is still enqueued (regression guard).
- Given `interrupt_agent`, the synchronous tool result is unchanged: `Agent <id> interrupted. You can now send a new instruction with send_to_agent.`

---

## C3 — Disambiguate the two memory-tool descriptions

### Behavior Contract
Anchors:
- `memory_edit` definition: `src/core/main-agent.ts:192` (description string at 193–194).
- `persistent_memory` definition: `src/core/main-agent.ts:295` (description string at 296–297).

Rules (text-only; no parameter/handler/behavior change):
- The `memory_edit` description MUST state it edits the **searchable `memory/*.md` store** and point to `persistent_memory` for the always-in-prompt `MEMORY.md`.
- The `persistent_memory` description MUST (near its start) point to `memory_edit` / `memory_search` for the searchable store, so the contrast is visible from either tool.

### Acceptance Criteria
- `memory_edit` description contains a reference to `persistent_memory` and the phrase distinguishing the searchable `memory/*.md` store.
- `persistent_memory` description contains a reference to `memory_edit` (searchable store).
- No change to either tool's `parameters` schema or handler; `test/core/memory-tools.test.ts` stays green.

## Notes & Assumptions
- `aborted` stays a member of the `AgentEvent` status union (`src/core/work-queue.ts:6`) for type stability even though it is no longer emitted.
- This bundle is the v2.3.6 follow-up to the v2.3.5 `wait_for_agents` work; ship as one change.
