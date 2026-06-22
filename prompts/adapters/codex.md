The coding agent you control is **Codex**, an OpenAI CLI-based AI coding assistant running in a tmux session.

## Base Capabilities

- Direct code editing and file operations
- Running terminal commands (tests, builds, git, etc.)
- Reading and analyzing codebases
- Multi-file refactoring and feature implementation

## Model Selection

`create_agent` accepts an optional `model` parameter, passed through to the CLI via `--model`. When omitted, the agent launches with the default model **`gpt-5.5`**.

To run a sub-agent on a different model, pass `model` explicitly — e.g. `model: "gpt-5-codex"`, or another model slug the Codex CLI accepts. The value must not contain whitespace.

```
create_agent({ agent_name: "...", working_dir: "...", model: "gpt-5-codex" })
```

## Interaction Commands

### Session Termination

To terminate the running Codex agent and its tmux session, call `kill_agent` (a `summary` is required; `agent_id` is optional and defaults to the active agent). The agent exits cleanly, and the tool result includes a **resume id** when one is available:

```
[Agent killed]
...
Resume ID: <resume-id>
Working directory: <working_dir>
```

After calling `kill_agent`, if the result contains a `Resume ID`:
1. Call `memory_edit({ path: "memory/sessions.md", content: "- <working_dir>: <resumeId>\n" })` (append mode is the default) to persist it.
2. This allows resuming the Codex conversation later with `codex resume`.

### Session Resume (codex resume)

When a resume id is available — either **supplied directly by the user** or found in memory — you **MUST** pass it as `resume_id` in the `create_agent` call. Omitting it discards the agent's prior conversation context irreversibly.

**How to obtain a resume id (in priority order):**

1. **User-provided**: If the user's message contains a UUID resume id (e.g., `019d41a7-...`), use it directly — no memory lookup needed.
2. **From memory**: Call `memory_search({ query: "sessions", category: "topic" })` or `memory_get({ path: "memory/sessions.md" })`. Look for a line matching the working directory: `- <working_dir>: <resume-id>`.

**How to use it:**

```
create_agent({ agent_name: "...", working_dir: "...", resume_id: "<resume-id>" })
```

Do NOT call `create_agent` without `resume_id` when a resume id is available. The agent loses all file context, edit history, and conversation state without it.

Note: Resume ids may expire on the Codex side. If `codex resume` fails, the agent will start a fresh session — this is expected and not an error.
