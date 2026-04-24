# Learning Sessions: Per-Sub-Agent Change Tracking & Conversational Learning

**Date:** 2026-04-20
**Status:** Design — approved, pending implementation plan
**Branch:** refactor/remove-execution-event

## Problem

After the removal of the `ExecutionEvent` evidence pipeline, the right-side panel in the web UI is an empty placeholder. Meanwhile, users have no structured way to review what each sub-agent actually changed, nor a scoped conversational surface to learn from those changes after the fact.

This spec introduces **Learning Sessions**: per-sub-agent change tracking driven by git diff, paired with an isolated chat surface scoped to each set of changes, so the user can ask follow-up questions and absorb design rationale without polluting the main MainAgent conversation.

## Goals

- Every sub-agent run that produces file changes results in a persisted **learning entry** containing the diff, a structured LLM-generated summary, and the originating task prompts.
- Each learning entry owns an **isolated chat session** whose context is strictly the entry's summary — no cross-contamination with MainAgent memory flush / compaction.
- Users can **merge** multiple entries into a combined topic, triggering a re-generated summary over the merged scope.
- Users can **opt-in flush** an entry into the memory system so it becomes searchable in future MainAgent work.
- The feature occupies the existing right-side panel; no new pages or routes.

## Non-Goals

- No full-diff inclusion in learning-chat system prompts (stats + key files only in V1).
- No manual creation of empty learning entries — entries only come from agent lifecycle or merges.
- No edit-by-hand of `summary_json` — regenerate is the only path to change it.
- No per-learning-chat LLM provider/model override — reuse MainAgent's `llmClient`.
- No pane-content parsing — git diff is the single source of truth for "what changed"; MainAgent-sent prompts are the source of truth for "why."
- Tool-call reconstruction for sub-agents is not restored.

## User-facing behavior

1. Sub-agent finishes work (`kill_agent` tool call or session cleanup). If the working directory had file changes since agent launch, a new learning entry appears in the right-side panel with a highlighted pulse.
2. User clicks the entry. The **Summary** tab shows "What changed / Why / Key files / Design points / Learning hooks". Clicking a hook chip fills (but does not send) the learning chat input.
3. User switches to the **Chat** tab and asks questions. Answers stream in; context is only this entry's summary.
4. User selects 2+ entries and clicks **Merge**. A new entry is created with a re-generated summary; originals become `archived` and read-only.
5. User clicks **Flush to memory** on a valuable entry. A markdown file is written under `memory/learning/<id>.md` so future MainAgent `memory_search` can find it.

## Architecture

### New modules

| Module | Purpose |
|---|---|
| `src/core/change-tracker.ts` | Singleton on MainAgent. Records git baseline per sub-agent at launch, computes diff at kill. |
| `src/core/learning-store.ts` | SQLite-backed CRUD for learning entries + chat messages. Shares the `~/.cliclaw/cliclaw.db` `Database` instance with `ConversationStore` but is its own class. |
| `src/core/learning-summarizer.ts` | Calls `llmClient.complete()` with `prompts/learning-summary.md` to generate structured `summary_json`. |
| `src/core/learning-chat.ts` | Manages per-entry chat sessions: loads history, assembles isolated system prompt, streams responses, persists both sides. Maintains `Map<entryId, AbortController>` for interrupt support. |
| `src/core/learning-pipeline.ts` | Orchestrator that wires ChangeTracker → Summarizer → Store → broadcaster. Called by MainAgent's `kill_agent` handler and by REST `merge` / `regenerate` endpoints. |

### Touched modules

| Module | Change |
|---|---|
| `src/core/main-agent.ts` | Hook `create_agent` handler to call `ChangeTracker.registerAgent`; hook `kill_agent` handler to call `LearningPipeline.ingestAgentKill` before `adapter.shutdown`. Add internal helper `getPromptsForAgent(sessionId)` scanning `ContextManager` messages for matching `send_to_agent` / `respond_to_agent` tool calls. |
| `src/server/index.ts` | Add REST endpoints under `/api/learning/*`. |
| `src/server/chat-broadcaster.ts` | Add new broadcast message types (typed, not string-unioned inline). |
| `src/server/ws-handler.ts` | Route `learning_message` and `learning_stop` client messages to `LearningChat`. |
| `prompts/` | Add `learning-summary.md`, `learning-chat.md`, `learning-memory.md`. |
| `web/app.js` | Integrate new `web/learning.js` module via `<script type="module">`. |
| `web/learning.js` (new) | Right-panel rendering, list interactions, chat streaming, REST calls. Vanilla JS, no framework. |
| `web/styles.css` | Add `.learning-*` prefixed rules for list / summary / chat layout. |
| `web/index.html` | Split existing right-side container into top (list) / bottom (detail) with resize affordance. |

### Module interfaces

```ts
// src/core/change-tracker.ts
class ChangeTracker {
  registerAgent(sessionId: string, cwd: string): Promise<void>
  computeDiff(sessionId: string): Promise<DiffResult | null>
  releaseAgent(sessionId: string): void
}

interface DiffResult {
  filesChanged: number
  additions: number
  deletions: number
  filesList: Array<{ path: string; status: "added" | "modified" | "deleted" | "renamed" }>
  rawDiff: string  // unified diff text
}
```

- Baseline capture: `git rev-parse HEAD`; if working tree is dirty, use `git stash create` to produce a throwaway tree object (does NOT push onto the stash stack).
- Diff computation: `git diff <baseRef> HEAD -- <cwd>` combined with `git diff HEAD` (unstaged). The two are concatenated; path de-duplication is not required — downstream stat aggregation handles it.
- `releaseAgent` drops the in-memory baseline map entry; no git side-effects.
- Non-git cwd: `registerAgent` logs and stores a sentinel; `computeDiff` returns `null` in that case.

```ts
// src/core/learning-store.ts
class LearningStore {
  create(input: CreateLearningEntryInput): Promise<LearningEntry>
  loadEntry(id: string): Promise<LearningEntry | null>
  list(opts: { status?: "active" | "archived"; limit?: number; offset?: number }): Promise<LearningEntrySummary[]>
  updateTitle(id: string, title: string): Promise<void>
  setStatus(id: string, status: "active" | "archived"): Promise<void>
  replaceSummary(id: string, summary_json: SummaryJson): Promise<void>
  markMemoryFlushed(id: string, at: number): Promise<void>
  delete(id: string): Promise<void>  // cascades messages + deletes diff blob file
  appendMessage(entryId: string, role: "user" | "assistant", content: string): Promise<void>
  // appendMessage also updates the parent entry's `updated_at` so list ordering reflects chat activity.
  loadMessages(entryId: string): Promise<LearningMessage[]>
  writeDiffBlob(id: string, rawDiff: string): Promise<string>  // returns path
  readDiffBlob(id: string): Promise<string>
}
```

```ts
// src/core/learning-summarizer.ts
class LearningSummarizer {
  generate(input: SummarizerInput): Promise<SummaryJson>  // with 1 retry; falls back to skeleton on second failure
}

interface SummarizerInput {
  agentPrompts: string[]
  diffForLLM: string        // raw diff if <=2000 lines, else truncated per-file digest
  filesList: DiffResult["filesList"]
  mode: "agent" | "merged"
}
```

```ts
// src/core/learning-pipeline.ts
class LearningPipeline {
  ingestAgentKill(ctx: { sessionId, sessionName, cwd, agentPrompts }): Promise<LearningEntry | null>
  merge(ids: string[], titleOverride?: string): Promise<LearningEntry>
  regenerate(id: string): Promise<LearningEntry>
  flushToMemory(id: string): Promise<void>
}
```

## Data model

Both tables live in `~/.cliclaw/cliclaw.db`. Migration added to the same schema-version mechanism already used by `ConversationStore`.

### `learning_entries`

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PRIMARY KEY | `lrn_` + ULID |
| `title` | TEXT NOT NULL | LLM-generated, user-editable |
| `status` | TEXT NOT NULL | `active` \| `archived` (default `active`) |
| `source_type` | TEXT NOT NULL | `agent` \| `merged` |
| `source_agents` | TEXT NOT NULL | JSON: `[{ sessionId, sessionName, baseRef, endRef, cwd }]`. `baseRef` and `endRef` are resolved commit SHAs (or stash-tree object SHAs), never symbolic refs like `HEAD`. |
| `agent_prompts` | TEXT NOT NULL | JSON: `string[]` (prompts/responses MainAgent sent to the agent) |
| `summary_json` | TEXT NOT NULL | JSON, schema below |
| `diff_stats` | TEXT NOT NULL | JSON: `{ filesChanged, additions, deletions, filesList }` |
| `diff_blob_path` | TEXT NOT NULL | absolute path to raw diff file |
| `memory_flushed_at` | INTEGER NULL | epoch ms, NULL if not flushed |
| `created_at` | INTEGER NOT NULL | epoch ms |
| `updated_at` | INTEGER NOT NULL | epoch ms |

Index: `idx_learning_entries_status_updated` on `(status, updated_at DESC)`.

### `learning_messages`

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | |
| `entry_id` | TEXT NOT NULL | FK `learning_entries(id) ON DELETE CASCADE` |
| `role` | TEXT NOT NULL | `user` \| `assistant` |
| `content` | TEXT NOT NULL | markdown text |
| `created_at` | INTEGER NOT NULL | |

Index: `idx_learning_messages_entry` on `(entry_id, id)`.

### Raw diff blob storage

- Directory: `~/.cliclaw/learning/diffs/`, created on `LearningStore` construction via `ensureDir`.
- Filename: `<id>.diff`.
- Rationale: raw diffs can be tens of thousands of lines; storing inline would bloat WAL and slow unrelated column reads.

### `summary_json` schema

```json
{
  "title": "string — one-line topic",
  "what_changed": "markdown string",
  "why": "markdown string",
  "key_files": [{ "path": "string", "role": "string" }],
  "design_points": ["string", "..."],
  "learning_hooks": ["string", "..."]
}
```

Fallback skeleton (when LLM fails twice):

```json
{
  "title": "Untitled (LLM error)",
  "what_changed": "LLM summary unavailable. Diff stats: <N> files, +<A> -<D>.",
  "why": "",
  "key_files": [{ "path": "<from filesList>", "role": "" }, "..."],
  "design_points": [],
  "learning_hooks": []
}
```

## API surface

### REST endpoints (`src/server/index.ts`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/learning` | List entries. Query: `status` (default `active`), `limit`, `offset`. Returns `LearningEntrySummary[]`. |
| GET | `/api/learning/:id` | Full entry including `summary_json`, `agent_prompts`, `diff_stats`. Excludes raw diff. |
| GET | `/api/learning/:id/diff` | Raw diff text (`Content-Type: text/plain`). |
| GET | `/api/learning/:id/messages` | Array of learning chat messages. |
| PATCH | `/api/learning/:id` | Body: `{ title?, status? }`. Returns updated entry. |
| POST | `/api/learning/merge` | Body: `{ ids: string[], title?: string }`. Creates new merged entry; archives originals. Returns new entry. |
| POST | `/api/learning/:id/regenerate` | Re-runs summarizer on the stored diff + prompts. Returns updated entry. |
| POST | `/api/learning/:id/flush-to-memory` | Writes `memory/learning/<id>.md`; updates `memory_flushed_at`. Returns updated entry. |
| DELETE | `/api/learning/:id` | Hard delete entry + cascaded messages + diff blob file. |

`LearningEntrySummary` = projection (`id`, `title`, `status`, `source_type`, `diff_stats`, `updated_at`, `memory_flushed_at`, `source_agents` count). No `summary_json`, no `agent_prompts`.

### WebSocket messages

**Client → Server (new):**

```ts
{ type: "learning_message", entryId: string, content: string }
{ type: "learning_stop", entryId: string }
```

**Server → Client (new):**

```ts
{ type: "learning_entry_created", entry: LearningEntrySummary }
{ type: "learning_entry_updated", entry: LearningEntrySummary }
{ type: "learning_entry_deleted", id: string }
{ type: "learning_delta", entryId: string, delta: string }
{ type: "learning_done",  entryId: string }
{ type: "learning_error", entryId: string, message: string }
```

Rationale for not reusing `assistant_delta`: main-chat deltas are broadcast globally; learning deltas must be routed per-entry. Overloading would break routing semantics on the client.

## Flows

### Agent-kill ingestion

```
kill_agent(sessionId)
 ├─ ChangeTracker.computeDiff(sessionId) → diff | null
 ├─ if (!diff || diff.filesChanged === 0) → skip, proceed to adapter.shutdown
 ├─ agentPrompts = MainAgent.getPromptsForAgent(sessionId)
 ├─ diffForLLM = diff.rawDiff.lineCount <= 2000
 │    ? diff.rawDiff
 │    : perFileHeaderPlusFirst50Lines(diff.rawDiff)
 ├─ summary_json = await LearningSummarizer.generate({ agentPrompts, diffForLLM, filesList, mode:'agent' })
 │                 (1 retry on parse failure; skeleton on second failure)
 ├─ entry = await LearningStore.create({ id, title: summary_json.title, source_type:'agent',
 │                                        source_agents:[{ sessionId, sessionName, baseRef, endRef: await resolveHeadSha(cwd), cwd }],
 │                                        agent_prompts, summary_json, diff_stats: toStats(diff),
 │                                        diff_blob_path: await writeDiffBlob(id, diff.rawDiff) })
 ├─ broadcaster.broadcast({ type:'learning_entry_created', entry: toSummary(entry) })
 └─ ChangeTracker.releaseAgent(sessionId); adapter.shutdown()
```

Error isolation: any failure inside this flow (git error, disk write error, LLM exhaustion after retry+fallback) is logged and does NOT block `adapter.shutdown`. The kill path must remain robust.

### Learning chat message handling

```
ws_message { type:'learning_message', entryId, content }
 ├─ entry = LearningStore.loadEntry(entryId); guard exists && status==='active'
 ├─ history = LearningStore.loadMessages(entryId)
 ├─ system = render(prompts/learning-chat.md, { title, what_changed, why, key_files, design_points, diff_stats })
 ├─ LearningStore.appendMessage(entryId, 'user', content)
 ├─ broadcaster.broadcast({ type:'learning_entry_updated', entry: toSummary(entry) })  // bumps list order
 ├─ controller = new AbortController(); learningChat.active.set(entryId, controller)
 ├─ for await (delta of llmClient.stream({ system, messages:[...history, { role:'user', content }] }, { signal: controller.signal })):
 │     broadcaster.broadcast({ type:'learning_delta', entryId, delta })
 ├─ LearningStore.appendMessage(entryId, 'assistant', final)
 ├─ broadcaster.broadcast({ type:'learning_done', entryId })
 └─ learningChat.active.delete(entryId)

ws_message { type:'learning_stop', entryId }
 ├─ controller = learningChat.active.get(entryId); if none → no-op
 ├─ controller.abort()
 ├─ LearningStore.appendMessage(entryId, 'assistant', partialSoFar + ' [interrupted]')
 └─ broadcaster.broadcast({ type:'learning_done', entryId })

Concurrency: if learningChat.active.has(entryId) when a new learning_message arrives,
reject with learning_error "already streaming". Front-end disables send button while streaming.
Different entryIds may stream concurrently.
```

### Merge

```
POST /api/learning/merge { ids:[a,b,c], title? }
 ├─ Load all three; 400 if any missing or any status !== 'active'.
 ├─ mergedDiff = concat(readDiffBlob(a), readDiffBlob(b), readDiffBlob(c))   // ordered by entries' updated_at ASC
 ├─ mergedStats = recompute(mergedDiff)                                      // dedupe file paths
 ├─ mergedPrompts = concat(a.agent_prompts, b.agent_prompts, c.agent_prompts)
 ├─ summary_json = LearningSummarizer.generate({ agentPrompts: mergedPrompts, diffForLLM, filesList: mergedStats.filesList, mode:'merged' })
 ├─ newEntry = LearningStore.create({ source_type:'merged', source_agents: concat(...), ... })
 ├─ for each id in [a,b,c]: LearningStore.setStatus(id, 'archived')
 ├─ broadcaster.broadcast created for newEntry + updated for each archived
 └─ return newEntry
```

Merged entries do NOT inherit chat history from originals; their chat starts empty. Originals remain readable (including their chat) in the Archived tab.

### Flush to memory

```
POST /api/learning/:id/flush-to-memory
 ├─ entry = loadEntry(id); 404 if missing
 ├─ md = renderMemoryMarkdown(entry)   // title, what_changed, why, design_points, key_files
 ├─ MemoryStore.edit({ mode:'overwrite', path: `learning/${id}.md`, content: md })
 ├─ LearningStore.markMemoryFlushed(id, Date.now())
 ├─ broadcaster.broadcast({ type:'learning_entry_updated', entry: toSummary(entry) })
 └─ return updated entry
```

The memory file lives at `~/.cliclaw/memory/learning/<id>.md`. It is indexed by the existing `MemorySync` + embedder pipeline and discoverable via `memory_search`.

## UI layout

The existing right-side placeholder container is split into:

- **Top 1/3 (min 180px):** entry list. Controls: search input, `Active` / `Archived` tabs, multi-select checkboxes; `Merge selected` button appears when ≥2 selected. Resizable divider between top and bottom.
- **Bottom 2/3:** detail pane with **Summary** / **Chat** tabs (default Summary).
  - **Summary tab:** renders `summary_json`. "Key files" lists each `{ path, role }`; a "View full diff" button opens a modal that fetches `/api/learning/:id/diff`. Action buttons: `Regenerate`, `Flush to memory` (shows checkmark + relative time if already flushed), `Archive`.
  - **Chat tab:** message list + input. `learning_hooks` chips shown in empty state; clicking fills input without sending. Header shows `Context: this entry's summary + diff stats`.

List-item card:

```
● <title>                     <filesChanged files · +<a> −<d>>
  src: <'agent: <name>' | 'N agents merged'>           <relative time>
```

Status glyph: filled dot = `active`, hollow dot = `archived`, green-fill = `memory_flushed_at !== null`.

New-entry arrival (`learning_entry_created`) inserts at list top with a one-time pulse highlight. **Selection is NOT auto-changed** to avoid interrupting an ongoing learning chat.

Responsive: window width <900px collapses right panel into a header button `Learning (N)` that opens an overlay drawer.

Frontend remains vanilla JS. `web/learning.js` (new module) imported into `web/app.js`. Markdown rendering reuses the existing helper; no code-highlighter is added (YAGNI).

## Testing

Mirroring existing `test/` structure. All tests mock external deps (git, LLM, filesystem for diff blobs where reasonable).

- `test/core/change-tracker.test.ts` — baseline capture in clean / dirty repos, non-git cwd returns null, diff aggregation across committed + unstaged changes.
- `test/core/learning-store.test.ts` — CRUD, cascade delete, index ordering, diff blob write/read.
- `test/core/learning-summarizer.test.ts` — prompt rendering, retry on JSON parse failure, fallback skeleton on second failure.
- `test/core/learning-pipeline.test.ts` — `ingestAgentKill` happy path, no-op on empty diff, error isolation (git failure / LLM failure do not throw to caller), merge flow, regenerate, flush-to-memory.
- `test/core/learning-chat.test.ts` — system prompt assembly, streaming delta broadcast, interrupt flow, concurrent rejection for same entryId, different entryIds stream independently.
- `test/core/main-agent.test.ts` — extend: `kill_agent` invokes pipeline; `create_agent` invokes tracker; `getPromptsForAgent` correctly filters by sessionId.
- `test/server/learning-api.test.ts` — all REST endpoints, including merge precondition failures and regenerate idempotency.
- `test/server/ws-handler.test.ts` — extend: `learning_message` routing, `learning_stop` routing, reject when entry missing / archived.
- `test/web/` — smoke test for `learning.js` module (list render, new-entry insertion does not change selection) — follows the pattern of removed `test/web/execution-evidence.test.ts`.

## Configuration

No new user config keys in V1. All behavior derives from existing providers and defaults. Future config surface (if needed):

- Diff truncation threshold (currently hard-coded 2000 lines).
- Summarizer LLM model override (currently shares MainAgent's `llmClient`).

These are intentionally deferred — YAGNI until someone asks.

## Migration & compatibility

- Existing SQLite users get schema v(N+1) with the two new tables and the `~/.cliclaw/learning/diffs/` directory on next server start. The migration is additive; no data reshape.
- No changes to chat message format, MainAgent tool schemas visible to the LLM, or existing REST endpoints.
- Uninstall / downgrade: leftover tables and diff files are harmless; the prior build simply ignores them.

## Open items deferred to V2

- In-chat `fetch_diff_section(path)` tool for learning chat when users want to drill into specific hunks without inflating system prompt.
- Auto-suggested merges (LLM clusters nearby entries by topic).
- Multi-column layout for simultaneous viewing of two learning entries.
- Export learning entry to markdown / PDF.
- Per-entry LLM model selection.

## Risk & mitigation

| Risk | Mitigation |
|---|---|
| LLM outage blocks `kill_agent` | Summarizer has 1 retry then falls back to skeleton; any exception is caught inside the pipeline and logged, kill proceeds. |
| Large diff blows context budget | Truncate to per-file header + first 50 hunk lines when > 2000 lines; stats still accurate. |
| SQLite growth from raw diff storage | Raw diff lives on disk, not in DB. DB row size is bounded. |
| User accidentally deletes entry | DELETE requires frontend two-step confirmation; archive is the soft-delete path. |
| New WebSocket message types collide with future additions | All learning message `type` values share the `learning_` prefix; guard with a discriminated union in shared types. |
| `ChangeTracker` leaks baseline refs on crash | Baselines are in-memory only; process restart clears them. `git stash create` objects become unreachable and are garbage-collected by `git gc`. |
