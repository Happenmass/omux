# Execution Evidence Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor execution event emission so tool call cards show immediately as settled with a pane snapshot, and agent callbacks appear as separate `agent_callback` cards.

**Architecture:** Two independent changes — (1) `session-monitor.ts` gains `status`/`durationSeconds` on `SettledEvent` and changes toolName to `"agent_callback"`; (2) `main-agent.ts` removes `planned` emits from `send_to_agent`/`respond_to_agent` and replaces them with immediate `settled` emits that include a pane snapshot after dispatch. No frontend changes needed.

**Tech Stack:** TypeScript, Vitest, Node ESM

---

### Task 1: Update `SettledEvent` type and `fireSettledEvent` in `session-monitor.ts`

**Files:**
- Modify: `src/core/session-monitor.ts`
- Test: `test/core/session-monitor.test.ts`

- [ ] **Step 1: Write failing tests for updated `SettledEvent` shape**

In `test/core/session-monitor.test.ts`, find the `describe("onSettled")` block (around line 332) and update the two existing assertions for `event.toolName` and `event.summary`, and add assertions for `event.status` and `event.durationSeconds`:

```typescript
// In the "should fire for completed status" test, change:
expect(event.toolName).toBe("send_to_agent");
// To:
expect(event.toolName).toBe("agent_callback");
expect(event.status).toBe("completed");
expect(event.durationSeconds).toBeGreaterThanOrEqual(0);
// And update summary assertion — new format: "<original summary> — completed (<N>s)"
expect(event.summary).toMatch(/Fix the bug — completed \(\d+s\)/);
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
npx vitest run test/core/session-monitor.test.ts
```

Expected: FAIL — `expect(event.toolName).toBe("agent_callback")` fails (actual: `"send_to_agent"`)

- [ ] **Step 3: Add `status` and `durationSeconds` to `SettledEvent` interface**

In `src/core/session-monitor.ts`, update the interface (around line 32):

```typescript
export interface SettledEvent {
  runId: string;
  toolName: string;
  summary: string;
  status?: string;
  durationSeconds?: number;
  pane?: ExecutionPaneSnippet;
  workspace?: ExecutionWorkspaceEvidence;
  test?: ExecutionTestEvidence;
  verification?: ExecutionVerificationEvidence;
}
```

- [ ] **Step 4: Update `fireSettledEvent` signature and body**

In `src/core/session-monitor.ts`, update `fireSettledEvent` (around line 247) to accept status and duration and use `toolName: "agent_callback"`:

```typescript
private fireSettledEvent(task: TaskInfo, content: string, status: string, durationSeconds: number): void {
  if (!this.onSettled) return;

  const contentLines = content.split("\n");
  const lastLines = contentLines.slice(-100);
  let snippet = lastLines.join("\n");
  if (snippet.length > 10000) {
    snippet = snippet.slice(-10000);
  }

  const pane: ExecutionPaneSnippet = {
    content: snippet,
    lines: lastLines.length,
    capturedAt: Date.now(),
  };

  const event: SettledEvent = {
    runId: task.taskId,
    toolName: "agent_callback",
    summary: `${task.summary} — ${status} (${durationSeconds}s)`,
    status,
    durationSeconds,
    pane,
  };

  this.onSettled(event);
}
```

- [ ] **Step 5: Update callers of `fireSettledEvent` in `startPolling`**

In `startPolling` (around line 161), two call sites need the new arguments:

```typescript
// Timeout branch (around line 192):
this.fireSettledEvent(task, result.content, "timeout", duration);

// Terminal states branch (around line 199):
this.fireSettledEvent(task, result.content, status, duration);
```

- [ ] **Step 6: Run tests and confirm they pass**

```bash
npx vitest run test/core/session-monitor.test.ts
```

Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add src/core/session-monitor.ts test/core/session-monitor.test.ts
git commit -m "feat(session-monitor): agent_callback toolName and status/duration on SettledEvent"
```

---

### Task 2: Refactor `send_to_agent` in `main-agent.ts`

**Files:**
- Modify: `src/core/main-agent.ts`
- Test: `test/core/main-agent.test.ts`

- [ ] **Step 1: Update the existing execution_event test**

In `test/core/main-agent.test.ts`, find the test `"should broadcast execution_event planned phase for create_session and send_to_agent"` (around line 430).

Change the assertion for `send_to_agent` from `phase: "planned"` to `phase: "settled"`, and update the test name:

```typescript
it("should broadcast execution_event settled phase for send_to_agent (immediate)", async () => {
  const agent = setupAgent(
    [
      toolCallResponse("create_session", {}, "tc0"),
      toolCallResponse("send_to_agent", { prompt: "add auth", summary: "Adding JWT auth" }, "tc1"),
      toolCallResponse("mark_complete", { summary: "Done" }, "tc2"),
    ],
    {},
    { withMonitor: true },
  );

  await agent.handleMessage("add auth");

  const executionEvents = mockBroadcaster.broadcast.mock.calls
    .map((call: any) => call[0])
    .filter((message: any) => message.type === "execution_event");

  expect(executionEvents.length).toBeGreaterThanOrEqual(2);
  expect(executionEvents).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "execution_event",
        event: expect.objectContaining({
          toolName: "create_session",
          phase: "planned",
        }),
      }),
      expect.objectContaining({
        type: "execution_event",
        event: expect.objectContaining({
          toolName: "send_to_agent",
          phase: "settled",
        }),
      }),
    ]),
  );
});
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
npx vitest run test/core/main-agent.test.ts -t "settled phase for send_to_agent"
```

Expected: FAIL — actual phase is `"planned"`

- [ ] **Step 3: Refactor `send_to_agent` tool implementation**

In `src/core/main-agent.ts`, find the `send_to_agent` case (around line 1133). Replace the current `planned` emit block and the dispatch block with:

```typescript
const runId = this.createExecutionRunId(name);
this.emitUiEvent("agent_update", summary);

const sendPreHash = await this.stateDetector.captureHash(sendSession.paneTarget);
await this.adapter.sendPrompt(this.bridge, sendSession.paneTarget, prompt);

// Capture pane snapshot immediately after dispatch
let paneContent = "";
try {
  const capture = await this.bridge.capturePane(sendSession.paneTarget, { startLine: -50 });
  paneContent = capture.content;
} catch {
  paneContent = "(failed to capture pane)";
}

this.emitExecutionEvent({
  runId,
  phase: "settled",
  toolName: name,
  summary,
  workspace: { workingDir: sendSession.workingDir, available: false, changedFiles: [] },
  pane: { content: paneContent, lines: paneContent.split("\n").length, capturedAt: Date.now() },
});

if (this.sessionMonitor) {
  const result = this.sessionMonitor.dispatch(sendSessionId, sendSession.paneTarget, {
    preHash: sendPreHash,
    summary,
    taskContext: prompt,
  });

  if (result.dispatched) {
    return {
      output: `Task dispatched. task_id: ${result.task.taskId}, session: ${sendSessionId}.\nYou will receive a callback when the agent finishes.`,
      terminal: false,
    };
  }
  return {
    output: `Session ${sendSessionId} became busy unexpectedly.`,
    terminal: false,
  };
}

return { output: "Error: SessionMonitor not initialized", terminal: false };
```

- [ ] **Step 4: Run tests and confirm they pass**

```bash
npx vitest run test/core/main-agent.test.ts
```

Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/main-agent.ts test/core/main-agent.test.ts
git commit -m "feat(main-agent): send_to_agent emits settled immediately with pane snapshot"
```

---

### Task 3: Refactor `respond_to_agent` in `main-agent.ts`

**Files:**
- Modify: `src/core/main-agent.ts`
- Test: `test/core/main-agent.test.ts`

- [ ] **Step 1: Check for any existing `respond_to_agent` execution_event tests**

```bash
npx vitest run test/core/main-agent.test.ts -t "respond_to_agent"
```

Note the current passing tests — these should still pass after this task.

- [ ] **Step 2: Refactor `respond_to_agent` tool implementation**

In `src/core/main-agent.ts`, find the `respond_to_agent` case (around line 1200). Replace the current `planned` emit block with a `settled` emit after the response is sent and the pane is captured:

```typescript
const runId = this.createExecutionRunId(name);
this.emitUiEvent("agent_update", summary);

await this.adapter.sendResponse(this.bridge, respondSession.paneTarget, value);

if (this.sessionMonitor) {
  // Wait for agent to begin processing the response before capturing hash.
  // Without this delay, captureHash may snapshot the pre-processing state,
  // causing Phase 1 to never see a hash change (stuck until timeout).
  await new Promise((resolve) => setTimeout(resolve, 500));
  const newPreHash = await this.stateDetector.captureHash(respondSession.paneTarget);

  // Capture pane snapshot after response is sent
  let paneContent = "";
  try {
    const capture = await this.bridge.capturePane(respondSession.paneTarget, { startLine: -50 });
    paneContent = capture.content;
  } catch {
    paneContent = "(failed to capture pane)";
  }

  this.emitExecutionEvent({
    runId,
    phase: "settled",
    toolName: name,
    summary,
    workspace: { workingDir: respondSession.workingDir, available: false, changedFiles: [] },
    pane: { content: paneContent, lines: paneContent.split("\n").length, capturedAt: Date.now() },
  });

  const resumed = this.sessionMonitor.resumeTask(respondSessionId, newPreHash);
  if (!resumed) {
    return {
      output: `Error: Failed to resume task monitoring for session ${respondSessionId}.`,
      terminal: false,
    };
  }
  return {
    output: "Response sent, agent continuing execution.",
    terminal: false,
  };
}

return { output: "Error: SessionMonitor not initialized", terminal: false };
```

- [ ] **Step 3: Run all tests**

```bash
npx vitest run
```

Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add src/core/main-agent.ts
git commit -m "feat(main-agent): respond_to_agent emits settled immediately with pane snapshot"
```

---

### Task 4: Final verification

- [ ] **Step 1: Run full test suite**

```bash
npm test
```

Expected: All tests PASS, no TypeScript errors

- [ ] **Step 2: Type check**

```bash
npm run build
```

Expected: Clean compile, no errors
