# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is Cliclaw

Cliclaw is a chat-based meta-orchestrator that commands CLI coding agents (Claude Code, Codex, …) via tmux. It runs as a persistent HTTP + WebSocket server with a web chat UI. The MainAgent can hold natural conversations and autonomously execute complex development tasks by driving sub-agents inside tmux panes.

Core flow: **Chat message → MainAgent (IDLE ↔ EXECUTING state machine) → Streaming LLM → Tool execution in tmux → Response via WebSocket**

## Commands

```bash
npm run build          # tsc + copies src/agents/claude-code-skills → dist/agents/
npm run dev            # tsc --watch
npm test               # vitest run — all tests
npm run test:watch     # vitest — watch mode
npx vitest test/core/main-agent.test.ts            # run a single test file
npx vitest -t "name pattern"                       # run tests matching a name
npm run check          # biome check src/
npm run format         # biome format --write src/
npm start              # node --max-old-space-size=8192 dist/main.js (port 3120)
```

Subcommands of the `cliclaw` binary (handled before server start): `config`, `doctor`, `init`, `remember`.

## Code Style

- **Formatter**: Biome — tabs, indent width 3, line width 120
- **Module system**: ESM (`"type": "module"` in package.json)
- **TypeScript**: strict mode, target ES2022, module Node16 — **use `.js` extension in relative imports**
- `noExplicitAny: off`, `noNonNullAssertion: off` — intentionally relaxed
- `useConst: error` — always prefer `const`

## Architecture

### Entry Point & CLI
- `src/main.ts` — orchestrates startup: (1) Bootstrap MemoryStore + EmbeddingProvider + memory sync + skill discovery/filter/registry + ConversationStore + CommandRegistry; (2) Restore conversation from SQLite if present; (3) Start Express+WS server; (4) SIGINT/SIGTERM → graceful shutdown.
- `src/cli.ts` — `parseCliArgs()` (--agent, --provider, --model, --base-url, --port, --cwd, …), `printHelp()`, `printVersion()`.

### MainAgent — `src/core/main-agent.ts`
Class **`MainAgent extends EventEmitter<MainAgentEvents>`** ([main-agent.ts:370](src/core/main-agent.ts:370)). Two-state machine: **IDLE** ↔ **EXECUTING**.

- **IDLE**: `handleMessage(content)` streams LLM response. Tool calls → EXECUTING. Pure text → stays IDLE.
- **EXECUTING**: self-loop. Between rounds: check `stopRequested`, drain `MessageQueue` (human messages received during execution), check context thresholds. Terminal tools (`mark_failed`, `escalate_to_human`) return to IDLE. Text-only LLM response also returns to IDLE.

All LLM calls go through `llmClient.stream()`; text deltas are broadcast to WebSocket clients in real time.

**Constructor options of note**: `createAgentSettleMs` (default 10_000 ms — wait after `create_agent` then capture the agent's initial pane for the LLM to see), `thinking` (ThinkingLevel), `learningPipeline`, `changeTracker`, `promptTracker`, `agentStore`.

**Events emitted**: `state_change`, `log`.

**Built-in tools exposed to the LLM** (declared inline in the same file):
- Agent interaction — `send_to_agent`, `respond_to_agent`, `interrupt_agent` (sends Esc + summary to the chat), `inspect_agent`, `list_agent_tasks`, `create_agent`, `list_agents`, `kill_agent`
- Memory — `memory_search`, `memory_get`, `memory_edit` (modes: append/overwrite/replace/delete; `memory_write` is a backwards-compatible alias), `persistent_memory` (read/update global + project MEMORY.md)
- Discovery — `read_skill`, `exec_command` (read-only bash)
- Terminal — `mark_failed`, `escalate_to_human`

`send_to_agent` and `respond_to_agent` both require a `summary` parameter that's surfaced as `agent_update` in the chat UI.

### ContextManager — `src/core/context-manager.ts`
Class **`ContextManager`** ([context-manager.ts:42](src/core/context-manager.ts:42)). Modular system prompt with replaceable sections (`{{compressed_history}}`, `{{memory}}`, `{{agent_capabilities}}`).

Thresholds (defaults):
- `contextWindowLimit = 500_000`
- `flushThreshold = 0.6` — **Layer 2 / memory flush**: extract decisions, preferences, knowledge via `memory-flush.md` and persist to memory files.
- `compressionThreshold = 0.7` — **Layer 3 / compression**: compress history → reset context → re-inject POST_COMPACTION_CONTEXT.
- `toolResultRetention = 20`

Key methods: `getSystemPrompt()`, `getConversationId()`, `addMessage()`, `getMessages()`, `compress()`, `clear()`, `reloadPersistentMemory()`, and **`setCompactTuning({ tools, thinking })`** — wires the compaction LLM call into the same tool/thinking surface as regular turns so it rides the prompt cache. MainAgent calls this at startup; if not wired, compaction falls back to a separate billable completion.

Persistence: `addMessage()` auto-persists to SQLite when a `ConversationStore` is configured. `restore(store)` rebuilds state on server restart. `clear()` runs memory flush → wipes SQLite.

Uses hybrid token counting: last-known API count + pending character estimation.

### Persistence — `src/persistence/`
- `conversation-store.ts` — SQLite at `~/.cliclaw/cliclaw.db`. Tables: `chat_messages` (role, content JSON, tool_call_id, created_at) and `chat_context_state` (compressed_history, compaction_count, …). Methods: `saveMessage`, `loadMessages`, `saveContextState`, `loadContextState`, `clearAll`, `getMessageCount`.
- `agent-store.ts` — per-session pane bookkeeping: `session_id`, `pane_target`, `working_dir`, `taken_over`.

### Signal & Monitoring — `src/core/`
- `signal-router.ts` — **`SignalRouter`**: `stop()` / `resume()` / `isStopRequested()` (checked between tool-use rounds). Also aggregates `StateDetector` results into typed signals.
- `agent-monitor.ts` — **`AgentMonitor`** ([agent-monitor.ts:33](src/core/agent-monitor.ts:33)): tracks active sub-agent tasks and their pane state.
- `agent-run.ts` — **`AgentRun`** ([agent-run.ts:21](src/core/agent-run.ts:21)): captures goal, logs, status of a single agent execution.
- `work-queue.ts` — **`WorkQueue`** ([work-queue.ts:16](src/core/work-queue.ts:16)): prioritized FIFO of user messages and agent events; emits `item_available`. Drained between tool-use rounds.

### StateDetector — `src/tmux/state-detector.ts`
**`StateDetector`** ([state-detector.ts:43](src/tmux/state-detector.ts:43)): polls tmux pane content, hashes it, classifies as `active | waiting_input | completed | error` using per-adapter regex patterns. Falls back to LLM analysis (`state-analyzer.md`) for ambiguous states. Has a cooldown to throttle polling. Exports `PaneStatus`, `DeepAnalysis` types.

### Memory Module — `src/memory/`
Dual-storage: Markdown files are the source of truth, SQLite is the rebuildable index.

- `store.ts` — **`MemoryStore`**: SQLite with WAL mode, schema v2 (auto-migrates from v1). Tables: `meta`, `files`, `chunks`, `chunks_vec_*`, `chunks_fts`, `embedding_cache`. `edit()` supports 4 modes (append/overwrite/replace/delete); `write()` is a backwards-compatible alias.
- `search.ts` — `searchMemory()`: hybrid vector KNN (sqlite-vec) + keyword BM25 (FTS5), weighted merge (default 0.7/0.3), time decay.
- `embedder.ts` — embedding provider factory: OpenAI / Gemini / Voyage / Mistral / local Qwen3-Embedding (node-llama-cpp); auto-fallback chain with retry + caching.
- `chunker.ts` — Markdown chunking (default 400 tokens / 80 overlap).
- `sync.ts` — `syncMemoryFiles()`: incremental file-to-SQLite sync via content hash; embedding-model change triggers full re-sync.
- `category.ts` — `categoryFromPath()`: 6 categories (core, preferences, people, todos, daily, topic) inferred from file path.
- `persistent.ts` — `readPersistentMemory()` / `updatePersistentMemory()` / `validateProjectDir()`: read & update the global `~/.cliclaw/MEMORY.md` and per-project `<dir>/.cliclaw/MEMORY.md` (sections: user_profile, project_conventions, key_decisions, people_and_context, active_notes).
- `types.ts` — `MemoryChunk`, `MemorySearchResult`, `EmbeddingProvider`, `HybridSearchConfig`, `MemoryCategory`.

### Learning Sessions — `src/core/learning-*.ts` + `change-tracker.ts` + `prompt-tracker.ts`
Per-sub-agent change tracking with isolated learning chat. Lifecycle driven by MainAgent's `create_agent` / `send_to_agent` / `respond_to_agent` / `kill_agent` hooks — no new agent-facing tools. Gated by `config.memory.learning.enabled` (default `false`).

- `change-tracker.ts` — **`ChangeTracker`**: captures git baseline at agent launch (commit SHA, or `git stash create` tree for dirty worktrees — never `git stash push`, to avoid polluting the stash stack). At kill, computes unified diff including untracked files (synthesized new-file diffs respecting `.gitignore`).
- `learning-store.ts` — SQLite CRUD over `learning_entries` / `learning_messages` (same DB as ConversationStore). Raw diff lives at `~/.cliclaw/learning/diffs/<id>.diff`; only the path is in SQLite.
- `learning-summarizer.ts` — calls `llmClient.complete()` with `prompts/learning-summary.md`; one retry on JSON parse failure, locale-aware skeleton fallback on second failure.
- `prompt-tracker.ts` — per-sub-agent prompt accumulator; pipeline retrieves the list at kill time.
- `learning-pipeline.ts` — **`LearningPipeline`**: `ingestAgentKill` (error-isolated — failures never block the kill path), `merge` (combines active entries, archives originals), `regenerate` (re-runs summarizer on stored diff), `flushToMemory` (writes `memory/learning/<id>.md` via `MemoryStore.edit`).
- `learning-chat.ts` — **`LearningChat`**: per-entry streaming with `Map<entryId, AbortController>`. Concurrent messages on the same entry are rejected; different entries may stream in parallel. Context is isolated from MainAgent — no memory flush, no compaction.
- `learning-types.ts` — shared types for learning entries / messages / status.
- REST: `GET /api/learning`, `GET /api/learning/:id`, `GET /api/learning/:id/diff`, `GET /api/learning/:id/messages`, `PATCH /api/learning/:id`, `POST /api/learning/merge`, `POST /api/learning/:id/regenerate`, `POST /api/learning/:id/flush-to-memory`, `DELETE /api/learning/:id`.
- WS client→server: `learning_message`, `learning_stop`. Server→client: `learning_entry_created`, `learning_entry_updated`, `learning_entry_deleted`, `learning_delta`, `learning_done`, `learning_error`.

### Skill System — `src/skills/`
Three skill types from `types.ts`: **`agent-capability`** (injected into sub-agent capabilities file), **`main-agent-tool`** (tool merged into MainAgent's tool set), **`prompt-enrichment`** (text added to MainAgent system prompt).

- `discovery.ts` — discovers skills from adapter `claude-code-skills/` and workspace `.cliclaw/skills/` directories (workspace overrides adapter); limit 50.
- `filter.ts` — conditional activation by `disabled` list, file existence, OS, env vars.
- `parser.ts` / `reader.ts` — YAML frontmatter parsing for `SKILL.md` files (reader = lazy full-content load).
- `registry.ts` — **`SkillRegistry`**: lookup by name or tool name.
- `injector.ts` — injects skill summaries into MainAgent prompt (budget-aware, max 2000 chars).
- `tool-merge.ts` — merges skill tool definitions into MainAgent's tool set with collision detection.

### LLM Layer — `src/llm/`
- `client.ts` — **`LLMClient`**: unified `complete()` (single response) and `stream()` (async iterable of `LLMStreamEvent`). Dispatches across three provider protocols.
- `providers/anthropic.ts` — `AnthropicProvider` (Messages API).
- `providers/openai-compatible.ts` — `OpenAICompatibleProvider` (Chat Completions).
- `providers/openai-responses.ts` — `OpenAIResponsesProvider` (Responses API; cache-aware, reasoning replay). Implements **stream-level retry with backoff** ([openai-responses.ts:367](src/llm/providers/openai-responses.ts:367)) — each retry is a separate billable call; the helper at the bottom of the file gates which SSE-parse errors trigger retry.
- `providers/registry.ts` — 13 built-in providers: openai, openai-responses, anthropic, openrouter, moonshot, minimax, deepseek, groq, together, xai, gemini, mistral, ollama.
- `prompt-loader.ts` — loads markdown templates from `prompts/` with `{{variable}}` interpolation. Picks `.cn.md` when locale is zh-CN.
- `types.ts` — `LLMMessage`, `LLMStreamEvent`, `ToolDefinition`, `ThinkingLevel`, etc.

### Server Layer — `src/server/`
HTTP + WebSocket server for the chat interface.

- `index.ts` — `startServer(opts) → ServerInstance { close(), port }`. Express app + static `web/` + REST (`/api/history`, `/api/status`, `/api/learning/*`) + WebSocket on `/ws`.
- `auth.ts` — cookie-based auth: `createServerAuthToken()`, `buildAuthCookie()`, `isAuthorized()`, `parseCookies()`.
- `mdns.ts` — Bonjour/mDNS advertising for LAN discovery: `startMdns()`, `MdnsHandle`, `getLanIPv4()`.
- `chat-broadcaster.ts` — **`ChatBroadcaster`** ([chat-broadcaster.ts:12](src/server/chat-broadcaster.ts:12)): manages connected WS clients; `broadcast(message: ChatMessage)` fans out; terminates stalled clients (high buffered amount).
- `ui-events.ts` — `UiEventStore` (memory + optional SQLite) of `UiEvent`s for replay/auditing.
- `ws-handler.ts` — per-connection handler; routes `{type: "message"}` to `MainAgent.handleMessage()`, `{type: "command"}` to `CommandRouter`, plus `takeover` / `release` for human pane handoff. Sends current state on connect.
- `command-router.ts` — **`CommandRouter`** ([command-router.ts:44](src/server/command-router.ts:44)). Handled slash commands: **`/stop`, `/clear`, `/reset`, `/compact`, `/context`, `/tidy`**. `/tidy` uses LLM to review memory files and archive outdated entries.
- `command-registry.ts` — `CommandRegistry`: central metadata store for both built-in and skill-declared slash commands. Methods: `register`, `registerMany`, `get`, `has`, `getAll`, `search`.

(Note: `/resume` is no longer a slash command — execution control flows through the `stop`/auto-resume model.)

### Agent Adapters — `src/agents/`
- `adapter.ts` — `AgentAdapter` interface contract: `launch`, `sendPrompt`, `sendResponse`, `abort`, `shutdown`, `exitAgent`, `getCharacteristics`, `getSkillsDir`, `getCapabilitiesFile`, `getOpenSpecCommands`. Types: `LaunchOptions`, `ExitAgentResult`, `OpenSpecCommands`, `AgentCharacteristics`.
- `claude-code.ts` — **`ClaudeCodeAdapter`** ([claude-code.ts:13](src/agents/claude-code.ts:13)). Launches `claude --permission-mode auto [--resume <id>]`. Auto-clears the stuck `❯ (current)` state. Activity regex is **case-sensitive** ([claude-code.ts:233](src/agents/claude-code.ts:233)).
- `codex.ts` — **`CodexAdapter`** ([codex.ts:13](src/agents/codex.ts:13)). Launches `codex --full-auto [resume <id>]`.
- `claude-code-skills/` — built-in skills bundled with the Claude Code adapter (e.g. `commit/SKILL.md`); copied into `dist/agents/` by the build step.

### Tmux — `src/tmux/`
- `bridge.ts` — **`TmuxBridge`** ([bridge.ts:10](src/tmux/bridge.ts:10)): tmux command wrapper. Create sessions, send keys, capture panes, `listCliclawAgents()` for `cliclaw-`-prefixed sessions.
- `types.ts` — `TmuxSession`, `TmuxWindow`, `TmuxPane`, `TmuxError`, `CaptureResult`.

### Utils — `src/utils/`
- `config.ts` — `loadConfig()` / `saveConfig()` for `~/.cliclaw/config.json` (provider, model, state-detector, tmux, memory, locale).
- `locale.ts` — `resolveLocale()`, `getLanguageInstruction(locale)`. Maps `zh*` → `zh-CN`, else `en-US`.
- `logger.ts` — async file logger.
- `mcp-config.ts` — builds per-agent MCP server configuration (per-agent MCP scoping).
- `ulid.ts` — Crockford-alphabet ULID generator.

### Doctor — `src/doctor/`
- `run.ts` — `runDoctor()` executes checks.
- `formatter.ts` — report formatting.
- `checks/tmux.ts`, `checks/config.ts`, `checks/api-key.ts` — individual environment checks.

### Prompts — `prompts/` (English + `.cn.md` Chinese variants)
- `main-agent.md` — MainAgent system prompt (autonomous decision guidelines, execution paths, memory recall, agent management, skill usage).
- `state-analyzer.md` — ambiguous pane-state classification.
- `history-compressor.md` — legacy conversation compression path.
- `memory-flush.md` — extract decisions/preferences/knowledge for persistence (uses `memory_edit`).
- `memory-tidy.md` — LLM-driven memory file review, outputs structured JSON (retained/archived/summary).
- `learning-summary.md`, `learning-chat.md`, `learning-memory.md` — learning sessions prompts.
- `error-analyzer.md`, `session-summarizer.md` — diagnostics & recap.
- `adapters/` — per-adapter prompt fragments.

### Chat UI — `web/`
Vanilla HTML/CSS/JS served by Express as static files.
- `index.html` — page structure: header + status indicator, message list, input, learning panel.
- `styles.css` — dark theme; message bubbles for user / assistant / agent-update / system; idle/executing status animation.
- `app.js` — WebSocket connect/reconnect, message routing, streaming delta display, slash-command UX, basic Markdown render, history load via `/api/history`.
- `learning.js` — Learning Sessions panel (entries list + Summary/Chat detail tabs).
- `settings.js` — settings panel.
- `i18n.js` — `t(key)` lookups; locale from `/api/status`, fallback `navigator.language`.

### TUI (legacy) — `src/tui/app.ts`
`AppTUI` dashboard. Still compiles; not the primary interface.

## Testing

Tests live in `test/` mirroring `src/` (vitest). All external dependencies (LLM calls, tmux commands, embedding providers) are mocked.

Top-level test dirs: `test/core/`, `test/server/`, `test/persistence/`, `test/agents/`, `test/memory/`, `test/skills/`, `test/tmux/`, `test/llm/`, `test/doctor/`, `test/tui/`, `test/utils/`.

Run a single file: `npx vitest test/core/main-agent.test.ts`. Match by name: `npx vitest -t "state machine"`.

## Config

`~/.cliclaw/config.json`, edited via `cliclaw config` (TUI editor). Prerequisites checked by `cliclaw doctor` (tmux, node version, API keys).

`config.memory.*`:
- `embeddingProvider` — `"auto"` (default) | openai | gemini | voyage | mistral | local | none
- `embeddingModel` — override default per-provider model
- `flushThreshold` — memory-flush ratio (default 0.6)
- `vectorWeight` — hybrid search vector weight (default 0.7; keyword = 1 − vectorWeight)
- `decayHalfLifeDays` — time decay for daily memories (default 30)
- `skills.disabled` — list of skill names to disable
- `learning.enabled` — enable Learning Sessions (default `false`). When disabled, no learning components are initialized and the UI tab is hidden.

## i18n / Language

Cliclaw auto-detects system language; supports `zh-CN` and `en-US`. Resolution order:
1. `config.locale` override in `~/.cliclaw/config.json`
2. Node: `LC_ALL` → `LANG` → `LANGUAGE`; Browser: `navigator.language`
3. Fallback: `en-US`

Chinese locales (`zh*`) map to `zh-CN`; everything else maps to `en-US`.

- **Frontend**: `web/i18n.js` provides `t(key)`. HTML uses `data-i18n` / `data-i18n-placeholder`. Locale from `/api/status`, with browser detection fallback.
- **Backend prompts**: `prompt-loader.ts` automatically picks `.cn.md` variants under zh-CN. `learning-summary.md` / `learning-chat.md` also accept a `{{language_instruction}}` variable injected by `getLanguageInstruction(locale)` from `src/utils/locale.ts`.
- **Skeleton fallback strings**: `LearningSummarizer` skeleton is locale-aware.
- Internal logs, code comments, and this CLAUDE.md remain in English.

## WebSocket Message Protocol

Client → Server:
- `{ type: "message", content: string }` — user chat message
- `{ type: "command", name: string }` — slash command (/stop, /clear, /reset, /compact, /context, /tidy)
- `{ type: "takeover", agentId: string }` — human takes over agent session
- `{ type: "release", agentId: string }` — release agent back to MainAgent control
- `{ type: "learning_message", entryId, content }` / `{ type: "learning_stop", entryId }` — Learning panel chat

Server → Client:
- `{ type: "assistant_delta", delta }` — streaming text fragment
- `{ type: "assistant_done" }` — streaming response complete
- `{ type: "agent_update", summary }` — agent interaction summary (from `send_to_agent`/`respond_to_agent`)
- `{ type: "tool_activity", summary }` — `exec_command` activity (throttled: every 3rd call)
- `{ type: "state", state: "idle" | "executing" }` — state change
- `{ type: "system", message }` — system notification
- `{ type: "agent_terminals", sessions: Array<{ sessionName, sessionId, status, paneContent }> }` — real-time pane content for all active agents (pushed ~every 1s)
- `{ type: "clear" }` — clear chat history on frontend
- Learning: `learning_entry_created`, `learning_entry_updated`, `learning_entry_deleted`, `learning_delta`, `learning_done`, `learning_error`

## Operational Notes

- **Prompt-cache stability for `{{memory}}`**: the global `~/.cliclaw/MEMORY.md` snapshot is loaded into the system prompt **once per session** and intentionally NOT hot-reloaded after `persistent_memory` writes. On-disk content is authoritative immediately; the in-prompt snapshot is refreshed only on `/clear`, `/compact`, or `/reset`. Rely on the tool's return value, not on the system prompt changing, to confirm a write took effect.
- **Project memory is not in the system prompt**: it's surfaced only when MainAgent calls `create_agent` for that project — at that moment the agent can decide what to forward to the sub-agent.
- **`create_agent` initial pane capture**: after launching the sub-agent, MainAgent sleeps `createAgentSettleMs` (default 10s) and then captures the last 20 visible lines of the pane, embedding them in the tool result so the LLM can confirm the launch state without a separate `inspect_agent` call.
- **In-chain compaction**: `MainAgent` calls `contextManager.setCompactTuning({ tools, thinking })` at startup so compaction reuses the regular turn's prompt cache. If this is missing, compaction silently falls back to a separate (full-cost) completion — see the warning log in `context-manager.ts` if you ever see compaction surprises in token usage.
- **Dirty-worktree baselines** for learning sessions use `git stash create` (no push), so they never appear in `git stash list`.
