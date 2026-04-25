import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { ContextManager } from "../../src/core/context-manager.js";
import { ConversationStore } from "../../src/persistence/conversation-store.js";

function createMockPromptLoader(template: string) {
	return {
		getRaw: vi.fn().mockReturnValue(template),
		resolve: vi.fn().mockReturnValue("You are a history compressor."),
		load: vi.fn(),
		setGlobalContext: vi.fn(),
	} as any;
}

function createMockLLMClient(compressedResult = "## Compressed History\n- Task done") {
	return {
		complete: vi.fn().mockResolvedValue({
			content: compressedResult,
			contentBlocks: [],
		}),
		stream: vi.fn(),
	} as any;
}

describe("ContextManager Persistence", () => {
	let tmpDir: string;
	let db: Database.Database;
	let store: ConversationStore;
	let mockLLM: ReturnType<typeof createMockLLMClient>;
	let mockPromptLoader: ReturnType<typeof createMockPromptLoader>;

	const template = "Goal: {{goal}}\nHistory: {{compressed_history}}\nCaps: {{agent_capabilities}}";

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "cliclaw-ctx-test-"));
		db = new Database(join(tmpDir, "test.sqlite"));
		db.pragma("journal_mode = WAL");
		store = new ConversationStore(db);
		mockLLM = createMockLLMClient();
		mockPromptLoader = createMockPromptLoader(template);
	});

	afterEach(async () => {
		db.close();
		await rm(tmpDir, { recursive: true, force: true });
	});

	describe("addMessage persistence", () => {
		it("should persist messages to SQLite when ConversationStore is configured", () => {
			const cm = new ContextManager({
				llmClient: mockLLM,
				promptLoader: mockPromptLoader,
				conversationStore: store,
			});

			cm.addMessage({ role: "user", content: "hello" });
			cm.addMessage({ role: "assistant", content: "hi there" });

			const loaded = store.loadMessages();
			expect(loaded).toHaveLength(2);
			expect(loaded[0].content).toBe("hello");
			expect(loaded[1].content).toBe("hi there");
		});

		it("should not persist when ConversationStore is not configured", () => {
			const cm = new ContextManager({
				llmClient: mockLLM,
				promptLoader: mockPromptLoader,
			});

			cm.addMessage({ role: "user", content: "hello" });

			const loaded = store.loadMessages();
			expect(loaded).toHaveLength(0);
		});
	});

	describe("restore", () => {
		it("should restore conversation from SQLite", () => {
			// Seed data
			store.saveMessage({ role: "user", content: "msg1" });
			store.saveMessage({ role: "assistant", content: "msg2" });
			store.saveMessage({ role: "user", content: "msg3" });

			const cm = new ContextManager({
				llmClient: mockLLM,
				promptLoader: mockPromptLoader,
			});
			const count = cm.restore(store);

			expect(count).toBe(3);
			// restore injects a SESSION_RESTORED notice as the 4th message
			expect(cm.getConversationLength()).toBe(4);
			expect(cm.getMessages()[0].content).toBe("msg1");
			expect(cm.getMessages()[2].content).toBe("msg3");
			expect(cm.getMessages()[3].content).toContain("[SESSION_RESTORED]");
		});

		it("should restore compressed_history module", () => {
			store.saveContextState("compressed_history", "Previous tasks were completed");

			const cm = new ContextManager({
				llmClient: mockLLM,
				promptLoader: mockPromptLoader,
			});
			cm.restore(store);

			const prompt = cm.getSystemPrompt();
			expect(prompt).toContain("Previous tasks were completed");
		});

		it("should restore goal module", () => {
			store.saveContextState("goal", "Build auth system");

			const cm = new ContextManager({
				llmClient: mockLLM,
				promptLoader: mockPromptLoader,
			});
			cm.restore(store);

			const prompt = cm.getSystemPrompt();
			expect(prompt).toContain("Build auth system");
		});

		it("should restore compaction_count and token_count", () => {
			store.saveContextState("compaction_count", "3");
			store.saveContextState("token_count", "5000");

			const cm = new ContextManager({
				llmClient: mockLLM,
				promptLoader: mockPromptLoader,
			});
			cm.restore(store);

			// Token estimate should include the restored token count
			expect(cm.getCurrentTokenEstimate()).toBeGreaterThan(0);
		});

		it("should handle empty SQLite (fresh start)", () => {
			const cm = new ContextManager({
				llmClient: mockLLM,
				promptLoader: mockPromptLoader,
			});
			const count = cm.restore(store);

			expect(count).toBe(0);
			// No SESSION_RESTORED notice when there are no messages
			expect(cm.getConversationLength()).toBe(0);
		});

		it("should not stack restore notices when last message already is one", () => {
			// First restart: seed real conversation, then restore
			store.saveMessage({ role: "user", content: "msg1" });
			store.saveMessage({ role: "assistant", content: "msg2" });

			const cm1 = new ContextManager({ llmClient: mockLLM, promptLoader: mockPromptLoader });
			cm1.restore(store);
			expect(cm1.getConversationLength()).toBe(3);
			expect(cm1.getMessages()[2].content).toContain("[SESSION_RESTORED]");

			// Second restart with no new activity: previous restore notice is now
			// the tail of the persisted conversation. Restoring again must not
			// append another notice.
			const cm2 = new ContextManager({ llmClient: mockLLM, promptLoader: mockPromptLoader });
			cm2.restore(store);
			expect(cm2.getConversationLength()).toBe(3);
			expect(cm2.getMessages()[2].content).toContain("[SESSION_RESTORED]");

			// Third restart — still no growth.
			const cm3 = new ContextManager({ llmClient: mockLLM, promptLoader: mockPromptLoader });
			cm3.restore(store);
			expect(cm3.getConversationLength()).toBe(3);
		});
	});

	describe("clear", () => {
		it("should clear conversation and dynamic modules", async () => {
			const cm = new ContextManager({
				llmClient: mockLLM,
				promptLoader: mockPromptLoader,
				conversationStore: store,
			});

			cm.updateModule("goal", "Build API");
			cm.updateModule("agent_capabilities", "Code editing");
			cm.addMessage({ role: "user", content: "hello" });

			await cm.clear();

			expect(cm.getConversationLength()).toBe(0);
			const prompt = cm.getSystemPrompt();
			// goal should be cleared
			expect(prompt).toContain("Goal: ");
			expect(prompt).not.toContain("Build API");
			// agent_capabilities should be preserved
			expect(prompt).toContain("Code editing");
		});

		it("should clear SQLite data", async () => {
			const cm = new ContextManager({
				llmClient: mockLLM,
				promptLoader: mockPromptLoader,
				conversationStore: store,
			});

			cm.addMessage({ role: "user", content: "hello" });
			store.saveContextState("compressed_history", "data");

			await cm.clear();

			expect(store.loadMessages()).toEqual([]);
			expect(store.loadContextState("compressed_history")).toBeUndefined();
		});

		it("should reset token estimate to near zero", async () => {
			const cm = new ContextManager({
				llmClient: mockLLM,
				promptLoader: mockPromptLoader,
				conversationStore: store,
			});

			cm.addMessage({ role: "user", content: "a".repeat(10000) });
			const beforeClear = cm.getCurrentTokenEstimate();

			await cm.clear();

			const afterClear = cm.getCurrentTokenEstimate();
			expect(afterClear).toBeLessThan(beforeClear);
			expect(afterClear).toBe(0);
		});
	});

	describe("compress persistence", () => {
		it("should persist compressed_history and compaction_count after compress", async () => {
			const cm = new ContextManager({
				llmClient: mockLLM,
				promptLoader: mockPromptLoader,
				conversationStore: store,
				contextWindowLimit: 100, // tiny limit to make compression trigger easily
			});

			cm.addMessage({ role: "user", content: "hello" });
			cm.addMessage({ role: "assistant", content: "world" });

			await cm.compress();

			expect(store.loadContextState("compressed_history")).toBe("## Compressed History\n- Task done");
			expect(store.loadContextState("compaction_count")).toBe("1");
		});
	});
});
