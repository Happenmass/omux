# Execution Evidence Refactor Design

Date: 2026-03-30
Status: Approved

## Problem

The current execution evidence module has a blocking/lifecycle design that doesn't match the actual async flow:

1. `send_to_agent` emits a `planned` event (creates a card), but it never transitions to `settled` on the same runId — the card hangs indefinitely.
2. `SessionMonitor.fireSettledEvent` emits a separate `settled` event using `task.taskId` as runId — a different card — but its toolName is still `"send_to_agent"`, which is confusing.
3. Neither card shows what was actually sent or the tmux state at dispatch time.

## Goal

- **Tool call card** (`send_to_agent` / `respond_to_agent`): appears immediately after dispatch, shows what was sent + tmux pane snapshot at that moment, phase = `settled` from the start. No planned → settled lifecycle.
- **Agent callback card**: a separate new card created when SessionMonitor fires the callback, showing status + duration + pane tail (last N lines). toolName = `"agent_callback"`.

## Design (Approach A)

### 1. `send_to_agent` tool (main-agent.ts)

**Remove** the `planned` emit.

After `adapter.sendPrompt()`, capture the pane (last 50 lines), then emit a single `settled` event:

```
emitExecutionEvent({
  runId: createExecutionRunId("send_to_agent"),
  phase: "settled",
  toolName: "send_to_agent",
  summary,
  workspace: { workingDir, available: false, changedFiles: [] },
  pane: { content, lines, capturedAt: Date.now() },
})
```

### 2. `respond_to_agent` tool (main-agent.ts)

Same pattern: remove `planned` emit. After `sendResponse()` + 500ms delay + hash capture, emit a single `settled` event with pane snapshot.

### 3. `SettledEvent` type (session-monitor.ts)

Add `status` and `durationSeconds` fields so the callback card can display them:

```typescript
export interface SettledEvent {
  runId: string;
  toolName: string;
  summary: string;
  status?: string;           // "completed" | "error" | "waiting_input" | "timeout"
  durationSeconds?: number;
  pane?: ExecutionPaneSnippet;
  workspace?: ExecutionWorkspaceEvidence;
  test?: ExecutionTestEvidence;
  verification?: ExecutionVerificationEvidence;
}
```

### 4. `fireSettledEvent` (session-monitor.ts)

Change toolName to `"agent_callback"`. Pass `status` and `durationSeconds`. Use `task.taskId` as runId (already unique). Keep pane content (last 100 lines).

```
event = {
  runId: task.taskId,
  toolName: "agent_callback",
  summary: `${task.summary} — ${status} (${durationSeconds}s)`,
  status,
  durationSeconds,
  pane: { content: snippet, lines, capturedAt: Date.now() },
}
```

### 5. `onSettled` callback (main-agent.ts `setupSessionMonitor`)

Pass `status` and `durationSeconds` through to `emitExecutionEvent`:

```
onSettled: (event) => {
  this.emitExecutionEvent({ ...event, phase: "settled" });
}
```

No change needed here — the spread already picks up the new fields, and `emitExecutionEvent` passes them through to the store and broadcaster.

## Files Changed

| File | Change |
|------|--------|
| `src/core/main-agent.ts` | Remove `planned` emits from `send_to_agent` / `respond_to_agent`; add immediate `settled` emit with pane snapshot |
| `src/core/session-monitor.ts` | Add `status`/`durationSeconds` to `SettledEvent`; update `fireSettledEvent` to use `toolName: "agent_callback"` and include these fields |

## Out of Scope

- Frontend card rendering changes: the existing card renders `toolName` in the header and `pane` snippet in the body — `agent_callback` will display correctly with no frontend changes needed.
- workspace evidence (changed files, git diff) for callback cards — not needed per design decision.
- `exec_command`, `memory_write`, and other tools — unaffected.

## Testing

- Existing tests that assert `planned` events for `send_to_agent`/`respond_to_agent` need to be updated to assert `settled` instead.
- Add/update tests for `fireSettledEvent` to assert `toolName === "agent_callback"` and presence of `status`/`durationSeconds`.
