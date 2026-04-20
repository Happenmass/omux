# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is Cliclaw

Cliclaw is a chat-based meta-orchestrator that commands coding agents (like Claude Code) via tmux. It runs as a persistent HTTP + WebSocket server with a web chat UI. The MainAgent can hold natural conversations and autonomously execute complex development tasks by commanding coding agents in tmux sessions.

Core flow: **Chat message → MainAgent (IDLE ↔ EXECUTING state machine) → Streaming LLM → Tool execution in tmux → Response via WebSocket**

## Commands

```bash
npm run build          # tsc — compile to dist/
npm run dev            # tsc --watch
npm test               # vitest run — all tests
npm run test:watch     # vitest — watch mode
npx vitest test/core/main-agent.test.ts   # run a single test file
npm run check          # biome check src/
npm run format         # biome format --write src/
npm start              # node dist/main.js — starts the server on port 3120
```

## Code Style

- **Formatter**: Biome — tabs, indent width 3, line width 120
- **Module system**: ESM (`"type": "module"` in package.json)
- **TypeScript**: strict mode, target ES2022, module Node16
- **Imports**: use `.js` extension in relative imports (Node16 module resolution)
- `noExplicitAny: off`, `noNonNullAssertion: off` — these are intentionally relaxed
- Use `useConst: error` — always prefer `const`

## Architecture

### Entry Point (`src/main.ts`) and CLI (`src/cli.ts`)
`cli.ts` exports `parseCliArgs()` for CLI argument parsing (--agent, --provider, --model, --base-url, --port, --cwd, etc.) and `printHelp()`/`printVersion()`. `main.ts` orchestrates startup:
1. **Bootstrap** — MemoryStore (SQLite), EmbeddingProvider (auto-fallback), initial memory file sync, skill discovery → filter → registry, ConversationStore initialization, CommandRegistry setup
2. **Restore** — If SQLite has existing messages, restore conversation into ContextManager
3. **Serve** — Start Express + WebSocket server on configurable port (default 3120)
4. **Shutdown** — SIGINT/SIGTERM triggers graceful shutdown (stop agent → close server → close DB)

Subcommands: `config`, `doctor`, `init`, `remember` are handled before server startup.

### MainAgent (`src/core/main-agent.ts`)
Chat-driven decision engine with a two-state machine: **IDLE** ↔ **EXECUTING**.

- **IDLE**: Waits for user messages via `handleMessage(content)`. Streams LLM response. If LLM returns tool calls → transitions to EXECUTING. If pure text → stays IDLE.
- **EXECUTING**: Self-loop executing tool calls. Between rounds: checks `stopRequested`, drains `MessageQueue` (human messages queued during execution), checks context thresholds. Terminal tools (`mark_failed`, `escalate_to_human`) return to IDLE. When the LLM responds with text only (no tool calls), it naturally returns to IDLE.

Uses `llmClient.stream()` for all LLM calls — text deltas are broadcast to WebSocket clients in real-time.

Emits events: `state_change`, `log`. Built-in tools:
- `send_to_agent` / `respond_to_agent` — interact with coding agent in tmux (both have required `summary` parameter for chat UI updates)
- `inspect_agent` — capture agent pane content and task status
- `list_agent_tasks` — list active sub-agent tasks and pending events
- `mark_failed` — terminal: return to IDLE
- `escalate_to_human` — terminal: request human intervention
- `memory_search` / `memory_get` — hybrid search and read memories
- `memory_edit` — edit memory files (modes: append, overwrite, replace, delete). `memory_write` is a backwards-compatible alias
- `persistent_memory` — read/update global and project MEMORY.md (sections: user_profile, project_conventions, key_decisions, people_and_context, active_notes)
- `read_skill` — read full SKILL.md content on demand
- `create_agent` — create a `cliclaw-` prefixed tmux session and launch agent
- `list_agents` — list all `cliclaw-` prefixed agents
- `kill_agent` — gracefully exit agent, destroy tmux session, and clean up registry; returns resume id; supports "all"
- `exec_command` — execute read-only bash commands for reconnaissance

### Server Layer (`src/server/`)
HTTP + WebSocket server for the chat interface.

- `index.ts` — Express app creation, static file serving (`web/`), REST API (`/api/history`, `/api/status`), WebSocket server on `/ws` path. `startServer()` returns a `ServerInstance` with a `close()` method.
- `chat-broadcaster.ts` — Manages WebSocket client connections. `broadcast(message)` sends to all connected clients. Used by MainAgent to push `assistant_delta`, `assistant_done`, `agent_update`, `tool_activity`, `state`, `system`, `clear` messages.
- `ws-handler.ts` — Handles individual WebSocket connections. Routes `{ type: "message" }` to `MainAgent.handleMessage()` and `{ type: "command" }` to `CommandRouter`. Sends current state on connect.
- `command-router.ts` — Handles slash commands (`/stop`, `/resume`, `/clear`, `/reset`, `/compact`, `/context`, `/tidy`). `/tidy` uses LLM to review memory files and archive outdated entries. Receives optional `llmClient`, `promptLoader`, `memoryStore`, `syncMemory` dependencies for commands that need LLM access.
- `command-registry.ts` — Central registry for slash command metadata (`CommandDescriptor`). Stores both built-in and skill-declared commands. Methods: `register()`, `registerMany()`, `get()`, `has()`, `getAll()`, `search()`. Skills can dynamically register commands at startup.
- `message-queue.ts` — Simple FIFO queue for human messages received during EXECUTING state. Drained between tool-use rounds.

### Persistence (`src/persistence/`)
- `conversation-store.ts` — SQLite persistence for chat messages and context state. Two tables in `~/.cliclaw/cliclaw.db`:
  - `chat_messages` — role, content (JSON-serialized), tool_call_id, created_at
  - `chat_context_state` — key-value store for compressed_history, compaction_count, etc.
  - Methods: `saveMessage()`, `loadMessages()`, `saveContextState()`, `loadContextState()`, `clearAll()`, `getMessageCount()`
- `agent-store.ts` — SQLite persistence for agent sessions: session_id, pane_target, working_dir, taken_over flag

### ContextManager (`src/core/context-manager.ts`)
Modular system prompt with replaceable sections (`{{compressed_history}}`, `{{memory}}`, `{{agent_capabilities}}`). Two-layer context guard:

- **Layer 2 — Memory Flush** (60% threshold): extracts valuable insights from conversation and persists to memory files via `memory-flush.md` prompt
- **Layer 3 — Compression** (70% threshold): compresses conversation history, resets context, re-injects POST_COMPACTION_CONTEXT

Supports conversation persistence:
- `addMessage()` auto-persists to SQLite when ConversationStore is configured
- `restore(store)` rebuilds conversation state from SQLite on server restart
- `clear()` runs memory flush → clears memory state → clears SQLite
- `compress()` persists compressed_history and compaction_count to SQLite after compression

Uses hybrid token counting: last-known API count + pending character estimation.

### SignalRouter (`src/core/signal-router.ts`)
Provides execution control for the MainAgent loop:
- `stop()` — sets `_stopRequested = true`, checked between tool-use rounds
- `resume()` — clears `_stopRequested`
- `isStopRequested()` — query current state

Also aggregates StateDetector results into typed signals for tmux agent monitoring.

### StateDetector (`src/tmux/state-detector.ts`)
Polls tmux pane content, computes content hashes, and classifies agent state (active, waiting_input, completed, error) using pattern matching. Falls back to LLM analysis for ambiguous states. Has a cooldown mechanism to avoid excessive polling.

### Memory Module (`src/memory/`)
Dual-storage architecture: Markdown files are the source of truth, SQLite is the search index (rebuildable).

- `store.ts` — SQLite backend with WAL mode, schema v2 (no project column), auto-migration from v1. Tables: meta, files, chunks, chunks_vec_*, chunks_fts, embedding_cache. `edit()` method supports 4 modes: append, overwrite, replace, delete. `write()` is a backwards-compatible alias.
- `search.ts` — hybrid search: vector KNN (sqlite-vec) + keyword BM25 (FTS5), weighted merge (0.7/0.3), time decay
- `embedder.ts` — embedding provider factory supporting OpenAI, Gemini, Voyage, Mistral, local (Qwen3-Embedding via node-llama-cpp); auto-fallback chain with retry and caching
- `chunker.ts` — Markdown chunking (configurable tokens/overlap, default 400/80)
- `sync.ts` — incremental file-to-SQLite sync via content hash tracking, embedding model change detection triggers full re-sync
- `category.ts` — 6 categories (core, preferences, people, todos, daily, topic) inferred from file path
- `types.ts` — shared types: `MemoryChunk`, `MemorySearchResult`, `EmbeddingProvider`, `HybridSearchConfig`

### Learning Sessions (`src/core/learning-*.ts` + `src/core/change-tracker.ts` + `src/core/prompt-tracker.ts`)
Per-sub-agent change tracking with isolated learning chat. Lifecycle driven by MainAgent's `create_agent` / `send_to_agent` / `respond_to_agent` / `kill_agent` hooks — no new agent-facing tools.

- `change-tracker.ts` — captures git baseline at agent launch (commit SHA, or `git stash create` tree for dirty worktrees to avoid stash-stack pollution). Computes unified diff at kill, including untracked files (synthesized new-file diffs respecting `.gitignore`).
- `learning-store.ts` — SQLite CRUD over `learning_entries` / `learning_messages` tables (same DB as `ConversationStore`). Raw diff stored at `~/.cliclaw/learning/diffs/<id>.diff` on disk; only the path is in SQLite.
- `learning-summarizer.ts` — calls `llmClient.complete()` with `prompts/learning-summary.md`; one retry on JSON parse failure, skeleton fallback on second failure.
- `prompt-tracker.ts` — per-sub-agent prompt accumulator. MainAgent records each prompt/response sent to a sub-agent; pipeline retrieves the list at kill time.
- `learning-pipeline.ts` — orchestrator. `ingestAgentKill` is error-isolated: any failure is caught and logged so kill path is never blocked. Also supports `merge` (combines multiple active entries, archives originals), `regenerate` (re-runs summarizer on stored diff), `flushToMemory` (writes `memory/learning/<id>.md` via `MemoryStore.edit`).
- `learning-chat.ts` — per-entry chat streaming with `Map<entryId, AbortController>`. Concurrent messages on same entry rejected; different entries may stream in parallel. Context is isolated from MainAgent — no memory flush, no compaction.
- REST: `GET /api/learning`, `GET /api/learning/:id`, `GET /api/learning/:id/diff`, `GET /api/learning/:id/messages`, `PATCH /api/learning/:id`, `POST /api/learning/merge`, `POST /api/learning/:id/regenerate`, `POST /api/learning/:id/flush-to-memory`, `DELETE /api/learning/:id`.
- WebSocket client→server: `learning_message`, `learning_stop`. Server→client: `learning_entry_created`, `learning_entry_updated`, `learning_entry_deleted`, `learning_delta`, `learning_done`, `learning_error`.
- UI: right-side panel split into entries list (top 1/3) and detail pane (Summary / Chat tabs, bottom 2/3). Frontend in `web/learning.js` as an ES module.

### Skill System (`src/skills/`)
Extensible capability system allowing agents to contribute domain-specific tools and prompts.

- `discovery.ts` — discovers skills from adapter and workspace directories (workspace overrides adapter), limit 50
- `filter.ts` — conditional activation based on disabled list, file existence, OS, env vars
- `parser.ts` / `reader.ts` — YAML frontmatter parsing from SKILL.md files
- `registry.ts` — lookup by name or tool name
- `injector.ts` — injects skill summaries into MainAgent prompt (budget-aware, max 2000 chars)
- `tool-merge.ts` — merges skill tool definitions into MainAgent's tool set with collision detection
- `types.ts` — three skill types: `agent-capability`, `main-agent-tool`, `prompt-enrichment`

### LLM Layer (`src/llm/`)
- `client.ts` — unified client supporting Anthropic and OpenAI-compatible protocols. Both `complete()` (single response) and `stream()` (async iterable of `LLMStreamEvent`) methods.
- `providers/registry.ts` — 12 built-in providers (OpenAI, Anthropic, DeepSeek, Gemini, Groq, etc.)
- `prompt-loader.ts` — loads markdown prompt templates from `prompts/` with `{{variable}}` interpolation

### Prompts (`prompts/`)
Markdown templates with `{{variable}}` placeholders:
- `main-agent.md` — MainAgent system prompt (chat-mode autonomous decision guidelines, execution paths, memory recall, agent management, skill usage)
- `state-analyzer.md` — ambiguous state classification
- `history-compressor.md` — conversation compression
- `memory-flush.md` — extract decisions/preferences/knowledge from conversation for persistence (uses `memory_edit` tool)
- `memory-tidy.md` — LLM-driven memory file review, outputs structured JSON (retained/archived/summary)
- `error-analyzer.md`, `session-summarizer.md`

### Chat UI (`web/`)
Minimal vanilla HTML/CSS/JS chat interface served by Express as static files.

- `index.html` — page structure: header with status indicator, message list, input area
- `styles.css` — dark theme, message bubbles (user/assistant/agent-update/system), status indicator with idle/executing animation
- `app.js` — WebSocket connection management (connect/reconnect), message routing, streaming delta display, slash command support, basic Markdown rendering, history loading via `/api/history`

### Agent Adapters (`src/agents/`)
- `adapter.ts` — `AgentAdapter` interface: abstract contract for agent implementations. Defines `LaunchOptions`, `ExitAgentResult`, `OpenSpecCommands`, `AgentCharacteristics` types. Methods: `launch()`, `sendPrompt()`, `sendResponse()`, `abort()`, `shutdown()`, `exitAgent()`, `getCharacteristics()`, `getSkillsDir()`, `getCapabilitiesFile()`, `getOpenSpecCommands()`.
- `claude-code.ts` — `ClaudeCodeAdapter`: launches Claude Code with `--permission-mode auto`, supports resume via `--resume <id>`, auto-clears stuck `❯ (current)` state.
- `codex.ts` — `CodexAdapter`: concrete implementation for Codex agent with resume support.

### Other Components
- `TmuxBridge` (`src/tmux/bridge.ts`) — tmux command wrapper (create sessions, send keys, capture panes, `listCliclawAgents()`)
- `AgentRun` (`src/core/agent-run.ts`) — agent lifecycle management
- `AppTUI` (`src/tui/app.ts`) — legacy TUI dashboard (still compiles but not used as primary interface)

## Testing

Tests live in `test/` mirroring `src/` structure (47 test files). All tests mock external dependencies (LLM calls, tmux commands).

Key test directories:
- `test/core/` — MainAgent state machine, integration flow, ContextManager (incl. persistence), memory tools, signal-router
- `test/server/` — command-router, command-registry, ws-handler
- `test/persistence/` — conversation-store SQLite layer
- `test/agents/` — claude-code response parsing, exit behavior, adapter skills
- `test/memory/` — store, search, chunker, category, embedder
- `test/skills/` — parser, reader, discovery, filter, injector, registry, tool-merge, read-skill-tool, adapter-skills, integration
- `test/tmux/` — bridge, state-detector
- `test/llm/` — providers, prompt-loader
- `test/doctor/` — tmux/config/api-key checks
- `test/tui/` — config editor
- `test/utils/` — config utilities

## Config

User config at `~/.cliclaw/config.json`. Managed via `src/utils/config.ts`. The `cliclaw config` subcommand opens a TUI editor. The `cliclaw doctor` subcommand checks environment prerequisites (tmux, node version, API keys).

Memory-related config under `config.memory`:
- `embeddingProvider` — `"auto"` (default) | `"openai"` | `"gemini"` | `"voyage"` | `"mistral"` | `"local"` | `"none"`
- `embeddingModel` — override default model per provider
- `flushThreshold` — memory flush ratio (default 0.6)
- `vectorWeight` — hybrid search vector weight (default 0.7, keyword = 1 - vectorWeight)
- `decayHalfLifeDays` — time decay for daily memories (default 30)
- `skills.disabled` — list of skill names to disable

## WebSocket Message Protocol

Client → Server:
- `{ type: "message", content: string }` — user chat message
- `{ type: "command", name: string }` — slash command (/stop, /resume, /clear, /reset, /compact, /context, /tidy)
- `{ type: "takeover", agentId: string }` — human takes over agent session
- `{ type: "release", agentId: string }` — release agent back to MainAgent control

Server → Client:
- `{ type: "assistant_delta", delta: string }` — streaming text fragment
- `{ type: "assistant_done" }` — streaming response complete
- `{ type: "agent_update", summary: string }` — agent interaction summary
- `{ type: "tool_activity", summary: string }` — exec_command execution summary (throttled: every 3rd call)
- `{ type: "state", state: "idle" | "executing" }` — state change
- `{ type: "system", message: string }` — system notification
- `{ type: "agent_terminals", sessions: Array<{ sessionName, sessionId, status, paneContent }> }` — real-time terminal content for all active agents (pushed every 1s)
- `{ type: "clear" }` — clear chat history on frontend
