# Learning Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-sub-agent git-diff change tracking with LLM-generated structured summaries, served through an isolated learning-chat UI in the existing right-side panel.

**Architecture:** `ChangeTracker` snapshots git baselines at agent launch and diffs at kill. `LearningPipeline` composes `ChangeTracker` + `LearningSummarizer` + `LearningStore` (new SQLite tables in existing `~/.cliclaw/cliclaw.db`). `LearningChat` handles per-entry streaming with isolated context (no MainAgent memory flush). REST + WebSocket surface drives a new `web/learning.js` module inside the existing right-panel container. No new MainAgent tools — all automatic via `create_agent` / `kill_agent` hooks.

**Tech Stack:** TypeScript (strict, ESM, Node16), better-sqlite3, Express, ws (WebSocket), vanilla JS frontend, Vitest with in-memory SQLite for store tests.

**Spec:** [docs/superpowers/specs/2026-04-20-learning-sessions-design.md](../specs/2026-04-20-learning-sessions-design.md)

---

## Conventions for this plan

- **Import style:** all relative imports end in `.js` (Node16 ESM resolution), even when importing `.ts` files.
- **Formatter:** Biome — tabs, indent 3, line width 120. `npm run format` before each commit.
- **Test runner:** `npx vitest run <path>` for a single file, `npm test` for full suite.
- **DB path in tests:** use `mkdtemp` + `better-sqlite3` pointing at a tmp file, following `test/persistence/conversation-store.test.ts:14-19`.
- **Commit cadence:** one commit per task, message format `feat(learning): <what>` or `refactor(learning): <what>`.
- **When a step says "run tests":** the expected output is "PASS" (or FAIL before implementation). If output differs, stop and investigate before proceeding.

---

## File structure (locked before tasks)

### New files

| File | Responsibility |
|---|---|
| `src/core/learning-types.ts` | Shared types: `LearningEntry`, `LearningEntrySummary`, `LearningMessage`, `SummaryJson`, `DiffResult`, `CreateLearningEntryInput`, discriminated union for learning WS messages. |
| `src/core/learning-store.ts` | SQLite CRUD for entries & messages; raw diff blob I/O. |
| `src/core/change-tracker.ts` | Git baseline capture, diff computation, per-session registry. |
| `src/core/learning-summarizer.ts` | Renders `learning-summary.md` prompt, calls `llmClient.complete()`, parses JSON, retries once, falls back to skeleton. |
| `src/core/learning-pipeline.ts` | Orchestrates `ingestAgentKill`, `merge`, `regenerate`, `flushToMemory`. Error-isolated. |
| `src/core/learning-chat.ts` | Per-entry streaming message handling with `Map<entryId, AbortController>`. |
| `src/core/prompt-tracker.ts` | Tiny helper — in-memory `Map<sessionId, string[]>` of prompts MainAgent sent to each sub-agent. |
| `prompts/learning-summary.md` | Summarizer template. |
| `prompts/learning-chat.md` | Learning-chat system prompt. |
| `prompts/learning-memory.md` | Flush-to-memory markdown template. |
| `web/learning.js` | Right-panel UI module: list, summary tab, chat tab, actions. |
| `test/core/learning-store.test.ts` | |
| `test/core/change-tracker.test.ts` | |
| `test/core/learning-summarizer.test.ts` | |
| `test/core/learning-pipeline.test.ts` | |
| `test/core/learning-chat.test.ts` | |
| `test/core/prompt-tracker.test.ts` | |
| `test/server/learning-api.test.ts` | |

### Modified files

| File | Change |
|---|---|
| `src/llm/prompt-loader.ts` | Extend `PromptName` and `PROMPT_FILE_MAP` with three new prompt names. |
| `src/core/main-agent.ts` | Constructor accepts `PromptTracker` + `LearningPipeline?`. Hook `create_agent` and `kill_agent`. Wire `send_to_agent` / `respond_to_agent` into `PromptTracker`. |
| `src/server/ws-handler.ts` | Add `learning_message` and `learning_stop` cases. |
| `src/server/index.ts` | Add `/api/learning/*` routes; pass `learningStore` / `learningPipeline` / `learningChat` through `startServer` options. |
| `src/server/chat-broadcaster.ts` | No interface change — `broadcast(message)` already accepts any `{ type; [k]: any }`. Learning messages use existing shape. (No edit needed unless we tighten the type; keep flexible for V1.) |
| `src/main.ts` | Construct `LearningStore`, `ChangeTracker`, `LearningSummarizer`, `LearningPipeline`, `LearningChat`, `PromptTracker`. Wire into `MainAgent` and `startServer`. |
| `web/index.html` | Replace `#evidence-view` placeholder content with learning list + detail containers. |
| `web/app.js` | Import `web/learning.js`; on WS connect, route `learning_*` messages to its handlers. |
| `web/styles.css` | Add `.learning-*` rules. |
| `test/core/main-agent.test.ts` | Extend: mock pipeline + tracker; assert hooks fire. |
| `test/server/ws-handler.test.ts` | Extend: route learning messages. |

---

## Task 1: Types + schema migration

**Files:**
- Create: `src/core/learning-types.ts`
- Modify: `src/persistence/conversation-store.ts:5-18` (append schema block)

- [ ] **Step 1: Write the types file**

```ts
// src/core/learning-types.ts
export type LearningEntryStatus = "active" | "archived";
export type LearningSourceType = "agent" | "merged";
export type LearningMessageRole = "user" | "assistant";

export interface SourceAgentRef {
	sessionId: string;
	sessionName: string;
	baseRef: string;   // commit or stash-tree SHA
	endRef: string;    // commit SHA resolved at kill time
	cwd: string;
}

export interface KeyFileRef {
	path: string;
	role: string;
}

export interface SummaryJson {
	title: string;
	what_changed: string;
	why: string;
	key_files: KeyFileRef[];
	design_points: string[];
	learning_hooks: string[];
}

export interface DiffFileEntry {
	path: string;
	status: "added" | "modified" | "deleted" | "renamed";
}

export interface DiffStats {
	filesChanged: number;
	additions: number;
	deletions: number;
	filesList: DiffFileEntry[];
}

export interface DiffResult extends DiffStats {
	rawDiff: string;
}

export interface LearningEntry {
	id: string;
	title: string;
	status: LearningEntryStatus;
	sourceType: LearningSourceType;
	sourceAgents: SourceAgentRef[];
	agentPrompts: string[];
	summaryJson: SummaryJson;
	diffStats: DiffStats;
	diffBlobPath: string;
	memoryFlushedAt: number | null;
	createdAt: number;
	updatedAt: number;
}

export type LearningEntrySummary = Omit<
	LearningEntry,
	"summaryJson" | "agentPrompts" | "diffBlobPath"
>;

export interface LearningMessage {
	id: number;
	entryId: string;
	role: LearningMessageRole;
	content: string;
	createdAt: number;
}

export interface CreateLearningEntryInput {
	title: string;
	sourceType: LearningSourceType;
	sourceAgents: SourceAgentRef[];
	agentPrompts: string[];
	summaryJson: SummaryJson;
	diffStats: DiffStats;
	rawDiff: string;
}
```

- [ ] **Step 2: Write a failing schema test**

Add `test/core/learning-store.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationStore } from "../../src/persistence/conversation-store.js";

describe("learning tables schema", () => {
	let tmpDir: string;
	let db: Database.Database;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "cliclaw-learning-schema-"));
		db = new Database(join(tmpDir, "test.sqlite"));
		db.pragma("journal_mode = WAL");
		new ConversationStore(db); // triggers schema creation
	});

	afterEach(async () => {
		db.close();
		await rm(tmpDir, { recursive: true, force: true });
	});

	it("creates learning_entries table", () => {
		const row = db
			.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='learning_entries'")
			.get();
		expect(row).toBeDefined();
	});

	it("creates learning_messages table with cascade delete", () => {
		const row = db
			.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='learning_messages'")
			.get();
		expect(row).toBeDefined();

		db.prepare(`INSERT INTO learning_entries
			(id, title, status, source_type, source_agents, agent_prompts, summary_json, diff_stats, diff_blob_path, created_at, updated_at)
			VALUES ('lrn_x','t','active','agent','[]','[]','{}','{}','/tmp/x.diff', 1, 1)`).run();
		db.prepare(`INSERT INTO learning_messages (entry_id, role, content, created_at) VALUES ('lrn_x','user','hi', 1)`).run();
		db.prepare(`DELETE FROM learning_entries WHERE id='lrn_x'`).run();
		const msgCount = db.prepare(`SELECT COUNT(*) AS n FROM learning_messages WHERE entry_id='lrn_x'`).get() as { n: number };
		expect(msgCount.n).toBe(0);
	});

	it("creates the status+updated_at index", () => {
		const row = db
			.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_learning_entries_status_updated'")
			.get();
		expect(row).toBeDefined();
	});
});
```

- [ ] **Step 3: Run test — expect FAIL**

```bash
npx vitest run test/core/learning-store.test.ts
```

Expected: 3 tests fail (tables don't exist yet).

- [ ] **Step 4: Extend `SCHEMA_SQL` in `src/persistence/conversation-store.ts`**

Append to the existing `SCHEMA_SQL` constant (after the existing `CREATE TABLE` statements):

```sql
CREATE TABLE IF NOT EXISTS learning_entries (
	id TEXT PRIMARY KEY,
	title TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'active',
	source_type TEXT NOT NULL,
	source_agents TEXT NOT NULL,
	agent_prompts TEXT NOT NULL,
	summary_json TEXT NOT NULL,
	diff_stats TEXT NOT NULL,
	diff_blob_path TEXT NOT NULL,
	memory_flushed_at INTEGER,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_learning_entries_status_updated
	ON learning_entries(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS learning_messages (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	entry_id TEXT NOT NULL,
	role TEXT NOT NULL,
	content TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	FOREIGN KEY (entry_id) REFERENCES learning_entries(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_learning_messages_entry
	ON learning_messages(entry_id, id);
```

Also add `db.pragma("foreign_keys = ON")` in the `ConversationStore` constructor if not already present (check `src/persistence/conversation-store.ts:20-27`). Cascade delete requires it.

- [ ] **Step 5: Run test — expect PASS**

```bash
npx vitest run test/core/learning-store.test.ts
```

Expected: all 3 pass.

- [ ] **Step 6: Commit**

```bash
npm run format
git add src/core/learning-types.ts src/persistence/conversation-store.ts test/core/learning-store.test.ts
git commit -m "feat(learning): add learning tables + shared types"
```

---

## Task 2: `LearningStore` — entries CRUD + diff blob I/O

**Files:**
- Create: `src/core/learning-store.ts`
- Modify: `test/core/learning-store.test.ts` (append entry CRUD tests)

- [ ] **Step 1: Write failing test for `create` + `loadEntry`**

Append to `test/core/learning-store.test.ts` (inside a new `describe("LearningStore entries")` block, with its own beforeEach that also creates a temp diff dir):

```ts
import { LearningStore } from "../../src/core/learning-store.js";
import type { CreateLearningEntryInput } from "../../src/core/learning-types.js";

function makeInput(overrides: Partial<CreateLearningEntryInput> = {}): CreateLearningEntryInput {
	return {
		title: "Test entry",
		sourceType: "agent",
		sourceAgents: [{ sessionId: "s1", sessionName: "cliclaw-a", baseRef: "deadbeef", endRef: "cafef00d", cwd: "/tmp/repo" }],
		agentPrompts: ["do the thing"],
		summaryJson: { title: "Test entry", what_changed: "", why: "", key_files: [], design_points: [], learning_hooks: [] },
		diffStats: { filesChanged: 1, additions: 5, deletions: 2, filesList: [{ path: "src/a.ts", status: "modified" }] },
		rawDiff: "diff --git a/src/a.ts b/src/a.ts\n...",
		...overrides,
	};
}

describe("LearningStore entries", () => {
	let tmpDir: string;
	let db: Database.Database;
	let store: LearningStore;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "cliclaw-learning-store-"));
		db = new Database(join(tmpDir, "test.sqlite"));
		db.pragma("journal_mode = WAL");
		db.pragma("foreign_keys = ON");
		new ConversationStore(db);
		store = new LearningStore(db, join(tmpDir, "diffs"));
	});

	afterEach(async () => {
		db.close();
		await rm(tmpDir, { recursive: true, force: true });
	});

	it("creates an entry and writes diff blob", async () => {
		const input = makeInput();
		const entry = await store.create(input);
		expect(entry.id).toMatch(/^lrn_/);
		expect(entry.status).toBe("active");
		expect(entry.diffBlobPath).toContain(entry.id);
		const loaded = await store.loadEntry(entry.id);
		expect(loaded?.title).toBe("Test entry");
	});

	it("reads back the raw diff via readDiffBlob", async () => {
		const entry = await store.create(makeInput({ rawDiff: "XYZ-DIFF-CONTENT" }));
		const content = await store.readDiffBlob(entry.id);
		expect(content).toBe("XYZ-DIFF-CONTENT");
	});

	it("list() orders by updated_at DESC and filters by status", async () => {
		const a = await store.create(makeInput({ title: "A" }));
		await new Promise((r) => setTimeout(r, 5));
		const b = await store.create(makeInput({ title: "B" }));
		await store.setStatus(a.id, "archived");
		const active = await store.list({ status: "active" });
		expect(active.map((e) => e.id)).toEqual([b.id]);
		const archived = await store.list({ status: "archived" });
		expect(archived.map((e) => e.id)).toEqual([a.id]);
	});

	it("updateTitle and markMemoryFlushed bump updated_at", async () => {
		const entry = await store.create(makeInput());
		const before = entry.updatedAt;
		await new Promise((r) => setTimeout(r, 5));
		await store.updateTitle(entry.id, "New title");
		const loaded = await store.loadEntry(entry.id);
		expect(loaded?.title).toBe("New title");
		expect(loaded!.updatedAt).toBeGreaterThan(before);
	});

	it("replaceSummary overwrites summary_json only", async () => {
		const entry = await store.create(makeInput());
		const next: SummaryJson = { title: "X", what_changed: "changed", why: "w", key_files: [], design_points: [], learning_hooks: [] };
		await store.replaceSummary(entry.id, next);
		const loaded = await store.loadEntry(entry.id);
		expect(loaded?.summaryJson.what_changed).toBe("changed");
	});

	it("delete() removes entry, cascades messages, removes diff blob file", async () => {
		const entry = await store.create(makeInput());
		await store.appendMessage(entry.id, "user", "hi");
		const blobPath = entry.diffBlobPath;
		await store.delete(entry.id);
		expect(await store.loadEntry(entry.id)).toBeNull();
		const msgs = await store.loadMessages(entry.id);
		expect(msgs).toEqual([]);
		const fsCheck = await import("node:fs/promises");
		await expect(fsCheck.access(blobPath)).rejects.toThrow();
	});
});
```

Add the `SummaryJson` import at the top of the describe block's scope.

- [ ] **Step 2: Run test — expect FAIL**

```bash
npx vitest run test/core/learning-store.test.ts
```

Expected: import error for `LearningStore` (module not found).

- [ ] **Step 3: Implement `LearningStore`**

```ts
// src/core/learning-store.ts
import type Database from "better-sqlite3";
import { mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { ulid } from "../utils/ulid.js";
import type {
	CreateLearningEntryInput,
	LearningEntry,
	LearningEntryStatus,
	LearningEntrySummary,
	LearningMessage,
	LearningMessageRole,
	SummaryJson,
} from "./learning-types.js";

interface EntryRow {
	id: string;
	title: string;
	status: LearningEntryStatus;
	source_type: "agent" | "merged";
	source_agents: string;
	agent_prompts: string;
	summary_json: string;
	diff_stats: string;
	diff_blob_path: string;
	memory_flushed_at: number | null;
	created_at: number;
	updated_at: number;
}

export class LearningStore {
	private db: Database.Database;
	private diffDir: string;

	constructor(db: Database.Database, diffDir: string) {
		this.db = db;
		this.diffDir = diffDir;
	}

	private async ensureDiffDir(): Promise<void> {
		await mkdir(this.diffDir, { recursive: true });
	}

	private rowToEntry(row: EntryRow): LearningEntry {
		return {
			id: row.id,
			title: row.title,
			status: row.status,
			sourceType: row.source_type,
			sourceAgents: JSON.parse(row.source_agents),
			agentPrompts: JSON.parse(row.agent_prompts),
			summaryJson: JSON.parse(row.summary_json),
			diffStats: JSON.parse(row.diff_stats),
			diffBlobPath: row.diff_blob_path,
			memoryFlushedAt: row.memory_flushed_at,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		};
	}

	private toSummary(entry: LearningEntry): LearningEntrySummary {
		const { summaryJson, agentPrompts, diffBlobPath, ...rest } = entry;
		return rest;
	}

	async create(input: CreateLearningEntryInput): Promise<LearningEntry> {
		await this.ensureDiffDir();
		const id = `lrn_${ulid()}`;
		const now = Date.now();
		const diffBlobPath = join(this.diffDir, `${id}.diff`);
		await writeFile(diffBlobPath, input.rawDiff, "utf-8");
		this.db.prepare(`INSERT INTO learning_entries
			(id, title, status, source_type, source_agents, agent_prompts, summary_json, diff_stats, diff_blob_path, memory_flushed_at, created_at, updated_at)
			VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ?, NULL, ?, ?)`).run(
			id, input.title, input.sourceType,
			JSON.stringify(input.sourceAgents),
			JSON.stringify(input.agentPrompts),
			JSON.stringify(input.summaryJson),
			JSON.stringify(input.diffStats),
			diffBlobPath, now, now,
		);
		return (await this.loadEntry(id))!;
	}

	async loadEntry(id: string): Promise<LearningEntry | null> {
		const row = this.db.prepare("SELECT * FROM learning_entries WHERE id = ?").get(id) as EntryRow | undefined;
		return row ? this.rowToEntry(row) : null;
	}

	async list(opts: { status?: LearningEntryStatus; limit?: number; offset?: number } = {}): Promise<LearningEntrySummary[]> {
		const status = opts.status ?? "active";
		const limit = opts.limit ?? 100;
		const offset = opts.offset ?? 0;
		const rows = this.db.prepare(
			"SELECT * FROM learning_entries WHERE status = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?",
		).all(status, limit, offset) as EntryRow[];
		return rows.map((r) => this.toSummary(this.rowToEntry(r)));
	}

	async updateTitle(id: string, title: string): Promise<void> {
		this.db.prepare("UPDATE learning_entries SET title = ?, updated_at = ? WHERE id = ?").run(title, Date.now(), id);
	}

	async setStatus(id: string, status: LearningEntryStatus): Promise<void> {
		this.db.prepare("UPDATE learning_entries SET status = ?, updated_at = ? WHERE id = ?").run(status, Date.now(), id);
	}

	async replaceSummary(id: string, summary: SummaryJson): Promise<void> {
		this.db.prepare("UPDATE learning_entries SET summary_json = ?, title = ?, updated_at = ? WHERE id = ?")
			.run(JSON.stringify(summary), summary.title, Date.now(), id);
	}

	async markMemoryFlushed(id: string, at: number): Promise<void> {
		this.db.prepare("UPDATE learning_entries SET memory_flushed_at = ?, updated_at = ? WHERE id = ?")
			.run(at, Date.now(), id);
	}

	async delete(id: string): Promise<void> {
		const row = await this.loadEntry(id);
		this.db.prepare("DELETE FROM learning_entries WHERE id = ?").run(id);
		if (row) {
			try { await unlink(row.diffBlobPath); } catch { /* ignore missing file */ }
		}
	}

	async appendMessage(entryId: string, role: LearningMessageRole, content: string): Promise<void> {
		const now = Date.now();
		this.db.prepare("INSERT INTO learning_messages (entry_id, role, content, created_at) VALUES (?, ?, ?, ?)")
			.run(entryId, role, content, now);
		this.db.prepare("UPDATE learning_entries SET updated_at = ? WHERE id = ?").run(now, entryId);
	}

	async loadMessages(entryId: string): Promise<LearningMessage[]> {
		const rows = this.db.prepare(
			"SELECT id, entry_id, role, content, created_at FROM learning_messages WHERE entry_id = ? ORDER BY id ASC",
		).all(entryId) as Array<{ id: number; entry_id: string; role: LearningMessageRole; content: string; created_at: number }>;
		return rows.map((r) => ({
			id: r.id, entryId: r.entry_id, role: r.role, content: r.content, createdAt: r.created_at,
		}));
	}

	async readDiffBlob(id: string): Promise<string> {
		const entry = await this.loadEntry(id);
		if (!entry) throw new Error(`learning entry not found: ${id}`);
		return readFile(entry.diffBlobPath, "utf-8");
	}

	// Exposed for merge pipeline which writes a combined diff.
	async writeDiffBlobFor(id: string, rawDiff: string): Promise<string> {
		await this.ensureDiffDir();
		const path = join(this.diffDir, `${id}.diff`);
		await writeFile(path, rawDiff, "utf-8");
		return path;
	}

	toSummaryFor(entry: LearningEntry): LearningEntrySummary {
		return this.toSummary(entry);
	}
}
```

Check whether `src/utils/ulid.ts` exists. If not, create a minimal one:

```ts
// src/utils/ulid.ts
import { randomBytes } from "node:crypto";
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export function ulid(): string {
	const time = Date.now();
	let timeStr = "";
	let t = time;
	for (let i = 0; i < 10; i++) { timeStr = ALPHABET[t % 32] + timeStr; t = Math.floor(t / 32); }
	const rand = randomBytes(10);
	let randStr = "";
	for (let i = 0; i < 10; i++) { randStr += ALPHABET[rand[i] % 32]; }
	return timeStr + randStr;
}
```

If an existing helper exists, import that instead — adjust the `ulid` import accordingly.

- [ ] **Step 4: Run test — expect PASS**

```bash
npx vitest run test/core/learning-store.test.ts
```

Expected: all entries-CRUD tests pass (schema tests from Task 1 still pass too).

- [ ] **Step 5: Commit**

```bash
npm run format
git add src/core/learning-store.ts src/utils/ulid.ts test/core/learning-store.test.ts
git commit -m "feat(learning): add LearningStore with entries, messages, diff blob I/O"
```

---

## Task 3: `ChangeTracker` — git baseline and diff

**Files:**
- Create: `src/core/change-tracker.ts`
- Create: `test/core/change-tracker.test.ts`

- [ ] **Step 1: Write failing test using a real temp git repo**

```ts
// test/core/change-tracker.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { ChangeTracker } from "../../src/core/change-tracker.js";

function git(cwd: string, args: string): string {
	return execSync(`git ${args}`, { cwd, encoding: "utf-8" });
}

describe("ChangeTracker", () => {
	let tmpDir: string;
	let tracker: ChangeTracker;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "cliclaw-ct-"));
		git(tmpDir, "init -b main");
		git(tmpDir, "config user.email a@b.c");
		git(tmpDir, "config user.name t");
		await writeFile(join(tmpDir, "a.txt"), "hello\n");
		git(tmpDir, "add .");
		git(tmpDir, "commit -m init");
		tracker = new ChangeTracker();
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	it("returns null diff when cwd is not a git repo", async () => {
		const nonRepo = await mkdtemp(join(tmpdir(), "cliclaw-nongit-"));
		await tracker.registerAgent("s-nongit", nonRepo);
		expect(await tracker.computeDiff("s-nongit")).toBeNull();
		await rm(nonRepo, { recursive: true, force: true });
	});

	it("detects committed changes between base and head", async () => {
		await tracker.registerAgent("s1", tmpDir);
		await writeFile(join(tmpDir, "b.txt"), "world\n");
		git(tmpDir, "add .");
		git(tmpDir, "commit -m second");
		const diff = await tracker.computeDiff("s1");
		expect(diff).not.toBeNull();
		expect(diff!.filesChanged).toBe(1);
		expect(diff!.filesList[0].path).toBe("b.txt");
		expect(diff!.filesList[0].status).toBe("added");
		expect(diff!.rawDiff).toContain("+world");
	});

	it("detects unstaged changes on top of baseline", async () => {
		await tracker.registerAgent("s2", tmpDir);
		await writeFile(join(tmpDir, "a.txt"), "hello\nextra\n");
		const diff = await tracker.computeDiff("s2");
		expect(diff!.filesChanged).toBe(1);
		expect(diff!.additions).toBeGreaterThanOrEqual(1);
		expect(diff!.rawDiff).toContain("+extra");
	});

	it("baseline is dirty-tree-safe: does not push onto stash stack", async () => {
		await writeFile(join(tmpDir, "a.txt"), "dirty\n");  // uncommitted before registerAgent
		await tracker.registerAgent("s3", tmpDir);
		const stashBefore = git(tmpDir, "stash list").trim();
		const diff = await tracker.computeDiff("s3");
		expect(diff).not.toBeNull();
		const stashAfter = git(tmpDir, "stash list").trim();
		expect(stashAfter).toBe(stashBefore);
	});

	it("releaseAgent forgets the session", async () => {
		await tracker.registerAgent("s4", tmpDir);
		tracker.releaseAgent("s4");
		expect(await tracker.computeDiff("s4")).toBeNull();
	});
});
```

- [ ] **Step 2: Run test — expect FAIL (module missing)**

```bash
npx vitest run test/core/change-tracker.test.ts
```

- [ ] **Step 3: Implement `ChangeTracker`**

```ts
// src/core/change-tracker.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DiffResult, DiffFileEntry } from "./learning-types.js";
import { logger } from "../utils/logger.js";  // check actual logger path; matches existing pattern

const pexec = promisify(execFile);

interface Baseline {
	baseRef: string;
	cwd: string;
}

export class ChangeTracker {
	private baselines = new Map<string, Baseline>();

	async registerAgent(sessionId: string, cwd: string): Promise<void> {
		const baseRef = await this.captureBaseline(cwd);
		if (!baseRef) return; // non-git cwd — silently skip
		this.baselines.set(sessionId, { baseRef, cwd });
	}

	async computeDiff(sessionId: string): Promise<DiffResult | null> {
		const b = this.baselines.get(sessionId);
		if (!b) return null;
		try {
			const rawDiff = await this.runDiff(b);
			if (!rawDiff.trim()) {
				return { rawDiff: "", filesChanged: 0, additions: 0, deletions: 0, filesList: [] };
			}
			const stats = this.parseStats(rawDiff);
			return { rawDiff, ...stats };
		} catch (err) {
			logger.warn("change-tracker", `diff failed for ${sessionId}: ${(err as Error).message}`);
			return null;
		}
	}

	async resolveHeadSha(cwd: string): Promise<string | null> {
		try {
			const { stdout } = await pexec("git", ["rev-parse", "HEAD"], { cwd });
			return stdout.trim();
		} catch { return null; }
	}

	getBaseline(sessionId: string): Baseline | undefined {
		return this.baselines.get(sessionId);
	}

	releaseAgent(sessionId: string): void {
		this.baselines.delete(sessionId);
	}

	private async captureBaseline(cwd: string): Promise<string | null> {
		// Is this a git repo?
		try {
			await pexec("git", ["rev-parse", "--git-dir"], { cwd });
		} catch {
			return null;
		}
		// Is working tree dirty?
		const { stdout: status } = await pexec("git", ["status", "--porcelain"], { cwd });
		if (status.trim().length === 0) {
			// Clean — use HEAD SHA.
			const { stdout } = await pexec("git", ["rev-parse", "HEAD"], { cwd });
			return stdout.trim();
		}
		// Dirty — create a stash tree object (does NOT push onto stash stack).
		const { stdout } = await pexec("git", ["stash", "create"], { cwd });
		const sha = stdout.trim();
		// If stash create returns empty (rare), fall back to HEAD.
		if (!sha) {
			const head = await pexec("git", ["rev-parse", "HEAD"], { cwd });
			return head.stdout.trim();
		}
		return sha;
	}

	private async runDiff(b: Baseline): Promise<string> {
		// git diff <baseRef> -- includes both committed and unstaged diffs when
		// --   (no second ref) is given — it compares base against the working tree.
		const { stdout } = await pexec("git", ["diff", b.baseRef, "--"], { cwd: b.cwd, maxBuffer: 1024 * 1024 * 50 });
		return stdout;
	}

	private parseStats(rawDiff: string): Omit<DiffResult, "rawDiff"> {
		const files: DiffFileEntry[] = [];
		let additions = 0;
		let deletions = 0;
		const lines = rawDiff.split("\n");
		let currentPath: string | null = null;
		let currentStatus: DiffFileEntry["status"] = "modified";
		let newFileFlag = false;
		let deletedFileFlag = false;
		let renameFlag = false;
		for (const line of lines) {
			if (line.startsWith("diff --git ")) {
				if (currentPath) files.push({ path: currentPath, status: currentStatus });
				const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
				currentPath = match ? match[2] : null;
				currentStatus = "modified";
				newFileFlag = false;
				deletedFileFlag = false;
				renameFlag = false;
			} else if (line.startsWith("new file mode")) {
				newFileFlag = true;
			} else if (line.startsWith("deleted file mode")) {
				deletedFileFlag = true;
			} else if (line.startsWith("rename from ") || line.startsWith("rename to ")) {
				renameFlag = true;
			} else if (line.startsWith("+") && !line.startsWith("+++")) {
				additions++;
			} else if (line.startsWith("-") && !line.startsWith("---")) {
				deletions++;
			}
			if (currentPath) {
				if (newFileFlag) currentStatus = "added";
				else if (deletedFileFlag) currentStatus = "deleted";
				else if (renameFlag) currentStatus = "renamed";
			}
		}
		if (currentPath) files.push({ path: currentPath, status: currentStatus });
		return { filesChanged: files.length, additions, deletions, filesList: files };
	}
}
```

Check the logger import path — match whatever existing files use (e.g., `src/utils/logger.ts`). If no logger exists, drop the `logger.warn` line and use `console.warn` with tag prefix.

- [ ] **Step 4: Run test — expect PASS**

```bash
npx vitest run test/core/change-tracker.test.ts
```

- [ ] **Step 5: Commit**

```bash
npm run format
git add src/core/change-tracker.ts test/core/change-tracker.test.ts
git commit -m "feat(learning): add ChangeTracker for git baseline + diff"
```

---

## Task 4: Prompt templates + extend `PromptName`

**Files:**
- Create: `prompts/learning-summary.md`, `prompts/learning-chat.md`, `prompts/learning-memory.md`
- Modify: `src/llm/prompt-loader.ts:6-25`

- [ ] **Step 1: Write `prompts/learning-summary.md`**

```markdown
You are analyzing a completed sub-agent coding task to produce a structured learning summary.

You will receive:
- The task prompts that were given to the sub-agent (what was asked).
- The git diff the sub-agent produced (what actually changed).
- A list of changed files with their statuses.
- Mode: `{{mode}}` (either `agent` for a single sub-agent run, or `merged` for a combined topic across multiple runs).

Produce a valid JSON object with exactly this shape (no prose, no markdown fences — raw JSON only):

```
{
  "title": "<one-line topic, imperative, <= 60 chars>",
  "what_changed": "<markdown, 2-5 short paragraphs summarizing the changes>",
  "why": "<markdown, the motivation inferred from prompts and diff>",
  "key_files": [{ "path": "<relative path>", "role": "<one short sentence>" }],
  "design_points": ["<non-obvious decision or trade-off>", ...],
  "learning_hooks": ["<question a curious engineer might ask about this change>", ...]
}
```

Constraints:
- `key_files` covers only the files that matter for understanding the change (prioritise new modules, invariants, interfaces). Omit minor edits.
- `design_points` are non-obvious decisions visible in the diff — NOT restatements of what changed.
- `learning_hooks` are 3-5 questions the user can click to drill in. Prefer questions about mechanisms, trade-offs, and ecosystem fit.

---
AGENT PROMPTS:
{{agent_prompts}}
---
CHANGED FILES:
{{files_list}}
---
DIFF:
{{diff}}
```

- [ ] **Step 2: Write `prompts/learning-chat.md`**

```markdown
You are an assistant helping the user understand a completed code change. You have access to a structured summary of that change; use it to answer questions clearly and concretely. Stay focused on THIS change — if the user asks about unrelated code, note that you can only speak to what's in the summary below.

Tone: direct, technical, teaching-oriented. Favour concrete examples grounded in the files listed below.

---
TITLE: {{title}}

WHAT CHANGED:
{{what_changed}}

WHY:
{{why}}

KEY FILES:
{{key_files}}

DESIGN POINTS:
{{design_points}}

DIFF STATS: {{diff_stats}}
---

When the user asks to see specific diff content, tell them to click "View full diff" in the UI — you do not have the raw diff inline.
```

- [ ] **Step 3: Write `prompts/learning-memory.md`**

```markdown
# {{title}}

{{what_changed}}

## Why

{{why}}

## Design points

{{design_points_list}}

## Key files

{{key_files_list}}
```

- [ ] **Step 4: Extend `PromptName` and `PROMPT_FILE_MAP` in `src/llm/prompt-loader.ts`**

```ts
export type PromptName =
	| "planner"
	| "state-analyzer"
	| "error-analyzer"
	| "session-summarizer"
	| "main-agent"
	| "history-compressor"
	| "memory-flush"
	| "memory-tidy"
	| "learning-summary"
	| "learning-chat"
	| "learning-memory";

const PROMPT_FILE_MAP: Record<PromptName, string> = {
	planner: "planner.md",
	"state-analyzer": "state-analyzer.md",
	"error-analyzer": "error-analyzer.md",
	"session-summarizer": "session-summarizer.md",
	"main-agent": "main-agent.md",
	"history-compressor": "history-compressor.md",
	"memory-flush": "memory-flush.md",
	"memory-tidy": "memory-tidy.md",
	"learning-summary": "learning-summary.md",
	"learning-chat": "learning-chat.md",
	"learning-memory": "learning-memory.md",
};
```

- [ ] **Step 5: Run full build to confirm types still compile**

```bash
npm run build
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
npm run format
git add prompts/learning-summary.md prompts/learning-chat.md prompts/learning-memory.md src/llm/prompt-loader.ts
git commit -m "feat(learning): add learning prompt templates"
```

---

## Task 5: `LearningSummarizer`

**Files:**
- Create: `src/core/learning-summarizer.ts`
- Create: `test/core/learning-summarizer.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// test/core/learning-summarizer.test.ts
import { describe, it, expect, vi } from "vitest";
import { LearningSummarizer } from "../../src/core/learning-summarizer.js";

function mockLlm(responses: string[]) {
	const calls: any[] = [];
	let i = 0;
	const stream = async function* () { /* unused here */ };
	return {
		calls,
		complete: vi.fn(async (_messages: any, opts: any) => {
			calls.push({ messages: _messages, opts });
			const content = responses[Math.min(i++, responses.length - 1)];
			return { content, contentBlocks: [], usage: { inputTokens:0, outputTokens:0, totalTokens:0 }, stopReason: "end_turn", model: "x" };
		}),
		stream,
	};
}

function mockPromptLoader() {
	return { resolve: vi.fn((_n: string, ctx: any) => `RENDERED\n${JSON.stringify(ctx)}`) };
}

const validJson = JSON.stringify({
	title: "Refactor X",
	what_changed: "changed",
	why: "because",
	key_files: [{ path: "a.ts", role: "core" }],
	design_points: ["p1"],
	learning_hooks: ["h1"],
});

describe("LearningSummarizer", () => {
	it("returns parsed SummaryJson on first success", async () => {
		const llm = mockLlm([validJson]);
		const pl = mockPromptLoader();
		const s = new LearningSummarizer(llm as any, pl as any);
		const out = await s.generate({
			agentPrompts: ["do thing"],
			diffForLLM: "diff", filesList: [{ path: "a.ts", status: "modified" }], mode: "agent",
		});
		expect(out.title).toBe("Refactor X");
		expect(llm.complete).toHaveBeenCalledTimes(1);
	});

	it("retries once on parse failure then succeeds", async () => {
		const llm = mockLlm(["not json", validJson]);
		const s = new LearningSummarizer(llm as any, mockPromptLoader() as any);
		const out = await s.generate({ agentPrompts: [], diffForLLM: "", filesList: [], mode: "agent" });
		expect(out.title).toBe("Refactor X");
		expect(llm.complete).toHaveBeenCalledTimes(2);
	});

	it("falls back to skeleton after two parse failures", async () => {
		const llm = mockLlm(["bad", "still bad"]);
		const s = new LearningSummarizer(llm as any, mockPromptLoader() as any);
		const out = await s.generate({
			agentPrompts: [], diffForLLM: "", filesList: [{ path: "x.ts", status: "modified" }], mode: "agent",
		});
		expect(out.title).toBe("Untitled (LLM error)");
		expect(out.key_files).toEqual([{ path: "x.ts", role: "" }]);
	});

	it("strips markdown fences from LLM output", async () => {
		const fenced = "```json\n" + validJson + "\n```";
		const llm = mockLlm([fenced]);
		const s = new LearningSummarizer(llm as any, mockPromptLoader() as any);
		const out = await s.generate({ agentPrompts: [], diffForLLM: "", filesList: [], mode: "agent" });
		expect(out.title).toBe("Refactor X");
	});

	it("truncates diff over 2000 lines to per-file digest", async () => {
		const llm = mockLlm([validJson]);
		const pl = mockPromptLoader();
		const s = new LearningSummarizer(llm as any, pl as any);
		const bigDiff = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join("\n");
		await s.generate({ agentPrompts: [], diffForLLM: bigDiff, filesList: [], mode: "agent" });
		const ctx = pl.resolve.mock.calls[0][1];
		const diffLen = (ctx.diff as string).split("\n").length;
		expect(diffLen).toBeLessThan(3000);
	});
});
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
npx vitest run test/core/learning-summarizer.test.ts
```

- [ ] **Step 3: Implement `LearningSummarizer`**

```ts
// src/core/learning-summarizer.ts
import type { LLMClient } from "../llm/client.js";
import type { PromptLoader } from "../llm/prompt-loader.js";
import type { SummaryJson, DiffFileEntry } from "./learning-types.js";

export interface SummarizerInput {
	agentPrompts: string[];
	diffForLLM: string;
	filesList: DiffFileEntry[];
	mode: "agent" | "merged";
}

const DIFF_LINE_LIMIT = 2000;
const PER_FILE_HEAD_LINES = 50;

export class LearningSummarizer {
	constructor(private llm: LLMClient, private prompts: PromptLoader) {}

	async generate(input: SummarizerInput): Promise<SummaryJson> {
		const prompt = this.prompts.resolve("learning-summary", {
			mode: input.mode,
			agent_prompts: input.agentPrompts.map((p, i) => `[${i + 1}] ${p}`).join("\n\n"),
			files_list: input.filesList.map((f) => `- ${f.status.toUpperCase()}  ${f.path}`).join("\n"),
			diff: this.truncateDiff(input.diffForLLM),
		});
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				const res = await this.llm.complete(
					[{ role: "user", content: prompt }],
					{ responseFormat: "json", temperature: 0.2 },
				);
				return this.parseSummary(res.content);
			} catch { /* retry */ }
		}
		return this.skeleton(input);
	}

	private truncateDiff(diff: string): string {
		const lines = diff.split("\n");
		if (lines.length <= DIFF_LINE_LIMIT) return diff;
		const digest: string[] = [];
		let keep = 0;
		let inFile = false;
		for (const line of lines) {
			if (line.startsWith("diff --git ")) {
				digest.push(line);
				inFile = true; keep = 0; continue;
			}
			if (inFile && keep < PER_FILE_HEAD_LINES) {
				digest.push(line); keep++;
			}
		}
		return digest.join("\n") + "\n[... truncated ...]";
	}

	private parseSummary(text: string): SummaryJson {
		const stripped = text.replace(/^```(?:json)?\s*/, "").replace(/\s*```\s*$/, "").trim();
		const parsed = JSON.parse(stripped);
		if (typeof parsed.title !== "string" || typeof parsed.what_changed !== "string") {
			throw new Error("missing required fields");
		}
		return {
			title: parsed.title,
			what_changed: parsed.what_changed,
			why: parsed.why ?? "",
			key_files: Array.isArray(parsed.key_files) ? parsed.key_files : [],
			design_points: Array.isArray(parsed.design_points) ? parsed.design_points : [],
			learning_hooks: Array.isArray(parsed.learning_hooks) ? parsed.learning_hooks : [],
		};
	}

	private skeleton(input: SummarizerInput): SummaryJson {
		return {
			title: "Untitled (LLM error)",
			what_changed: `LLM summary unavailable. ${input.filesList.length} files changed.`,
			why: "",
			key_files: input.filesList.map((f) => ({ path: f.path, role: "" })),
			design_points: [],
			learning_hooks: [],
		};
	}
}
```

- [ ] **Step 4: Run test — expect PASS**

```bash
npx vitest run test/core/learning-summarizer.test.ts
```

- [ ] **Step 5: Commit**

```bash
npm run format
git add src/core/learning-summarizer.ts test/core/learning-summarizer.test.ts
git commit -m "feat(learning): add LearningSummarizer with retry and skeleton fallback"
```

---

## Task 6: `PromptTracker` — per-sub-agent prompt collector

**Files:**
- Create: `src/core/prompt-tracker.ts`
- Create: `test/core/prompt-tracker.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// test/core/prompt-tracker.test.ts
import { describe, it, expect } from "vitest";
import { PromptTracker } from "../../src/core/prompt-tracker.js";

describe("PromptTracker", () => {
	it("records prompts per sessionId in order", () => {
		const t = new PromptTracker();
		t.record("s1", "first");
		t.record("s1", "second");
		t.record("s2", "other");
		expect(t.getFor("s1")).toEqual(["first", "second"]);
		expect(t.getFor("s2")).toEqual(["other"]);
		expect(t.getFor("unknown")).toEqual([]);
	});

	it("release clears a session", () => {
		const t = new PromptTracker();
		t.record("s1", "a");
		t.release("s1");
		expect(t.getFor("s1")).toEqual([]);
	});
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement**

```ts
// src/core/prompt-tracker.ts
export class PromptTracker {
	private map = new Map<string, string[]>();

	record(sessionId: string, prompt: string): void {
		const arr = this.map.get(sessionId) ?? [];
		arr.push(prompt);
		this.map.set(sessionId, arr);
	}

	getFor(sessionId: string): string[] {
		return this.map.get(sessionId)?.slice() ?? [];
	}

	release(sessionId: string): void {
		this.map.delete(sessionId);
	}
}
```

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
npm run format
git add src/core/prompt-tracker.ts test/core/prompt-tracker.test.ts
git commit -m "feat(learning): add PromptTracker for per-session prompt collection"
```

---

## Task 7: `LearningPipeline` — orchestrator

**Files:**
- Create: `src/core/learning-pipeline.ts`
- Create: `test/core/learning-pipeline.test.ts`

- [ ] **Step 1: Write failing tests covering all four methods**

```ts
// test/core/learning-pipeline.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { ConversationStore } from "../../src/persistence/conversation-store.js";
import { LearningStore } from "../../src/core/learning-store.js";
import { ChangeTracker } from "../../src/core/change-tracker.js";
import { LearningPipeline } from "../../src/core/learning-pipeline.js";

function g(cwd: string, a: string) { return execSync(`git ${a}`, { cwd, encoding: "utf-8" }); }

describe("LearningPipeline", () => {
	let tmpDir: string;
	let db: Database.Database;
	let store: LearningStore;
	let tracker: ChangeTracker;
	let summarizer: any;
	let memoryStore: any;
	let broadcaster: any;
	let pipeline: LearningPipeline;
	let repoDir: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "cliclaw-lp-"));
		db = new Database(join(tmpDir, "x.sqlite"));
		db.pragma("journal_mode = WAL"); db.pragma("foreign_keys = ON");
		new ConversationStore(db);
		store = new LearningStore(db, join(tmpDir, "diffs"));
		tracker = new ChangeTracker();
		summarizer = { generate: vi.fn().mockResolvedValue({
			title: "S", what_changed: "w", why: "y", key_files: [], design_points: [], learning_hooks: [] }) };
		memoryStore = { edit: vi.fn().mockResolvedValue({ success: true, path: "memory/learning/x.md" }) };
		broadcaster = { broadcast: vi.fn() };
		pipeline = new LearningPipeline({ store, tracker, summarizer, memoryStore, broadcaster,
			promptLoader: { resolve: vi.fn(() => "MD") } });

		repoDir = join(tmpDir, "repo");
		await import("node:fs/promises").then((fs) => fs.mkdir(repoDir));
		g(repoDir, "init -b main");
		g(repoDir, "config user.email a@b.c"); g(repoDir, "config user.name t");
		await writeFile(join(repoDir, "a.txt"), "base\n"); g(repoDir, "add ."); g(repoDir, "commit -m init");
	});

	afterEach(async () => { db.close(); await rm(tmpDir, { recursive: true, force: true }); });

	it("ingestAgentKill creates entry on non-empty diff", async () => {
		await tracker.registerAgent("s1", repoDir);
		await writeFile(join(repoDir, "b.txt"), "new\n");
		const entry = await pipeline.ingestAgentKill({
			sessionId: "s1", sessionName: "cliclaw-a", cwd: repoDir, agentPrompts: ["make b"],
		});
		expect(entry).not.toBeNull();
		expect(entry!.sourceType).toBe("agent");
		expect(broadcaster.broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: "learning_entry_created" }));
	});

	it("ingestAgentKill skips on empty diff", async () => {
		await tracker.registerAgent("s2", repoDir);
		const entry = await pipeline.ingestAgentKill({
			sessionId: "s2", sessionName: "n", cwd: repoDir, agentPrompts: [],
		});
		expect(entry).toBeNull();
		expect(broadcaster.broadcast).not.toHaveBeenCalled();
	});

	it("ingestAgentKill isolates LLM errors (still creates entry with skeleton)", async () => {
		summarizer.generate.mockResolvedValueOnce({
			title: "Untitled (LLM error)", what_changed: "", why: "", key_files: [], design_points: [], learning_hooks: [],
		});
		await tracker.registerAgent("s3", repoDir);
		await writeFile(join(repoDir, "c.txt"), "c\n");
		const entry = await pipeline.ingestAgentKill({ sessionId: "s3", sessionName: "n", cwd: repoDir, agentPrompts: [] });
		expect(entry).not.toBeNull();
		expect(entry!.title).toBe("Untitled (LLM error)");
	});

	it("merge archives originals and creates merged entry", async () => {
		await tracker.registerAgent("sA", repoDir);
		await writeFile(join(repoDir, "a1.txt"), "1\n");
		const eA = await pipeline.ingestAgentKill({ sessionId: "sA", sessionName: "A", cwd: repoDir, agentPrompts: ["A"] });
		await tracker.registerAgent("sB", repoDir);
		await writeFile(join(repoDir, "a2.txt"), "2\n");
		const eB = await pipeline.ingestAgentKill({ sessionId: "sB", sessionName: "B", cwd: repoDir, agentPrompts: ["B"] });

		const merged = await pipeline.merge([eA!.id, eB!.id]);
		expect(merged.sourceType).toBe("merged");
		expect(merged.sourceAgents).toHaveLength(2);
		expect((await store.loadEntry(eA!.id))!.status).toBe("archived");
		expect((await store.loadEntry(eB!.id))!.status).toBe("archived");
	});

	it("merge refuses archived inputs", async () => {
		await tracker.registerAgent("sX", repoDir);
		await writeFile(join(repoDir, "x.txt"), "x\n");
		const e = await pipeline.ingestAgentKill({ sessionId: "sX", sessionName: "X", cwd: repoDir, agentPrompts: [] });
		await store.setStatus(e!.id, "archived");
		await expect(pipeline.merge([e!.id])).rejects.toThrow(/archived/);
	});

	it("regenerate replaces summary_json", async () => {
		await tracker.registerAgent("sR", repoDir);
		await writeFile(join(repoDir, "r.txt"), "r\n");
		const e = await pipeline.ingestAgentKill({ sessionId: "sR", sessionName: "R", cwd: repoDir, agentPrompts: [] });
		summarizer.generate.mockResolvedValueOnce({
			title: "New", what_changed: "nw", why: "", key_files: [], design_points: [], learning_hooks: [],
		});
		const after = await pipeline.regenerate(e!.id);
		expect(after.title).toBe("New");
	});

	it("flushToMemory writes memory file and marks flushed", async () => {
		await tracker.registerAgent("sF", repoDir);
		await writeFile(join(repoDir, "f.txt"), "f\n");
		const e = await pipeline.ingestAgentKill({ sessionId: "sF", sessionName: "F", cwd: repoDir, agentPrompts: [] });
		await pipeline.flushToMemory(e!.id);
		expect(memoryStore.edit).toHaveBeenCalledWith(expect.objectContaining({
			mode: "overwrite",
			path: `learning/${e!.id}.md`,
		}));
		const reloaded = await store.loadEntry(e!.id);
		expect(reloaded!.memoryFlushedAt).not.toBeNull();
	});
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement**

```ts
// src/core/learning-pipeline.ts
import type { ChatBroadcaster } from "../server/chat-broadcaster.js";
import type { MemoryStore } from "../memory/store.js";
import type { PromptLoader } from "../llm/prompt-loader.js";
import type { ChangeTracker } from "./change-tracker.js";
import type { LearningStore } from "./learning-store.js";
import type { LearningSummarizer } from "./learning-summarizer.js";
import type { LearningEntry, LearningEntrySummary, DiffResult, SourceAgentRef, DiffStats } from "./learning-types.js";

export interface LearningPipelineDeps {
	store: LearningStore;
	tracker: ChangeTracker;
	summarizer: LearningSummarizer;
	memoryStore: MemoryStore;
	broadcaster: ChatBroadcaster;
	promptLoader: PromptLoader;
}

export interface IngestAgentKillCtx {
	sessionId: string;
	sessionName: string;
	cwd: string;
	agentPrompts: string[];
}

function toSummary(entry: LearningEntry): LearningEntrySummary {
	const { summaryJson, agentPrompts, diffBlobPath, ...rest } = entry;
	return rest;
}

export class LearningPipeline {
	constructor(private deps: LearningPipelineDeps) {}

	async ingestAgentKill(ctx: IngestAgentKillCtx): Promise<LearningEntry | null> {
		try {
			const diff = await this.deps.tracker.computeDiff(ctx.sessionId);
			if (!diff || diff.filesChanged === 0) return null;
			const baseline = this.deps.tracker.getBaseline(ctx.sessionId);
			const endRef = (await this.deps.tracker.resolveHeadSha(ctx.cwd)) ?? "HEAD";
			const summary = await this.deps.summarizer.generate({
				agentPrompts: ctx.agentPrompts, diffForLLM: diff.rawDiff, filesList: diff.filesList, mode: "agent",
			});
			const sourceAgents: SourceAgentRef[] = [{
				sessionId: ctx.sessionId, sessionName: ctx.sessionName,
				baseRef: baseline?.baseRef ?? "", endRef, cwd: ctx.cwd,
			}];
			const entry = await this.deps.store.create({
				title: summary.title, sourceType: "agent", sourceAgents,
				agentPrompts: ctx.agentPrompts, summaryJson: summary,
				diffStats: this.toDiffStats(diff), rawDiff: diff.rawDiff,
			});
			this.deps.broadcaster.broadcast({ type: "learning_entry_created", entry: toSummary(entry) });
			return entry;
		} catch (err) {
			// Never let learning block kill path. Log and return null.
			console.warn("[learning-pipeline] ingestAgentKill failed:", (err as Error).message);
			return null;
		}
	}

	async merge(ids: string[], titleOverride?: string): Promise<LearningEntry> {
		if (ids.length < 2) throw new Error("merge needs at least 2 entries");
		const entries: LearningEntry[] = [];
		for (const id of ids) {
			const e = await this.deps.store.loadEntry(id);
			if (!e) throw new Error(`entry not found: ${id}`);
			if (e.status !== "active") throw new Error(`cannot merge archived entry: ${id}`);
			entries.push(e);
		}
		entries.sort((a, b) => a.updatedAt - b.updatedAt);
		const diffChunks = await Promise.all(entries.map((e) => this.deps.store.readDiffBlob(e.id)));
		const mergedDiff = diffChunks.join("\n");
		const mergedPrompts = entries.flatMap((e) => e.agentPrompts);
		const mergedStats = this.mergeStats(entries.map((e) => e.diffStats));
		const summary = await this.deps.summarizer.generate({
			agentPrompts: mergedPrompts, diffForLLM: mergedDiff,
			filesList: mergedStats.filesList, mode: "merged",
		});
		if (titleOverride) summary.title = titleOverride;
		const created = await this.deps.store.create({
			title: summary.title, sourceType: "merged",
			sourceAgents: entries.flatMap((e) => e.sourceAgents),
			agentPrompts: mergedPrompts, summaryJson: summary,
			diffStats: mergedStats, rawDiff: mergedDiff,
		});
		for (const e of entries) {
			await this.deps.store.setStatus(e.id, "archived");
			const updated = (await this.deps.store.loadEntry(e.id))!;
			this.deps.broadcaster.broadcast({ type: "learning_entry_updated", entry: toSummary(updated) });
		}
		this.deps.broadcaster.broadcast({ type: "learning_entry_created", entry: toSummary(created) });
		return created;
	}

	async regenerate(id: string): Promise<LearningEntry> {
		const entry = await this.deps.store.loadEntry(id);
		if (!entry) throw new Error(`entry not found: ${id}`);
		const rawDiff = await this.deps.store.readDiffBlob(id);
		const summary = await this.deps.summarizer.generate({
			agentPrompts: entry.agentPrompts, diffForLLM: rawDiff,
			filesList: entry.diffStats.filesList, mode: entry.sourceType,
		});
		await this.deps.store.replaceSummary(id, summary);
		const updated = (await this.deps.store.loadEntry(id))!;
		this.deps.broadcaster.broadcast({ type: "learning_entry_updated", entry: toSummary(updated) });
		return updated;
	}

	async flushToMemory(id: string): Promise<LearningEntry> {
		const entry = await this.deps.store.loadEntry(id);
		if (!entry) throw new Error(`entry not found: ${id}`);
		const md = this.deps.promptLoader.resolve("learning-memory", {
			title: entry.summaryJson.title,
			what_changed: entry.summaryJson.what_changed,
			why: entry.summaryJson.why,
			design_points_list: entry.summaryJson.design_points.map((p) => `- ${p}`).join("\n"),
			key_files_list: entry.summaryJson.key_files.map((k) => `- \`${k.path}\` — ${k.role}`).join("\n"),
		});
		await this.deps.memoryStore.edit({
			mode: "overwrite", path: `learning/${entry.id}.md`, content: md,
		});
		await this.deps.store.markMemoryFlushed(id, Date.now());
		const updated = (await this.deps.store.loadEntry(id))!;
		this.deps.broadcaster.broadcast({ type: "learning_entry_updated", entry: toSummary(updated) });
		return updated;
	}

	private toDiffStats(diff: DiffResult): DiffStats {
		return {
			filesChanged: diff.filesChanged, additions: diff.additions,
			deletions: diff.deletions, filesList: diff.filesList,
		};
	}

	private mergeStats(stats: DiffStats[]): DiffStats {
		const byPath = new Map<string, { path: string; status: DiffStats["filesList"][number]["status"] }>();
		let additions = 0, deletions = 0;
		for (const s of stats) {
			additions += s.additions;
			deletions += s.deletions;
			for (const f of s.filesList) byPath.set(f.path, f); // last write wins
		}
		const filesList = Array.from(byPath.values());
		return { filesChanged: filesList.length, additions, deletions, filesList };
	}
}
```

- [ ] **Step 4: Run — expect PASS**

```bash
npx vitest run test/core/learning-pipeline.test.ts
```

- [ ] **Step 5: Commit**

```bash
npm run format
git add src/core/learning-pipeline.ts test/core/learning-pipeline.test.ts
git commit -m "feat(learning): add LearningPipeline orchestrator"
```

---

## Task 8: `LearningChat` — per-entry streaming

**Files:**
- Create: `src/core/learning-chat.ts`
- Create: `test/core/learning-chat.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// test/core/learning-chat.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationStore } from "../../src/persistence/conversation-store.js";
import { LearningStore } from "../../src/core/learning-store.js";
import { LearningChat } from "../../src/core/learning-chat.js";

describe("LearningChat", () => {
	let tmpDir: string, db: Database.Database, store: LearningStore;
	let broadcaster: any, llm: any, promptLoader: any, chat: LearningChat;
	let entryId: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "cliclaw-lc-"));
		db = new Database(join(tmpDir, "x.sqlite"));
		db.pragma("journal_mode = WAL"); db.pragma("foreign_keys = ON");
		new ConversationStore(db);
		store = new LearningStore(db, join(tmpDir, "diffs"));
		broadcaster = { broadcast: vi.fn() };
		promptLoader = { resolve: vi.fn(() => "SYSTEM") };
		llm = {
			stream: vi.fn((_m, _o) => (async function*() {
				yield { type: "text_delta", delta: "hel" };
				yield { type: "text_delta", delta: "lo" };
				yield { type: "done", response: { content: "hello", contentBlocks: [], usage: {inputTokens:0,outputTokens:0,totalTokens:0}, stopReason:"end_turn", model:"x" } };
			})()),
			complete: vi.fn(),
		};
		chat = new LearningChat({ store, broadcaster, llm, promptLoader });
		const entry = await store.create({
			title: "T", sourceType: "agent", sourceAgents: [], agentPrompts: [],
			summaryJson: { title:"T", what_changed:"", why:"", key_files:[], design_points:[], learning_hooks:[] },
			diffStats: { filesChanged:0, additions:0, deletions:0, filesList:[] },
			rawDiff: "",
		});
		entryId = entry.id;
	});

	afterEach(async () => { db.close(); await rm(tmpDir, { recursive: true, force: true }); });

	it("streams deltas and persists user+assistant messages", async () => {
		await chat.handleMessage(entryId, "hi?");
		const deltas = broadcaster.broadcast.mock.calls.filter(([m]: any) => m.type === "learning_delta");
		expect(deltas.map(([m]: any) => m.delta)).toEqual(["hel", "lo"]);
		const dones = broadcaster.broadcast.mock.calls.filter(([m]: any) => m.type === "learning_done");
		expect(dones).toHaveLength(1);
		const msgs = await store.loadMessages(entryId);
		expect(msgs.map((m) => ({ role: m.role, content: m.content }))).toEqual([
			{ role: "user", content: "hi?" },
			{ role: "assistant", content: "hello" },
		]);
	});

	it("rejects concurrent message on same entry", async () => {
		const p1 = chat.handleMessage(entryId, "a");
		await expect(chat.handleMessage(entryId, "b")).rejects.toThrow(/already streaming/);
		await p1;
	});

	it("stop() aborts stream and persists partial with [interrupted]", async () => {
		llm.stream = vi.fn(() => (async function*() {
			yield { type: "text_delta", delta: "partial " };
			await new Promise((r) => setTimeout(r, 200));
			yield { type: "text_delta", delta: "finished" };
			yield { type: "done", response: { content: "partial finished", contentBlocks: [], usage:{inputTokens:0,outputTokens:0,totalTokens:0}, stopReason:"end_turn", model:"x" } };
		})());
		chat = new LearningChat({ store, broadcaster, llm, promptLoader });
		const p = chat.handleMessage(entryId, "q");
		await new Promise((r) => setTimeout(r, 30));
		chat.stop(entryId);
		await p;
		const msgs = await store.loadMessages(entryId);
		expect(msgs[1].content).toContain("[interrupted]");
		expect(msgs[1].content).toContain("partial");
	});

	it("errors on archived entry", async () => {
		await store.setStatus(entryId, "archived");
		await expect(chat.handleMessage(entryId, "q")).rejects.toThrow(/archived/);
	});
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement**

```ts
// src/core/learning-chat.ts
import type { LLMClient } from "../llm/client.js";
import type { PromptLoader } from "../llm/prompt-loader.js";
import type { LLMMessage } from "../llm/types.js";
import type { ChatBroadcaster } from "../server/chat-broadcaster.js";
import type { LearningStore } from "./learning-store.js";

export interface LearningChatDeps {
	store: LearningStore;
	broadcaster: ChatBroadcaster;
	llm: LLMClient;
	promptLoader: PromptLoader;
}

export class LearningChat {
	private active = new Map<string, { controller: AbortController; partial: string }>();

	constructor(private deps: LearningChatDeps) {}

	async handleMessage(entryId: string, content: string): Promise<void> {
		if (this.active.has(entryId)) throw new Error(`already streaming for ${entryId}`);
		const entry = await this.deps.store.loadEntry(entryId);
		if (!entry) throw new Error(`entry not found: ${entryId}`);
		if (entry.status === "archived") throw new Error(`entry is archived: ${entryId}`);
		const history = await this.deps.store.loadMessages(entryId);
		const system = this.deps.promptLoader.resolve("learning-chat", {
			title: entry.summaryJson.title,
			what_changed: entry.summaryJson.what_changed,
			why: entry.summaryJson.why,
			key_files: entry.summaryJson.key_files.map((k) => `- ${k.path} — ${k.role}`).join("\n"),
			design_points: entry.summaryJson.design_points.map((p) => `- ${p}`).join("\n"),
			diff_stats: `${entry.diffStats.filesChanged} files, +${entry.diffStats.additions} −${entry.diffStats.deletions}`,
		});
		await this.deps.store.appendMessage(entryId, "user", content);
		const messages: LLMMessage[] = [
			...history.map((m): LLMMessage => ({ role: m.role, content: m.content })),
			{ role: "user", content },
		];
		const controller = new AbortController();
		const state = { controller, partial: "" };
		this.active.set(entryId, state);
		try {
			for await (const evt of this.deps.llm.stream(messages, { systemPrompt: system, signal: controller.signal })) {
				if (evt.type === "text_delta") {
					state.partial += evt.delta;
					this.deps.broadcaster.broadcast({ type: "learning_delta", entryId, delta: evt.delta });
				}
			}
			await this.deps.store.appendMessage(entryId, "assistant", state.partial);
		} catch (err) {
			const tail = (err as any)?.name === "AbortError" ? " [interrupted]" : ` [error: ${(err as Error).message}]`;
			await this.deps.store.appendMessage(entryId, "assistant", state.partial + tail);
		} finally {
			this.active.delete(entryId);
			this.deps.broadcaster.broadcast({ type: "learning_done", entryId });
		}
	}

	stop(entryId: string): void {
		const s = this.active.get(entryId);
		if (!s) return;
		s.controller.abort();
	}
}
```

Note on abort semantics: if the provider does not respect `signal`, the abort path won't fire. The test uses setTimeout rather than provider logic — we explicitly throw `AbortError` when the controller fires inside the stream (handled below). Adjust the implementation to explicitly break on abort:

Replace the `for await` loop body with:

```ts
		try {
			for await (const evt of this.deps.llm.stream(messages, { systemPrompt: system, signal: controller.signal })) {
				if (controller.signal.aborted) {
					const e = new Error("aborted"); (e as any).name = "AbortError"; throw e;
				}
				if (evt.type === "text_delta") {
					state.partial += evt.delta;
					this.deps.broadcaster.broadcast({ type: "learning_delta", entryId, delta: evt.delta });
				}
			}
			await this.deps.store.appendMessage(entryId, "assistant", state.partial);
		} catch (err) {
```

- [ ] **Step 4: Run — expect PASS**

```bash
npx vitest run test/core/learning-chat.test.ts
```

- [ ] **Step 5: Commit**

```bash
npm run format
git add src/core/learning-chat.ts test/core/learning-chat.test.ts
git commit -m "feat(learning): add LearningChat with streaming and interrupt"
```

---

## Task 9: MainAgent wiring — prompt tracking + lifecycle hooks

**Files:**
- Modify: `src/core/main-agent.ts` (constructor, `create_agent` handler ~1320-1392, `kill_agent` handler ~1409-1500, `send_to_agent`/`respond_to_agent` handlers ~980, ~1035)
- Modify: `test/core/main-agent.test.ts`

- [ ] **Step 1: Extend `MainAgent` constructor options**

Locate the `MainAgentOptions` interface (near top of `src/core/main-agent.ts`). Add optional fields:

```ts
interface MainAgentOptions {
	// ... existing ...
	promptTracker?: PromptTracker;
	learningPipeline?: LearningPipeline;
	changeTracker?: ChangeTracker;
}
```

Store on `this`:

```ts
private promptTracker?: PromptTracker;
private learningPipeline?: LearningPipeline;
private changeTracker?: ChangeTracker;

// in constructor:
this.promptTracker = options.promptTracker;
this.learningPipeline = options.learningPipeline;
this.changeTracker = options.changeTracker;
```

Add imports at top:
```ts
import type { PromptTracker } from "./prompt-tracker.js";
import type { LearningPipeline } from "./learning-pipeline.js";
import type { ChangeTracker } from "./change-tracker.js";
```

- [ ] **Step 2: Write failing test for create_agent hook**

In `test/core/main-agent.test.ts`, add a describe block:

```ts
describe("learning hooks", () => {
	it("create_agent calls changeTracker.registerAgent", async () => {
		const changeTracker = { registerAgent: vi.fn().mockResolvedValue(undefined), releaseAgent: vi.fn(),
			computeDiff: vi.fn(), resolveHeadSha: vi.fn(), getBaseline: vi.fn() };
		const agent = makeMainAgent({ changeTracker });  // use existing helper, pass through options
		await agent.executeCreateAgent({ name: "demo", cwd: "/tmp/repo" });  // whatever the test harness calls
		expect(changeTracker.registerAgent).toHaveBeenCalledWith(expect.any(String), "/tmp/repo");
	});

	it("kill_agent calls learningPipeline.ingestAgentKill then releaseAgent", async () => {
		const pipeline = { ingestAgentKill: vi.fn().mockResolvedValue({ id: "lrn_x" }) };
		const changeTracker = { registerAgent: vi.fn(), releaseAgent: vi.fn(),
			computeDiff: vi.fn(), resolveHeadSha: vi.fn(), getBaseline: vi.fn() };
		const tracker = { record: vi.fn(), getFor: vi.fn().mockReturnValue(["p1"]), release: vi.fn() };
		const agent = makeMainAgent({ learningPipeline: pipeline, changeTracker, promptTracker: tracker });
		await agent.executeCreateAgent({ name: "demo", cwd: "/tmp/repo" });
		await agent.executeKillAgent({ agent_id: "demo" });
		expect(pipeline.ingestAgentKill).toHaveBeenCalledWith(expect.objectContaining({
			cwd: "/tmp/repo", agentPrompts: ["p1"],
		}));
		expect(tracker.release).toHaveBeenCalled();
		expect(changeTracker.releaseAgent).toHaveBeenCalled();
	});

	it("send_to_agent records the prompt via promptTracker", async () => {
		const tracker = { record: vi.fn(), getFor: vi.fn().mockReturnValue([]), release: vi.fn() };
		const agent = makeMainAgent({ promptTracker: tracker });
		await agent.executeCreateAgent({ name: "demo", cwd: "/tmp/repo" });
		await agent.executeSendToAgent({ agent_id: "demo", prompt: "do X", summary: "s" });
		expect(tracker.record).toHaveBeenCalledWith(expect.any(String), "do X");
	});
});
```

Adjust helper names (`makeMainAgent`, `executeCreateAgent`, etc.) to match the existing test file's style. If the existing tests call tools through a different surface (e.g. `handleMessage`), match that pattern.

- [ ] **Step 3: Run — expect FAIL**

- [ ] **Step 4: Splice hooks into handlers**

In `create_agent` handler (around line 1379, after `this.agents.set(...)`):

```ts
if (this.changeTracker) {
	await this.changeTracker.registerAgent(agentName, workingDir);
}
```

In `send_to_agent` handler (around line 980, right before sending the prompt to the adapter — find the point where `prompt` is about to be sent):

```ts
this.promptTracker?.record(agentName, prompt);
```

In `respond_to_agent` handler (around line 1035, same pattern with the `response` field):

```ts
this.promptTracker?.record(agentName, response);
```

In `kill_agent` handler — right after the tmux session is killed (line 1484) but BEFORE `this.cleanupAgent(agentId)`:

```ts
if (this.learningPipeline && this.changeTracker) {
	const prompts = this.promptTracker?.getFor(agentId) ?? [];
	try {
		await this.learningPipeline.ingestAgentKill({
			sessionId: agentId,
			sessionName: agentName,    // adjust to the name variable in scope
			cwd: agentRecord.workingDir,  // adjust to the record in scope
			agentPrompts: prompts,
		});
	} catch (err) {
		this.emit("log", { level: "warn", message: `learning ingest failed: ${(err as Error).message}` });
	}
	this.changeTracker.releaseAgent(agentId);
	this.promptTracker?.release(agentId);
}
```

For the multi-agent "all" kill path, do the same inside the loop.

- [ ] **Step 5: Run — expect PASS**

```bash
npx vitest run test/core/main-agent.test.ts
```

If tests reference internals that don't exist (e.g. `executeCreateAgent`), adapt them to however the file already calls tools. Keep the assertions.

- [ ] **Step 6: Commit**

```bash
npm run format
git add src/core/main-agent.ts test/core/main-agent.test.ts
git commit -m "feat(learning): hook MainAgent create_agent/kill_agent into learning pipeline"
```

---

## Task 10: REST `/api/learning/*` routes

**Files:**
- Modify: `src/server/index.ts` (add routes after line 117)
- Modify: `ServerInstance`/`startServer` options to accept `learningStore`, `learningPipeline`
- Create: `test/server/learning-api.test.ts`

- [ ] **Step 1: Extend `startServer` options type**

Locate the options interface in `src/server/index.ts` (around line 20-45, the one `startServer` takes). Add:

```ts
learningStore?: LearningStore;
learningPipeline?: LearningPipeline;
learningChat?: LearningChat;
```

And import them at top.

- [ ] **Step 2: Write failing API test**

```ts
// test/server/learning-api.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";  // if already a dep; otherwise skip and test via fetch
import { startServer } from "../../src/server/index.js";
import { ConversationStore } from "../../src/persistence/conversation-store.js";
import { LearningStore } from "../../src/core/learning-store.js";

// If supertest is not a dep, use plain fetch; adjust accordingly.

describe("learning REST API", () => {
	let tmpDir: string, db: Database.Database, store: LearningStore, server: any, pipeline: any;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "cliclaw-api-"));
		db = new Database(join(tmpDir, "x.sqlite"));
		db.pragma("journal_mode = WAL"); db.pragma("foreign_keys = ON");
		new ConversationStore(db);
		store = new LearningStore(db, join(tmpDir, "diffs"));
		pipeline = {
			merge: vi.fn(async (ids: string[]) => ({ id: "lrn_merged", title: "M",
				status: "active", sourceType: "merged", sourceAgents: [],
				agentPrompts: [], summaryJson: { title:"M", what_changed:"", why:"", key_files:[], design_points:[], learning_hooks:[] },
				diffStats: { filesChanged:0, additions:0, deletions:0, filesList:[] },
				diffBlobPath: "/tmp/x.diff", memoryFlushedAt: null, createdAt: 1, updatedAt: 1 })),
			regenerate: vi.fn(),
			flushToMemory: vi.fn(),
		};
		// Provide all required startServer deps with stubs
		server = await startServer({
			port: 0, mainAgent: { getState: () => "idle" } as any,
			broadcaster: { broadcast: vi.fn(), addClient: vi.fn(), removeClient: vi.fn() } as any,
			conversationStore: {} as any, agentStore: {} as any,
			commandRouter: {} as any,
			learningStore: store, learningPipeline: pipeline, learningChat: {} as any,
			authToken: undefined,
		});
	});

	afterEach(async () => { await server.close(); db.close(); await rm(tmpDir, { recursive: true, force: true }); });

	it("GET /api/learning returns active list", async () => {
		await store.create({
			title: "T", sourceType: "agent", sourceAgents: [], agentPrompts: [],
			summaryJson: { title:"T", what_changed:"", why:"", key_files:[], design_points:[], learning_hooks:[] },
			diffStats: { filesChanged:1, additions:1, deletions:0, filesList:[{path:"a",status:"modified"}] },
			rawDiff: "diff",
		});
		const res = await fetch(`http://127.0.0.1:${server.port}/api/learning`);
		const body = await res.json();
		expect(res.status).toBe(200);
		expect(body).toHaveLength(1);
		expect(body[0].title).toBe("T");
		expect(body[0].summaryJson).toBeUndefined(); // list excludes summary
	});

	it("GET /api/learning/:id includes summary_json", async () => {
		const e = await store.create({
			title: "T", sourceType: "agent", sourceAgents: [], agentPrompts: [],
			summaryJson: { title:"T", what_changed:"wc", why:"", key_files:[], design_points:[], learning_hooks:[] },
			diffStats: { filesChanged:0, additions:0, deletions:0, filesList:[] },
			rawDiff: "raw",
		});
		const res = await fetch(`http://127.0.0.1:${server.port}/api/learning/${e.id}`);
		const body = await res.json();
		expect(body.summaryJson.what_changed).toBe("wc");
	});

	it("GET /api/learning/:id/diff returns raw diff text", async () => {
		const e = await store.create({
			title: "T", sourceType: "agent", sourceAgents: [], agentPrompts: [],
			summaryJson: { title:"T", what_changed:"", why:"", key_files:[], design_points:[], learning_hooks:[] },
			diffStats: { filesChanged:0, additions:0, deletions:0, filesList:[] },
			rawDiff: "DIFF-CONTENT",
		});
		const res = await fetch(`http://127.0.0.1:${server.port}/api/learning/${e.id}/diff`);
		expect(res.headers.get("content-type")).toContain("text/plain");
		expect(await res.text()).toBe("DIFF-CONTENT");
	});

	it("PATCH title + status", async () => {
		const e = await store.create({
			title: "Old", sourceType: "agent", sourceAgents: [], agentPrompts: [],
			summaryJson: { title:"Old", what_changed:"", why:"", key_files:[], design_points:[], learning_hooks:[] },
			diffStats: { filesChanged:0, additions:0, deletions:0, filesList:[] }, rawDiff: "",
		});
		const res = await fetch(`http://127.0.0.1:${server.port}/api/learning/${e.id}`, {
			method: "PATCH", headers: { "content-type": "application/json" },
			body: JSON.stringify({ title: "New", status: "archived" }),
		});
		expect(res.status).toBe(200);
		const reloaded = await store.loadEntry(e.id);
		expect(reloaded!.title).toBe("New");
		expect(reloaded!.status).toBe("archived");
	});

	it("POST /api/learning/merge delegates to pipeline", async () => {
		const res = await fetch(`http://127.0.0.1:${server.port}/api/learning/merge`, {
			method: "POST", headers: { "content-type": "application/json" },
			body: JSON.stringify({ ids: ["lrn_a", "lrn_b"] }),
		});
		expect(res.status).toBe(200);
		expect(pipeline.merge).toHaveBeenCalledWith(["lrn_a", "lrn_b"], undefined);
	});

	it("DELETE removes entry", async () => {
		const e = await store.create({
			title: "T", sourceType: "agent", sourceAgents: [], agentPrompts: [],
			summaryJson: { title:"T", what_changed:"", why:"", key_files:[], design_points:[], learning_hooks:[] },
			diffStats: { filesChanged:0, additions:0, deletions:0, filesList:[] }, rawDiff: "",
		});
		const res = await fetch(`http://127.0.0.1:${server.port}/api/learning/${e.id}`, { method: "DELETE" });
		expect(res.status).toBe(204);
		expect(await store.loadEntry(e.id)).toBeNull();
	});
});
```

Check whether `startServer` returns `{ port, close }` — the explorer says yes. If it returns only a `close()` method and port is bound via options, adjust the test to pass a random port and read it back. Also check the full required-deps list for `startServer`; add stubs for anything missing.

- [ ] **Step 3: Run — expect FAIL**

- [ ] **Step 4: Implement routes**

In `src/server/index.ts`, after the existing `/api/status` route (around line 117), add:

```ts
if (options.learningStore && options.learningPipeline) {
	const ls = options.learningStore;
	const lp = options.learningPipeline;

	app.get("/api/learning", async (req, res) => {
		try {
			const status = (req.query.status as any) ?? "active";
			const limit = Number(req.query.limit) || 100;
			const offset = Number(req.query.offset) || 0;
			const entries = await ls.list({ status, limit, offset });
			res.json(entries);
		} catch (e) { res.status(500).json({ error: (e as Error).message }); }
	});

	app.get("/api/learning/:id", async (req, res) => {
		const e = await ls.loadEntry(req.params.id);
		if (!e) return res.status(404).json({ error: "not found" });
		res.json(e);
	});

	app.get("/api/learning/:id/diff", async (req, res) => {
		try {
			const content = await ls.readDiffBlob(req.params.id);
			res.type("text/plain").send(content);
		} catch (e) { res.status(404).json({ error: (e as Error).message }); }
	});

	app.get("/api/learning/:id/messages", async (req, res) => {
		const msgs = await ls.loadMessages(req.params.id);
		res.json(msgs);
	});

	app.patch("/api/learning/:id", async (req, res) => {
		try {
			const { title, status } = req.body ?? {};
			if (typeof title === "string") await ls.updateTitle(req.params.id, title);
			if (status === "active" || status === "archived") await ls.setStatus(req.params.id, status);
			const updated = await ls.loadEntry(req.params.id);
			if (!updated) return res.status(404).json({ error: "not found" });
			res.json(updated);
		} catch (e) { res.status(500).json({ error: (e as Error).message }); }
	});

	app.post("/api/learning/merge", async (req, res) => {
		try {
			const { ids, title } = req.body ?? {};
			if (!Array.isArray(ids) || ids.length < 2) {
				return res.status(400).json({ error: "ids array of at least 2 required" });
			}
			const merged = await lp.merge(ids, title);
			res.json(merged);
		} catch (e) { res.status(400).json({ error: (e as Error).message }); }
	});

	app.post("/api/learning/:id/regenerate", async (req, res) => {
		try { res.json(await lp.regenerate(req.params.id)); }
		catch (e) { res.status(400).json({ error: (e as Error).message }); }
	});

	app.post("/api/learning/:id/flush-to-memory", async (req, res) => {
		try { res.json(await lp.flushToMemory(req.params.id)); }
		catch (e) { res.status(400).json({ error: (e as Error).message }); }
	});

	app.delete("/api/learning/:id", async (req, res) => {
		try { await ls.delete(req.params.id); res.status(204).end(); }
		catch (e) { res.status(500).json({ error: (e as Error).message }); }
	});
}
```

Confirm `express.json()` middleware is already mounted (it should be, for existing `/api/*` routes). If not, add `app.use(express.json())` once.

- [ ] **Step 5: Run — expect PASS**

```bash
npx vitest run test/server/learning-api.test.ts
```

- [ ] **Step 6: Commit**

```bash
npm run format
git add src/server/index.ts test/server/learning-api.test.ts
git commit -m "feat(learning): add /api/learning/* REST routes"
```

---

## Task 11: WebSocket routing for `learning_message` / `learning_stop`

**Files:**
- Modify: `src/server/ws-handler.ts:47-80`
- Modify: `test/server/ws-handler.test.ts`

- [ ] **Step 1: Extend handler setup signature**

In `src/server/ws-handler.ts`, the existing `setupWebSocketHandler` (or similar name) likely takes `{ mainAgent, commandRouter, broadcaster, ... }`. Add:

```ts
learningChat?: LearningChat;
```

Import `LearningChat`.

- [ ] **Step 2: Write failing test**

Add to `test/server/ws-handler.test.ts`:

```ts
describe("learning WS routes", () => {
	it("routes learning_message to learningChat.handleMessage", async () => {
		const learningChat = { handleMessage: vi.fn(), stop: vi.fn() };
		// Follow existing test harness — connect a WS client, send { type:'learning_message', entryId, content }
		// assert learningChat.handleMessage called with those args.
	});
	it("routes learning_stop to learningChat.stop", async () => {
		const learningChat = { handleMessage: vi.fn(), stop: vi.fn() };
		// ... send { type:'learning_stop', entryId }, assert stop called.
	});
});
```

Flesh out with the same client/connection setup the existing tests use in this file.

- [ ] **Step 3: Run — expect FAIL**

- [ ] **Step 4: Add cases to the message dispatch switch**

In the switch (around line 47), add cases before `default`:

```ts
case "learning_message":
	if (options.learningChat && typeof parsed.entryId === "string" && typeof parsed.content === "string") {
		options.learningChat.handleMessage(parsed.entryId, parsed.content).catch((err) => {
			ws.send(JSON.stringify({ type: "learning_error", entryId: parsed.entryId, message: String(err.message) }));
		});
	}
	break;
case "learning_stop":
	if (options.learningChat && typeof parsed.entryId === "string") {
		options.learningChat.stop(parsed.entryId);
	}
	break;
```

- [ ] **Step 5: Run — expect PASS**

```bash
npx vitest run test/server/ws-handler.test.ts
```

- [ ] **Step 6: Commit**

```bash
npm run format
git add src/server/ws-handler.ts test/server/ws-handler.test.ts
git commit -m "feat(learning): route learning_message/learning_stop over WebSocket"
```

---

## Task 12: Wire everything in `main.ts`

**Files:**
- Modify: `src/main.ts`

- [ ] **Step 1: Construct the new components**

In `src/main.ts`, find the block where `ConversationStore` is constructed (near the top of the bootstrap sequence). Right after it, add:

```ts
import { LearningStore } from "./core/learning-store.js";
import { ChangeTracker } from "./core/change-tracker.js";
import { LearningSummarizer } from "./core/learning-summarizer.js";
import { LearningPipeline } from "./core/learning-pipeline.js";
import { LearningChat } from "./core/learning-chat.js";
import { PromptTracker } from "./core/prompt-tracker.js";
import { homedir } from "node:os";
import { join as joinPath } from "node:path";
// ... existing imports ...

const learningDiffDir = joinPath(homedir(), ".cliclaw", "learning", "diffs");
const learningStore = new LearningStore(db, learningDiffDir);
const changeTracker = new ChangeTracker();
const promptTracker = new PromptTracker();
const learningSummarizer = new LearningSummarizer(llmClient, promptLoader);
```

(Construct `LearningPipeline` and `LearningChat` after `broadcaster` and `memoryStore` are available — adjust ordering.)

```ts
const learningPipeline = new LearningPipeline({
	store: learningStore, tracker: changeTracker, summarizer: learningSummarizer,
	memoryStore, broadcaster, promptLoader,
});
const learningChat = new LearningChat({
	store: learningStore, broadcaster, llm: llmClient, promptLoader,
});
```

- [ ] **Step 2: Pass into `MainAgent`**

Find the `new MainAgent({ ... })` call and add:

```ts
promptTracker,
learningPipeline,
changeTracker,
```

- [ ] **Step 3: Pass into `startServer`**

Find `await startServer({ ... })` and add:

```ts
learningStore,
learningPipeline,
learningChat,
```

- [ ] **Step 4: Build and run**

```bash
npm run build
```

Expected: clean build. Fix any type errors.

Smoke-run:
```bash
npm start &
SERVER_PID=$!
sleep 2
curl -s http://127.0.0.1:3120/api/learning
kill $SERVER_PID
```

Expected curl output: `[]` (empty array).

- [ ] **Step 5: Commit**

```bash
npm run format
git add src/main.ts
git commit -m "feat(learning): wire learning components into main.ts"
```

---

## Task 13: Frontend — HTML restructure + styles

**Files:**
- Modify: `web/index.html:21-44` (the `#evidence-view` container)
- Modify: `web/styles.css` (append `.learning-*` rules)

- [ ] **Step 1: Replace `#evidence-view` inner content**

```html
<div id="evidence-view" class="panel-content">
	<div id="learning-list-section">
		<div class="learning-list-header">
			<input type="text" id="learning-search" placeholder="Search entries..." />
			<div class="learning-tabs">
				<button class="learning-tab active" data-status="active">Active</button>
				<button class="learning-tab" data-status="archived">Archived</button>
			</div>
			<button id="learning-merge-btn" class="hidden">Merge selected</button>
		</div>
		<ul id="learning-list"></ul>
		<div class="learning-empty" id="learning-list-empty">
			Learning entries appear here after sub-agents finish their work.
		</div>
	</div>
	<div id="learning-resize-handle"></div>
	<div id="learning-detail-section">
		<div class="learning-detail-tabs">
			<button class="learning-detail-tab active" data-tab="summary">Summary</button>
			<button class="learning-detail-tab" data-tab="chat">Chat</button>
		</div>
		<div id="learning-summary-pane" class="learning-detail-pane active"></div>
		<div id="learning-chat-pane" class="learning-detail-pane hidden">
			<div id="learning-chat-messages"></div>
			<div class="learning-chat-input-row">
				<textarea id="learning-chat-input" placeholder="Ask about this change..."></textarea>
				<button id="learning-chat-send">Send</button>
			</div>
		</div>
		<div class="learning-detail-empty" id="learning-detail-empty">
			Select an entry to view its summary.
		</div>
	</div>
</div>
```

- [ ] **Step 2: Append styles to `web/styles.css`**

```css
#learning-list-section {
	height: 33%;
	min-height: 180px;
	display: flex;
	flex-direction: column;
	border-bottom: 1px solid #333;
	overflow: hidden;
}
.learning-list-header { display:flex; flex-direction:column; gap:6px; padding:8px; border-bottom:1px solid #2a2a2a; }
.learning-list-header input { background:#1a1a1a; border:1px solid #333; color:#ddd; padding:4px 8px; border-radius:3px; }
.learning-tabs { display:flex; gap:4px; }
.learning-tab { background:transparent; border:1px solid #333; color:#888; padding:3px 10px; cursor:pointer; border-radius:3px; font-size:12px; }
.learning-tab.active { background:#2a4a2a; color:#cfc; border-color:#4a7a4a; }
#learning-merge-btn { background:#2a4a7a; color:#cfd; border:none; padding:4px 10px; border-radius:3px; cursor:pointer; }
#learning-merge-btn.hidden { display:none; }
#learning-list { list-style:none; margin:0; padding:0; overflow-y:auto; flex:1; }
#learning-list li { padding:8px 10px; border-bottom:1px solid #222; cursor:pointer; }
#learning-list li:hover { background:#1f1f1f; }
#learning-list li.selected { background:#262633; }
#learning-list li.pulse { animation: learning-pulse 1s ease-out; }
@keyframes learning-pulse { 0% { background:#3a4a3a; } 100% { background:transparent; } }
.learning-entry-title { color:#ddd; font-weight:500; }
.learning-entry-meta { color:#777; font-size:11px; margin-top:2px; }
.learning-entry-status { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:6px; }
.learning-entry-status.active { background:#4a7a4a; }
.learning-entry-status.archived { background:transparent; border:1px solid #555; }
.learning-entry-status.flushed { background:#4a9a4a; }
#learning-resize-handle { height:4px; background:#2a2a2a; cursor:ns-resize; }
#learning-detail-section { flex:1; display:flex; flex-direction:column; overflow:hidden; }
.learning-detail-tabs { display:flex; border-bottom:1px solid #333; }
.learning-detail-tab { background:transparent; border:none; color:#888; padding:8px 16px; cursor:pointer; }
.learning-detail-tab.active { color:#cfc; border-bottom:2px solid #4a7a4a; }
.learning-detail-pane { flex:1; overflow-y:auto; padding:12px; }
.learning-detail-pane.hidden { display:none; }
.learning-empty, .learning-detail-empty { color:#666; text-align:center; padding:24px 12px; font-size:13px; }
#learning-chat-messages { flex:1; overflow-y:auto; padding:12px; }
.learning-chat-input-row { display:flex; gap:6px; padding:8px; border-top:1px solid #333; }
#learning-chat-input { flex:1; background:#1a1a1a; border:1px solid #333; color:#ddd; padding:6px; border-radius:3px; resize:vertical; min-height:40px; }
#learning-chat-send { background:#2a4a7a; color:#cfd; border:none; padding:6px 14px; border-radius:3px; cursor:pointer; }
.learning-hook-chip { display:inline-block; margin:3px 4px; padding:4px 10px; background:#2a2a3a; border:1px solid #3a3a4a; border-radius:12px; cursor:pointer; font-size:12px; color:#cdf; }
.learning-hook-chip:hover { background:#3a3a4a; }
.learning-actions { display:flex; gap:6px; margin-top:10px; padding-top:10px; border-top:1px solid #2a2a2a; }
.learning-actions button { background:#2a2a2a; color:#cfc; border:1px solid #3a3a3a; padding:4px 10px; border-radius:3px; cursor:pointer; font-size:12px; }
.learning-actions button.flushed { color:#9c9; border-color:#4a7a4a; }
```

- [ ] **Step 3: Verify in browser**

```bash
npm run build && npm start
```

Open http://127.0.0.1:3120 — right panel should show empty-state messages for both sections. Stop the server.

- [ ] **Step 4: Commit**

```bash
npm run format
git add web/index.html web/styles.css
git commit -m "feat(learning): restructure right panel for learning sessions"
```

---

## Task 14: Frontend — `web/learning.js`

**Files:**
- Create: `web/learning.js`
- Modify: `web/app.js` (import and wire)

- [ ] **Step 1: Write `web/learning.js`**

```js
// web/learning.js

let state = {
	entries: [],              // LearningEntrySummary[]
	statusFilter: "active",   // "active" | "archived"
	selectedId: null,
	detailEntry: null,        // full entry with summaryJson
	detailMessages: [],
	detailTab: "summary",     // "summary" | "chat"
	streaming: false,
	selectedIds: new Set(),   // for merge
};

let ws = null;
let apiBase = "/api/learning";

const $ = (id) => document.getElementById(id);

export function initLearning(wsRef) {
	ws = wsRef;
	attachListHandlers();
	attachDetailHandlers();
	refreshList();
}

export function handleLearningMessage(msg) {
	switch (msg.type) {
		case "learning_entry_created":
			if (msg.entry.status === state.statusFilter) {
				state.entries.unshift(msg.entry);
				renderList(msg.entry.id);
			}
			break;
		case "learning_entry_updated": {
			const idx = state.entries.findIndex((e) => e.id === msg.entry.id);
			if (idx >= 0) {
				if (msg.entry.status !== state.statusFilter) state.entries.splice(idx, 1);
				else state.entries[idx] = msg.entry;
			} else if (msg.entry.status === state.statusFilter) {
				state.entries.unshift(msg.entry);
			}
			renderList();
			if (state.selectedId === msg.entry.id) loadDetail(msg.entry.id);
			break;
		}
		case "learning_entry_deleted":
			state.entries = state.entries.filter((e) => e.id !== msg.id);
			if (state.selectedId === msg.id) { state.selectedId = null; clearDetail(); }
			renderList();
			break;
		case "learning_delta":
			if (state.selectedId === msg.entryId && state.detailTab === "chat") {
				appendDelta(msg.delta);
			}
			break;
		case "learning_done":
			if (state.selectedId === msg.entryId) finalizeStream();
			break;
		case "learning_error":
			if (state.selectedId === msg.entryId) showStreamError(msg.message);
			break;
	}
}

async function refreshList() {
	const res = await fetch(`${apiBase}?status=${state.statusFilter}`);
	state.entries = await res.json();
	renderList();
}

function renderList(pulseId) {
	const ul = $("learning-list");
	const empty = $("learning-list-empty");
	ul.innerHTML = "";
	if (state.entries.length === 0) { empty.style.display = "block"; return; }
	empty.style.display = "none";
	for (const e of state.entries) {
		const li = document.createElement("li");
		if (e.id === state.selectedId) li.classList.add("selected");
		if (e.id === pulseId) li.classList.add("pulse");
		const statusCls = e.memoryFlushedAt ? "flushed" : e.status;
		const srcLabel = e.sourceType === "merged"
			? `${e.sourceAgents.length} agents merged`
			: `agent: ${e.sourceAgents[0]?.sessionName ?? "?"}`;
		const rel = relTime(e.updatedAt);
		li.innerHTML = `
			<div>
				<input type="checkbox" class="learning-select" data-id="${e.id}" ${state.selectedIds.has(e.id) ? "checked" : ""} />
				<span class="learning-entry-status ${statusCls}"></span>
				<span class="learning-entry-title">${escape(e.title)}</span>
				<span style="float:right;color:#777;font-size:11px;">${e.diffStats.filesChanged}f +${e.diffStats.additions} −${e.diffStats.deletions}</span>
			</div>
			<div class="learning-entry-meta">${escape(srcLabel)} · ${rel}</div>`;
		li.addEventListener("click", (ev) => {
			if ((ev.target).classList.contains("learning-select")) return;
			selectEntry(e.id);
		});
		ul.appendChild(li);
	}
	updateMergeButton();
}

function updateMergeButton() {
	const btn = $("learning-merge-btn");
	if (state.selectedIds.size >= 2) btn.classList.remove("hidden");
	else btn.classList.add("hidden");
}

function attachListHandlers() {
	document.querySelectorAll(".learning-tab").forEach((t) => {
		t.addEventListener("click", () => {
			document.querySelectorAll(".learning-tab").forEach((x) => x.classList.remove("active"));
			t.classList.add("active");
			state.statusFilter = t.dataset.status;
			state.selectedIds.clear();
			refreshList();
		});
	});
	$("learning-search").addEventListener("input", (ev) => {
		const q = ev.target.value.toLowerCase();
		document.querySelectorAll("#learning-list li").forEach((li, i) => {
			const title = state.entries[i]?.title.toLowerCase() ?? "";
			li.style.display = title.includes(q) ? "" : "none";
		});
	});
	$("learning-list").addEventListener("change", (ev) => {
		const cb = ev.target;
		if (!cb.classList?.contains("learning-select")) return;
		const id = cb.dataset.id;
		if (cb.checked) state.selectedIds.add(id); else state.selectedIds.delete(id);
		updateMergeButton();
	});
	$("learning-merge-btn").addEventListener("click", async () => {
		const ids = Array.from(state.selectedIds);
		const res = await fetch(`${apiBase}/merge`, {
			method: "POST", headers: { "content-type": "application/json" },
			body: JSON.stringify({ ids }),
		});
		if (!res.ok) { alert("Merge failed: " + (await res.text())); return; }
		state.selectedIds.clear();
		await refreshList();
	});
}

async function selectEntry(id) {
	state.selectedId = id;
	state.detailTab = "summary";
	await loadDetail(id);
	renderList();
}

async function loadDetail(id) {
	const res = await fetch(`${apiBase}/${id}`);
	state.detailEntry = await res.json();
	const msgsRes = await fetch(`${apiBase}/${id}/messages`);
	state.detailMessages = await msgsRes.json();
	renderDetail();
}

function renderDetail() {
	const empty = $("learning-detail-empty");
	const summaryPane = $("learning-summary-pane");
	const chatPane = $("learning-chat-pane");
	if (!state.detailEntry) { empty.style.display = "block"; summaryPane.classList.add("hidden"); chatPane.classList.add("hidden"); return; }
	empty.style.display = "none";
	renderSummaryPane();
	renderChatPane();
	document.querySelectorAll(".learning-detail-tab").forEach((t) => {
		t.classList.toggle("active", t.dataset.tab === state.detailTab);
	});
	summaryPane.classList.toggle("hidden", state.detailTab !== "summary");
	chatPane.classList.toggle("hidden", state.detailTab !== "chat");
}

function renderSummaryPane() {
	const e = state.detailEntry;
	const s = e.summaryJson;
	const pane = $("learning-summary-pane");
	pane.innerHTML = `
		<h2>${escape(s.title)}</h2>
		<h4>What changed</h4>
		<div class="markdown">${renderMd(s.what_changed)}</div>
		<h4>Why</h4>
		<div class="markdown">${renderMd(s.why)}</div>
		<h4>Key files (${s.key_files.length})</h4>
		<ul>${s.key_files.map((k) => `<li><code>${escape(k.path)}</code> — ${escape(k.role)}</li>`).join("")}</ul>
		<button class="view-diff-btn">View full diff</button>
		<h4>Design points</h4>
		<ul>${s.design_points.map((p) => `<li>${escape(p)}</li>`).join("")}</ul>
		<h4>Learning hooks</h4>
		<div>${s.learning_hooks.map((h) => `<span class="learning-hook-chip" data-text="${escape(h)}">${escape(h)}</span>`).join("")}</div>
		<div class="learning-actions">
			<button class="regen-btn">Regenerate</button>
			<button class="flush-btn ${e.memoryFlushedAt ? "flushed" : ""}">${e.memoryFlushedAt ? "✓ Flushed" : "Flush to memory"}</button>
			<button class="archive-btn">${e.status === "archived" ? "Unarchive" : "Archive"}</button>
			<button class="delete-btn" style="margin-left:auto;color:#d77;">Delete</button>
		</div>`;
	pane.querySelector(".view-diff-btn").addEventListener("click", async () => {
		const r = await fetch(`${apiBase}/${e.id}/diff`);
		const text = await r.text();
		openDiffModal(text);
	});
	pane.querySelectorAll(".learning-hook-chip").forEach((c) => {
		c.addEventListener("click", () => {
			state.detailTab = "chat";
			renderDetail();
			$("learning-chat-input").value = c.dataset.text;
			$("learning-chat-input").focus();
		});
	});
	pane.querySelector(".regen-btn").addEventListener("click", async () => {
		await fetch(`${apiBase}/${e.id}/regenerate`, { method: "POST" });
	});
	pane.querySelector(".flush-btn").addEventListener("click", async () => {
		await fetch(`${apiBase}/${e.id}/flush-to-memory`, { method: "POST" });
	});
	pane.querySelector(".archive-btn").addEventListener("click", async () => {
		const next = e.status === "archived" ? "active" : "archived";
		await fetch(`${apiBase}/${e.id}`, {
			method: "PATCH", headers: { "content-type": "application/json" },
			body: JSON.stringify({ status: next }),
		});
	});
	pane.querySelector(".delete-btn").addEventListener("click", async () => {
		if (!confirm("Delete this learning entry? This also removes its chat and diff.")) return;
		await fetch(`${apiBase}/${e.id}`, { method: "DELETE" });
	});
}

function renderChatPane() {
	const e = state.detailEntry;
	const list = $("learning-chat-messages");
	list.innerHTML = state.detailMessages.map((m) => `
		<div class="message ${m.role}"><div class="content">${renderMd(m.content)}</div></div>
	`).join("");
	if (state.detailMessages.length === 0 && e.summaryJson.learning_hooks.length > 0) {
		list.innerHTML = `<div class="learning-empty">Ask about what changed and why.</div>
			<div>${e.summaryJson.learning_hooks.map((h) => `<span class="learning-hook-chip" data-text="${escape(h)}">${escape(h)}</span>`).join("")}</div>`;
		list.querySelectorAll(".learning-hook-chip").forEach((c) => {
			c.addEventListener("click", () => { $("learning-chat-input").value = c.dataset.text; $("learning-chat-input").focus(); });
		});
	}
	list.scrollTop = list.scrollHeight;
}

function attachDetailHandlers() {
	document.querySelectorAll(".learning-detail-tab").forEach((t) => {
		t.addEventListener("click", () => { state.detailTab = t.dataset.tab; renderDetail(); });
	});
	$("learning-chat-send").addEventListener("click", sendChat);
	$("learning-chat-input").addEventListener("keydown", (ev) => {
		if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); sendChat(); }
	});
}

function sendChat() {
	if (!state.detailEntry || state.streaming) return;
	const input = $("learning-chat-input");
	const content = input.value.trim();
	if (!content) return;
	input.value = "";
	state.streaming = true;
	state.detailMessages.push({ role: "user", content });
	state.detailMessages.push({ role: "assistant", content: "" });
	renderChatPane();
	ws.send(JSON.stringify({ type: "learning_message", entryId: state.detailEntry.id, content }));
	$("learning-chat-send").disabled = true;
}

function appendDelta(delta) {
	const last = state.detailMessages[state.detailMessages.length - 1];
	if (!last || last.role !== "assistant") return;
	last.content += delta;
	renderChatPane();
}

function finalizeStream() {
	state.streaming = false;
	$("learning-chat-send").disabled = false;
}

function showStreamError(message) {
	state.streaming = false;
	$("learning-chat-send").disabled = false;
	alert(`Learning chat error: ${message}`);
}

function clearDetail() {
	state.detailEntry = null;
	state.detailMessages = [];
	renderDetail();
}

function openDiffModal(text) {
	const overlay = document.createElement("div");
	overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.8);z-index:9999;display:flex;align-items:center;justify-content:center;";
	overlay.innerHTML = `<div style="background:#1a1a1a;max-width:80%;max-height:80%;overflow:auto;padding:20px;border-radius:6px;">
		<pre style="color:#ddd;white-space:pre-wrap;font-family:monospace;font-size:12px;">${escape(text)}</pre>
		<button style="margin-top:10px;">Close</button></div>`;
	overlay.querySelector("button").addEventListener("click", () => overlay.remove());
	overlay.addEventListener("click", (ev) => { if (ev.target === overlay) overlay.remove(); });
	document.body.appendChild(overlay);
}

function escape(s) {
	return String(s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function renderMd(text) {
	// Reuse existing markdown helper if app.js exports one; fall back to escaped text.
	if (window.renderMarkdown) return window.renderMarkdown(text);
	return escape(text).replace(/\n/g, "<br>");
}
function relTime(ms) {
	const d = Date.now() - ms;
	if (d < 60_000) return "just now";
	if (d < 3600_000) return Math.floor(d / 60_000) + "m ago";
	if (d < 86400_000) return Math.floor(d / 3600_000) + "h ago";
	return Math.floor(d / 86400_000) + "d ago";
}
```

- [ ] **Step 2: Wire into `web/app.js`**

At the top of `web/app.js`, add:

```js
import { initLearning, handleLearningMessage } from "./learning.js";
```

In the existing WebSocket message router (find the `onmessage` / switch/if-else block), add a branch:

```js
if (msg.type && msg.type.startsWith("learning_")) {
	handleLearningMessage(msg);
	return;
}
```

After the WebSocket connects (in `onopen` or similar), call once:

```js
initLearning(ws);
```

Ensure app.js uses `<script type="module">` in index.html if it doesn't already. Check `web/index.html` — if the existing script tag is `<script src="app.js"></script>`, change to `<script type="module" src="app.js"></script>`.

Expose `renderMarkdown` globally if it isn't already (so `learning.js`'s fallback can find it): `window.renderMarkdown = renderMarkdown;` at the end of app.js.

- [ ] **Step 3: Manual smoke test**

```bash
npm run build && npm start
```

Open http://127.0.0.1:3120 in the browser:
- Right panel shows Active / Archived tabs and empty-state.
- Via the main chat, run: create an agent in a git repo cwd, have it make a trivial edit, kill the agent.
- A new learning entry should appear in the right panel. Click it.
- Summary tab shows title, sections, hooks.
- Click a hook chip → Chat tab opens with input pre-filled.
- Send a message → response streams into chat pane.
- Click "Flush to memory" → button changes to "✓ Flushed".

- [ ] **Step 4: Commit**

```bash
npm run format
git add web/learning.js web/app.js web/index.html
git commit -m "feat(learning): add right-panel UI module"
```

---

## Task 15: Verification, smoke tests, docs update

**Files:**
- Modify: `CLAUDE.md` (project root) — document the learning module briefly
- No code changes

- [ ] **Step 1: Run full test suite**

```bash
npm test
```

Expected: all existing + new tests pass. If a pre-existing test fails, investigate whether your changes caused it or if it's pre-existing flakiness (git log the specific test).

- [ ] **Step 2: Run biome check**

```bash
npm run check
```

Expected: clean.

- [ ] **Step 3: Build**

```bash
npm run build
```

Expected: clean.

- [ ] **Step 4: Manual end-to-end smoke scenarios**

In a throwaway git repo (e.g. `mktemp -d && cd && git init -b main && git config user.email a@b.c && git config user.name t && echo hi > a.txt && git add . && git commit -m init`):

1. Start cliclaw: `npm start -- --cwd <that-dir>`.
2. Via the chat UI, ask MainAgent to create an agent that edits `a.txt`, then kill the agent.
3. Verify: a learning entry appears; summary shows the edit; chat responds coherently.
4. Create a second agent that edits `b.txt`, kill it.
5. Check both checkboxes in the learning list → merge. Verify the merged entry has combined stats and that the originals are now in Archived.
6. Flush the merged entry to memory. Inspect `~/.cliclaw/memory/learning/<id>.md`.
7. Run `/tidy` or use MainAgent's `memory_search` tool to verify the learning file is indexed and searchable.

Document any issues found; fix them inline before proceeding.

- [ ] **Step 5: Update `CLAUDE.md`**

Find the "## Architecture" section in `CLAUDE.md`. After the "### Memory Module" section (or similar natural insertion point), add:

```markdown
### Learning Sessions (`src/core/learning-*.ts`)
Per-sub-agent change tracking and isolated learning-chat. Lifecycle:

- `create_agent` → `ChangeTracker.registerAgent` captures git baseline (commit SHA or `git stash create` tree for dirty trees).
- `kill_agent` → `ChangeTracker.computeDiff` → `LearningSummarizer.generate` (1 retry, skeleton fallback) → `LearningStore.create` with raw diff blob stored at `~/.cliclaw/learning/diffs/<id>.diff`.
- Learning chat (`LearningChat`) is context-isolated from MainAgent — no memory flush or compaction.
- REST: `/api/learning/*` (list/detail/diff/messages/patch/merge/regenerate/flush-to-memory/delete).
- WebSocket: `learning_message` / `learning_stop` client → server; `learning_entry_created` / `_updated` / `_deleted` / `learning_delta` / `_done` / `_error` server → client.
- UI: right-side panel split into entries list (top 1/3) and detail pane (Summary / Chat tabs, bottom 2/3).
- Flush to memory: opt-in, writes to `~/.cliclaw/memory/learning/<id>.md`, indexed by existing memory pipeline.
```

- [ ] **Step 6: Final commit**

```bash
npm run format
git add CLAUDE.md
git commit -m "docs(learning): document learning sessions in CLAUDE.md"
```

---

## Self-review (already done)

- **Spec coverage:**
  - Architecture § → Tasks 1–9, 12
  - Data model § → Tasks 1–2
  - API surface § → Tasks 10–11
  - Flows § (agent-kill / chat / merge / flush) → Tasks 5, 7, 8
  - UI layout § → Tasks 13–14
  - Testing § → Tests in each task + Task 15 smoke scenarios
  - Risk & mitigation § → LLM failure isolation in Task 7; diff truncation in Task 5; raw diff on disk in Task 2; two-step delete confirm in Task 14; `learning_` prefix in Task 10/11; in-memory baselines in Task 3
- **Placeholder scan:** No "TBD" / "fill in later" / "similar to Task N" without repeating content. All test code and implementation code shown.
- **Type consistency:** `LearningEntry` / `LearningEntrySummary` / `SummaryJson` / `DiffResult` / `DiffStats` / `CreateLearningEntryInput` defined once in Task 1 and referenced by same names throughout. Method names match spec (`registerAgent`, `computeDiff`, `releaseAgent`, `ingestAgentKill`, `merge`, `regenerate`, `flushToMemory`, `handleMessage`, `stop`). REST paths match spec exactly.
