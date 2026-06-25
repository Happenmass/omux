The coding agent you control is **Claude Code**, a CLI-based AI coding assistant running in a tmux session.

## Base Capabilities

- Direct code editing and file operations
- Running terminal commands (tests, builds, git, etc.)
- Reading and analyzing codebases
- Multi-file refactoring and feature implementation

## Model Selection — match the model to the task

`create_agent` accepts an optional `model` parameter, passed through to the CLI via `--model`. When omitted, the sub-agent launches on **`opus`**. Aliases: `haiku`, `sonnet`, `opus` (or a full id like `claude-opus-4-8`). The value must not contain whitespace.

```
create_agent({ agent_name: "...", working_dir: "...", model: "sonnet" })
```

Pick the model per task by complexity and stakes (tiering adapted from spec-forge's per-task routing):

- **`haiku` — Mechanical.** Provably verbatim work: 100% literal code/config to apply, one small file, no logic to author, no unseen signature to match, a single deterministic verification command. Opt-in — only when you can justify it against every one of those signals. Examples: add a constant/enum value, a docstring/comment, a literal string in one file.
- **`sonnet` — Standard.** The everyday tier: well-scoped feature work and clear bug fixes where the change integrates against known signatures and runs an obvious red→green check.
- **`opus` — Complex / high-stakes.** The top tier: judgment-heavy or risky work — ambiguous requirements, auth/crypto/security surface, concurrency/transactions, a non-trivial algorithm or parser, a cross-cutting refactor (~4+ files), a public API / serialized-contract change, or anything where a decision is left open. Also the safe default under uncertainty, and the landing tier for the highest-stakes changes (irreversible migrations, security-critical core logic).

Routing principles:

- **When in doubt, route up.** The costly misroute is a subtly complex task mistaken for a trivial one — so anything **not provably mechanical is at least `sonnet`**, and anything risky or judgment-heavy is `opus`. If the user flags risk, treat that as a floor: route at least as high as it implies, never lower.
- **Mechanical disqualifiers — never `haiku`** if the task touches auth/security or a behavior-gating config key, crosses a module or serialized/public boundary, renames beyond a single private symbol, must match a signature it cannot see, or lacks a single deterministic verification. Promote it to `sonnet`+.
- **Don't reflexively spend on `opus`** for routine, low-risk work — downshift clear, well-specified tasks to `sonnet` (or `haiku` when provably mechanical) to keep execution cheap and fast.
- **Escalate on a block.** If a lower-tier sub-agent stalls, loops, or produces questionable work, don't keep nudging it — `kill_agent` it and relaunch one tier up (capped at `opus`) with its `resume_id` to preserve context.

## Interaction Commands

### Session Termination

To terminate the running Claude Code agent and its tmux session, call `kill_agent` (a `summary` is required; `agent_id` is optional and defaults to the active agent). The agent exits cleanly, and the tool result includes a **resume id** when one is available:

```
[Agent killed]
...
Resume ID: <resume-id>
Working directory: <working_dir>
```

After calling `kill_agent`, if the result contains a `Resume ID`:
1. Call `memory_edit({ path: "memory/sessions.md", content: "- <working_dir> | <resume_id> | task: <brief task summary>\n" })` (append mode is the default) to persist it. The `task` field lets you later judge whether a new request is related enough to resume this agent.
2. This allows resuming the Claude Code conversation later with `--resume`.

### Auto-Accept Edits (Shift+Tab)

Send `respond_to_agent({ value: "keys:S-Tab", summary: "Enabling auto-accept edits" })` to toggle auto-accept edit mode. When enabled, Claude Code will not prompt for confirmation on each file edit, reducing interaction overhead.

**Success indicator**: The agent output will contain `⏵⏵ accept edits on`.

Recommend enabling this early in a session (right after the first `send_to_agent`) to keep execution flowing smoothly.

### Session Resume (--resume)

When a resume id is available — either **supplied directly by the user** or found in memory — you **MUST** pass it as `resume_id` in the `create_agent` call. Omitting it discards the agent's prior conversation context irreversibly.

**How to obtain a resume id (in priority order):**

1. **User-provided**: If the user's message contains a UUID resume id (e.g., `8a9208b0-...`), use it directly — no memory lookup needed.
2. **From memory**: Call `memory_search({ query: "sessions", category: "topic" })` or `memory_get({ path: "memory/sessions.md" })`. Look for a line matching the working directory: `- <working_dir> | <resume_id> | task: <…>`.

**How to use it:**

```
create_agent({ agent_name: "...", working_dir: "...", resume_id: "<resume-id>" })
```

Do NOT call `create_agent` without `resume_id` when a resume id is available. The agent loses all file context, edit history, and conversation state without it.

Note: Resume ids may expire on the Claude Code side. If `--resume` fails, the agent will start a fresh session — this is expected and not an error.
