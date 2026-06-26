# Auto-Continue Mode

An opt-in mode where, when the MainAgent's EXECUTING loop reaches a natural completion and is about to hand control back to the user, a single separate LLM "gate" call decides — from the MainAgent's last output and the live sub-agent state — whether the task is actually done. If not, it synthesizes a driver instruction that re-drives the loop; if so, control returns to the user as today. Consumed by `MainAgent`; toggled by the `/autocontinue` slash command, defaulted by config.

## Context & Scope
In scope:
- A gate at the **natural-completion** return-to-idle (text-only response): one `llmClient.complete()` call → `{ continue, reason, driverText }`.
- On `continue`: enqueue `driverText` as the next turn (reusing the existing WorkQueue→dispatch path) so the loop runs again; on stop: return to idle (current behavior).
- A consecutive-continue cap (loop-guard) reset by any real user message.
- `/autocontinue` toggle + `config.autoContinue` default (off).

Out of scope:
- Firing on `mark_failed` / `escalate_to_human` (deliberate hand-backs) or on `wait_for_agents` parking (already driven by sub-agent callbacks). The gate runs **only** on the text-only natural-completion paths.
- Per-agent or scheduled continuation. (Not built.)
- Auto-continuing past the cap. (Hard stop → idle; the cap is the safety floor.)
- Changing the IDLE↔EXECUTING state machine or the callback/parking mechanism.

## Behavior Contract
Anchor (core, NEW method on `MainAgent`): `src/core/main-agent.ts` — add `maybeAutoContinue` and call it at the three text-only `setState("idle")` sites:
- `executeToolLoop` self-loop exit — `src/core/main-agent.ts:879-886` (the `nextToolCalls.length === 0` branch).
- `processUserMessage` pure-text — `src/core/main-agent.ts:944-949`.
- `processAgentEventItem` pure-text/empty — `src/core/main-agent.ts:976-983`.
Anchor (excluded, do NOT hook): terminal-tool idle at `src/core/main-agent.ts:847-849`; stopRequested idle at `src/core/main-agent.ts:855-863`.
Anchor (counter reset): `handleMessage` at `src/core/main-agent.ts:691` (`this.workQueue.enqueueUserMessage(content)`).
Anchor (gate call): `LLMClient.complete(messages, opts)` — `src/llm/client.ts:73`.
Anchor (snapshot source): `AgentMonitor.getAllTasks()` (`src/core/agent-monitor.ts:121`) + `WorkQueue.getAgentEvents()` (`src/core/work-queue.ts:67`).
Anchor (enqueue path): `WorkQueue.enqueueUserMessage(content)` (`src/core/work-queue.ts:20`).

Signature: `private async maybeAutoContinue(lastText: string): Promise<boolean>`
Inputs:
- `lastText` (string) — the MainAgent's final assistant text for this turn; may be `""` (empty on an agent-event turn that produced no text).
Output:
- `boolean` — `true` when a `driverText` was enqueued (the loop will continue via dispatch); `false` otherwise. **Caller calls `setState("idle")` regardless** — `true` just means a queued message will immediately re-drive it.

New `MainAgent` state (private fields + accessors):
- `autoContinueEnabled` (boolean) — runtime flag; initialized from `config.autoContinue.enabled`.
- `autoContinueMax` (number) — from `config.autoContinue.maxConsecutive`.
- `autoContinueCount` (number) — consecutive auto-continues since the last real user message; starts 0.
- `setAutoContinueEnabled(on: boolean): boolean` — sets the flag, returns the new value.
- `isAutoContinueEnabled(): boolean`.

Rules:
- MUST short-circuit to `false` **without** an LLM call when any holds: `!autoContinueEnabled`; `signalRouter.isStopRequested()`; `autoContinueCount >= autoContinueMax`; `workQueue.pendingUserMessages() > 0` (a real user message is waiting — defer to the human).
- The gate call MUST be a standalone `llmClient.complete()` with the `auto-continue` prompt and a user payload carrying `lastText` plus the sub-agent snapshot (each active task's `agentId`/`status`/elapsed/`summary`, plus pending agent-event statuses). It MUST NOT expose the MainAgent tool set (text→JSON only).
- The gate result MUST be parsed as `{ continue: boolean, reason: string, driverText: string }`. On parse failure, retry once; on a second failure, treat as `continue: false` (fail safe → hand back to the user, never loop on a malformed gate).
- MUST return `true` **only** when `continue === true` AND `driverText.trim() !== ""`; in that case it MUST, in order: increment `autoContinueCount`, `broadcast({ type: "system", message: "🔄 自动继续 (<count>/<max>): <reason>" })`, and `workQueue.enqueueUserMessage(driverText)`.
- `handleMessage` MUST reset `autoContinueCount = 0` (a real user message ends any auto-continue streak).
- The three hook sites call `await this.maybeAutoContinue(textContent)` immediately before their existing `this.setState("idle")` (which is retained). No other idle path is touched.

## Data / State / Side Effects
- External call: one extra billable `llmClient.complete()` per gate evaluation (only when the mode is enabled and not short-circuited).
- Writes: appends a synthesized user message to the WorkQueue and (via the ensuing turn) to the conversation/context as a normal `user` message.
- Invariant: with the mode **off**, behavior is byte-identical to today (the method returns `false` before any call or enqueue).
- Loop-guard: at most `autoContinueMax` consecutive auto-continues without human input; `handleMessage` resets the streak. Not idempotent — each gate call is a fresh decision.

## Edge Cases & Errors
| Condition | Behavior |
|---|---|
| mode disabled | `false`, no LLM call, no enqueue (identical to current behavior) |
| `/stop` pending (`isStopRequested()`) | `false`, no gate — stop wins |
| a real user message already queued | `false`, no gate — defer to the user |
| `autoContinueCount >= autoContinueMax` | `false`, no gate; broadcast `system` "已达自动继续上限，交还控制权" once, then idle |
| gate returns `continue:false` | `false`; return to idle (hand back to user) |
| gate returns `continue:true` but empty `driverText` | `false` (treated as stop — nothing actionable to inject) |
| gate JSON unparseable twice | `false` (fail safe); log a warning |
| `lastText` is `""` (agent-event turn, no text) | gate still runs on the sub-agent snapshot alone |
| terminal tool (`mark_failed`/`escalate_to_human`) | gate never runs (those sites are not hooked) |
| `wait_for_agents` parking | gate never runs (parking is `terminal`, not a natural-completion text path) |

## Acceptance Criteria
- Given mode **off**, when a turn finishes text-only, then `maybeAutoContinue` returns `false`, `llmClient.complete` is **not** called, and the WorkQueue is unchanged.
- Given mode **on** and a gate stub returning `{continue:true, reason:"tests not run", driverText:"Run the test suite and report results"}`, when a turn finishes text-only, then `autoContinueCount` becomes `1`, a `system` broadcast contains `自动继续 (1/`, and `workQueue` holds one user message `"Run the test suite and report results"`.
- Given mode **on** and a gate stub returning `{continue:false, reason:"done", driverText:""}`, when a turn finishes, then it returns `false` and the WorkQueue is empty.
- Given mode **on** and `autoContinueCount === autoContinueMax`, when a turn finishes, then `llmClient.complete` is **not** called and it returns `false`.
- Given mode **on** but `signalRouter.isStopRequested()` is true, when a turn finishes, then no gate call and it returns `false`.
- Given an auto-continue streak of 3, when `handleMessage("...")` is called, then `autoContinueCount` resets to `0`.
- Given the gate stub returns non-JSON twice, when a turn finishes, then it returns `false` and no message is enqueued.

## Dependencies & Integration Points
- **Config** — `src/utils/config.ts`: add `interface AutoContinueConfig { enabled: boolean; maxConsecutive: number }`, field `autoContinue: AutoContinueConfig` on `CliclawConfig` (after `learning`, `:107`), `DEFAULT_CONFIG.autoContinue = { enabled: false, maxConsecutive: 10 }` (after `:165`), and a merge line `autoContinue: { ...DEFAULT_CONFIG.autoContinue, ...userConfig.autoContinue }` in `loadConfig` (after `:207`).
- **Constructor wiring** — `MainAgent` constructor gains `autoContinue?: { enabled: boolean; maxConsecutive: number }`; the construction site at `src/main.ts:789` (`const mainAgent = new MainAgent({ … })`) passes `autoContinue: config.autoContinue` (alongside `thinking: config.llm.thinking ?? "off"` at `src/main.ts:806`).
- **Slash command** — `src/server/command-router.ts`: add `{ name: "autocontinue", description: "切换 auto-continue 自动续跑模式", category: "builtin" }` to `BUILTIN_COMMANDS` (`:16`), a `case "autocontinue": return this.handleAutoContinue();` in `handle()` (`:87`), and `handleAutoContinue()` that flips `mainAgent.setAutoContinueEnabled(!mainAgent.isAutoContinueEnabled())` and broadcasts `auto-continue 已开启/已关闭`. Commands are argless (`handle(name)` at `ws-handler.ts:80`), so this is a toggle.
- **Prompt** — `prompts/auto-continue.md` (+ `.cn.md` for zh-CN): system prompt defining the gate. It MUST instruct: output strict JSON `{ continue, reason, driverText }`; `continue:true` only when the original task is clearly unfinished AND a concrete next step exists; `driverText` = the instruction to hand the MainAgent to proceed; `continue:false` for completed tasks, pure conversational replies, or when genuine human input is required. Loaded via `PromptLoader` (auto-picks `.cn.md` under zh-CN).
- **Docs** — `CLAUDE.md`: add `/autocontinue` to the CommandRouter handled-commands list and note `config.autoContinue.*`.

## Notes & Assumptions
- **Upper edge of quick-spec.** This spans ~5 files, but the only judgment-heavy logic is `maybeAutoContinue` + the gate prompt; the rest is established repo boilerplate (a config flag like `learning.enabled`, an argless command like `/stop`). No new state machine, schema, or service boundary — the loop-guard counter and gate are guards on the existing dispatch path. If implementation reveals a genuine state machine forming, escalate to full-spec.
- The synthesized `driverText` enters context as a normal `user` message (no new WorkItem kind); the `system` broadcast provides user-visible transparency that it was auto-generated.
- The gate is intentionally a **separate** completion (no tool surface), mirroring the `state-analyzer` / `learning-summarizer` pattern — it does not ride the main turn's prompt cache.
- Assumes `config.autoContinue` is threaded to `MainAgent` at construction; if the bootstrap doesn't pass it, the mode defaults to disabled (safe).
