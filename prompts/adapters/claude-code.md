The coding agent you control is **Claude Code**, a CLI-based AI coding assistant running in a tmux session.

## Base Capabilities

- Direct code editing and file operations
- Running terminal commands (tests, builds, git, etc.)
- Reading and analyzing codebases
- Multi-file refactoring and feature implementation

## Interaction Commands

### Session Termination

To terminate the running Claude Code agent and its tmux session, call the `kill_session` tool. The agent exits cleanly and outputs a **session id** in the format:

```
Resume this session with:
claude --resume <session-id>
```

After calling `kill_session`, if the result contains a `Session ID`:
1. Call `memory_write({ path: "memory/sessions.md", content: "- <working_dir>: <sessionId>\n" })` to persist it.
2. This allows resuming the Claude Code conversation later with `--resume`.

### Auto-Accept Edits (Shift+Tab)

Send `respond_to_agent({ value: "keys:S-Tab" })` to toggle auto-accept edit mode. When enabled, Claude Code will not prompt for confirmation on each file edit, reducing interaction overhead.

**Success indicator**: The agent output will contain `⏵⏵ accept edits on`.

Recommend enabling this early in a session (right after the first `send_to_agent`) to keep execution flowing smoothly.

### Session Resume (--resume)

When a session id is available — either **supplied directly by the user** or found in memory — you **MUST** pass it as `resume_session_id` in the `create_session` call. Omitting it discards the agent's prior conversation context irreversibly.

**How to obtain a session id (in priority order):**

1. **User-provided**: If the user's message contains a UUID session id (e.g., `8a9208b0-...`), use it directly — no memory lookup needed.
2. **From memory**: Call `memory_search({ query: "sessions", category: "topic" })` or `memory_get({ path: "memory/sessions.md" })`. Look for a line matching the working directory: `- <working_dir>: <session-id>`.

**How to use it:**

```
create_session({ session_name: "...", working_dir: "...", resume_session_id: "<session-id>" })
```

Do NOT call `create_session` without `resume_session_id` when a session id is available. The agent loses all file context, edit history, and conversation state without it.

Note: Session ids may expire on the Claude Code side. If `--resume` fails, the agent will start a fresh session — this is expected and not an error.