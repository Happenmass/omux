import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LearningChat } from "../../src/core/learning-chat.js";
import { LearningStore } from "../../src/core/learning-store.js";
import { ConversationStore } from "../../src/persistence/conversation-store.js";

describe("LearningChat", () => {
	let tmpDir: string;
	let db: Database.Database;
	let store: LearningStore;
	let broadcaster: any;
	let llm: any;
	let promptLoader: any;
	let chat: LearningChat;
	let entryId: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "cliclaw-lc-"));
		db = new Database(join(tmpDir, "x.sqlite"));
		db.pragma("journal_mode = WAL");
		db.pragma("foreign_keys = ON");
		new ConversationStore(db);
		store = new LearningStore(db, join(tmpDir, "diffs"));
		broadcaster = { broadcast: vi.fn() };
		promptLoader = { resolve: vi.fn(() => "SYSTEM") };
		llm = {
			stream: vi.fn((_m, _o) =>
				(async function* () {
					yield { type: "text_delta", delta: "hel" };
					yield { type: "text_delta", delta: "lo" };
					yield {
						type: "done",
						response: {
							content: "hello",
							contentBlocks: [],
							usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
							stopReason: "end_turn",
							model: "x",
						},
					};
				})(),
			),
			complete: vi.fn(),
		};
		chat = new LearningChat({ store, broadcaster, llm, promptLoader });
		const entry = await store.create({
			title: "T",
			sourceType: "agent",
			sourceAgents: [],
			agentPrompts: [],
			summaryJson: {
				title: "T",
				what_changed: "",
				why: "",
				key_files: [],
				design_points: [],
				learning_hooks: [],
			},
			diffStats: { filesChanged: 0, additions: 0, deletions: 0, filesList: [] },
			rawDiff: "",
		});
		entryId = entry.id;
	});

	afterEach(async () => {
		db.close();
		await rm(tmpDir, { recursive: true, force: true });
	});

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
		llm.stream = vi.fn(() =>
			(async function* () {
				yield { type: "text_delta", delta: "partial " };
				await new Promise((r) => setTimeout(r, 200));
				yield { type: "text_delta", delta: "finished" };
				yield {
					type: "done",
					response: {
						content: "partial finished",
						contentBlocks: [],
						usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
						stopReason: "end_turn",
						model: "x",
					},
				};
			})(),
		);
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

	it("errors on missing entry", async () => {
		await expect(chat.handleMessage("lrn_nonexistent", "q")).rejects.toThrow(/not found/);
	});
});
