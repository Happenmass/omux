import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LLMMessage } from "../../src/llm/types.js";
import { ConversationStore } from "../../src/persistence/conversation-store.js";

describe("ConversationStore", () => {
	let tmpDir: string;
	let db: Database.Database;
	let store: ConversationStore;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "cliclaw-conv-test-"));
		db = new Database(join(tmpDir, "test.sqlite"));
		db.pragma("journal_mode = WAL");
		store = new ConversationStore(db);
	});

	afterEach(async () => {
		db.close();
		await rm(tmpDir, { recursive: true, force: true });
	});

	describe("schema initialization", () => {
		it("should create chat_messages and chat_context_state tables", () => {
			const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{
				name: string;
			}>;
			const names = tables.map((t) => t.name);
			expect(names).toContain("chat_messages");
			expect(names).toContain("chat_context_state");
		});
	});

	describe("saveMessage / loadMessages", () => {
		it("should save and load a simple text message", () => {
			const msg: LLMMessage = { role: "user", content: "hello world" };
			store.saveMessage(msg);

			const loaded = store.loadMessages();
			expect(loaded).toHaveLength(1);
			expect(loaded[0].role).toBe("user");
			expect(loaded[0].content).toBe("hello world");
		});

		it("should save and load assistant message with MessageContent[]", () => {
			const msg: LLMMessage = {
				role: "assistant",
				content: [
					{ type: "text", text: "I'll help you" },
					{ type: "tool_call", id: "tc_1", name: "send_to_agent", arguments: { prompt: "do something" } },
				],
			};
			store.saveMessage(msg);

			const loaded = store.loadMessages();
			expect(loaded).toHaveLength(1);
			expect(loaded[0].role).toBe("assistant");
			expect(Array.isArray(loaded[0].content)).toBe(true);
			const blocks = loaded[0].content as any[];
			expect(blocks[0].type).toBe("text");
			expect(blocks[1].type).toBe("tool_call");
			expect(blocks[1].name).toBe("send_to_agent");
		});

		it("should save and load tool result message with toolCallId", () => {
			const msg: LLMMessage = {
				role: "tool",
				content: "Agent completed the task",
				toolCallId: "tc_1",
			};
			store.saveMessage(msg);

			const loaded = store.loadMessages();
			expect(loaded).toHaveLength(1);
			expect(loaded[0].role).toBe("tool");
			expect(loaded[0].toolCallId).toBe("tc_1");
		});

		it("should load messages in insertion order", () => {
			store.saveMessage({ role: "user", content: "msg1" });
			store.saveMessage({ role: "assistant", content: "msg2" });
			store.saveMessage({ role: "user", content: "msg3" });

			const loaded = store.loadMessages();
			expect(loaded).toHaveLength(3);
			expect(loaded[0].content).toBe("msg1");
			expect(loaded[1].content).toBe("msg2");
			expect(loaded[2].content).toBe("msg3");
		});

		it("should return empty array when no messages", () => {
			const loaded = store.loadMessages();
			expect(loaded).toEqual([]);
		});

		it("should round-trip a text message whose content looks like a JSON array", () => {
			const msg: LLMMessage = { role: "user", content: "[1, 2, 3]" };
			store.saveMessage(msg);

			const loaded = store.loadMessages();
			expect(loaded).toHaveLength(1);
			expect(loaded[0].content).toBe("[1, 2, 3]");
			expect(typeof loaded[0].content).toBe("string");
		});

		it("should fall back to sniffing for legacy rows with NULL content_kind", () => {
			// Simulate a pre-migration row written before content_kind existed.
			db.prepare("INSERT INTO chat_messages (role, content, tool_call_id) VALUES (?, ?, ?)").run(
				"assistant",
				JSON.stringify([{ type: "text", text: "legacy structured content" }]),
				null,
			);
			const loaded = store.loadMessages();
			expect(loaded).toHaveLength(1);
			expect(Array.isArray(loaded[0].content)).toBe(true);
			expect((loaded[0].content as any[])[0].text).toBe("legacy structured content");
		});
	});

	describe("saveContextState / loadContextState", () => {
		it("should save and load a context state value", () => {
			store.saveContextState("compressed_history", "some compressed text");
			expect(store.loadContextState("compressed_history")).toBe("some compressed text");
		});

		it("should upsert on duplicate key", () => {
			store.saveContextState("token_count", "1000");
			store.saveContextState("token_count", "2000");
			expect(store.loadContextState("token_count")).toBe("2000");
		});

		it("should return undefined for missing key", () => {
			expect(store.loadContextState("nonexistent")).toBeUndefined();
		});
	});

	describe("clearAll", () => {
		it("should clear all messages and context state", () => {
			store.saveMessage({ role: "user", content: "hello" });
			store.saveMessage({ role: "assistant", content: "hi" });
			store.saveContextState("compressed_history", "data");
			store.saveContextState("token_count", "500");

			store.clearAll();

			expect(store.loadMessages()).toEqual([]);
			expect(store.loadContextState("compressed_history")).toBeUndefined();
			expect(store.loadContextState("token_count")).toBeUndefined();
		});
	});

	describe("getMessageCount", () => {
		it("should return correct count", () => {
			expect(store.getMessageCount()).toBe(0);
			store.saveMessage({ role: "user", content: "a" });
			store.saveMessage({ role: "user", content: "b" });
			expect(store.getMessageCount()).toBe(2);
		});
	});
});
