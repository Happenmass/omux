import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LearningStore } from "../../src/core/learning-store.js";
import { ConversationStore } from "../../src/persistence/conversation-store.js";
import { CommandRegistry } from "../../src/server/command-registry.js";
import { startServer } from "../../src/server/index.js";

function getCookieHeader(response: Response): string {
	const cookie = response.headers.get("set-cookie");
	if (!cookie) {
		throw new Error("Expected Set-Cookie header");
	}
	return cookie.split(";")[0];
}

describe("learning REST API", () => {
	let tmpDir: string;
	let db: Database.Database;
	let store: LearningStore;
	let server: Awaited<ReturnType<typeof startServer>>;
	let pipeline: any;
	let broadcaster: any;
	let baseUrl: string;
	let cookie: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "omux-api-"));
		db = new Database(join(tmpDir, "x.sqlite"));
		db.pragma("journal_mode = WAL");
		new ConversationStore(db);
		store = new LearningStore(db, join(tmpDir, "diffs"));

		pipeline = {
			merge: vi.fn(async (_ids: string[], title?: string) => ({
				id: "lrn_merged",
				title: title ?? "M",
				status: "active",
				sourceType: "merged",
				sourceAgents: [],
				agentPrompts: [],
				summaryJson: {
					title: "M",
					what_changed: "",
					why: "",
					key_files: [],
					design_points: [],
					learning_hooks: [],
				},
				diffStats: { filesChanged: 0, additions: 0, deletions: 0, filesList: [] },
				diffBlobPath: "/tmp/x.diff",
				memoryFlushedAt: null,
				createdAt: 1,
				updatedAt: 1,
			})),
			regenerate: vi.fn(),
			flushToMemory: vi.fn(),
			ingestAgentKill: vi.fn(),
		};

		broadcaster = {
			broadcast: vi.fn(),
			addClient: vi.fn(),
			removeClient: vi.fn(),
			getClientCount: () => 0,
		} as any;

		const mainAgent = {
			state: "idle" as const,
			handleMessage: async () => undefined,
			waitForIdle: async () => undefined,
			setOnAgentChange: () => undefined,
			getActiveAgents: () => [],
		} as any;

		server = await startServer({
			host: "127.0.0.1",
			port: 0,
			mainAgent,
			contextManager: {} as any,
			conversationStore: {
				loadMessages: () => [],
				loadMessagesWithCreatedAt: () => [],
				getMessageCount: () => 0,
			} as any,
			broadcaster,
			bridge: { capturePane: async () => ({ content: "", lines: 0 }) } as any,
			commandRegistry: new CommandRegistry(),
			llmClient: {} as any,
			promptLoader: {} as any,
			memoryStore: {} as any,
			syncMemory: async () => {},
			learningStore: store,
			learningPipeline: pipeline,
		});

		baseUrl = `http://127.0.0.1:${server.port}`;

		// Obtain auth cookie from landing page (required for all /api/* requests)
		const landing = await fetch(`${baseUrl}/`);
		cookie = getCookieHeader(landing);
	});

	afterEach(async () => {
		await server.close();
		db.close();
		await rm(tmpDir, { recursive: true, force: true });
	});

	function makeEntry(title = "T") {
		return store.create({
			title,
			sourceType: "agent",
			sourceAgents: [],
			agentPrompts: [],
			summaryJson: { title, what_changed: "wc", why: "", key_files: [], design_points: [], learning_hooks: [] },
			diffStats: {
				filesChanged: 1,
				additions: 1,
				deletions: 0,
				filesList: [{ path: "a", status: "modified" }],
			},
			rawDiff: "diff",
		});
	}

	it("GET /api/learning returns active list without summary", async () => {
		await makeEntry();
		const res = await fetch(`${baseUrl}/api/learning`, {
			headers: { Cookie: cookie },
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toHaveLength(1);
		expect(body[0].title).toBe("T");
		expect(body[0].summaryJson).toBeUndefined();
	});

	it("GET /api/learning/:id returns full entry with summary", async () => {
		const e = await makeEntry();
		const res = await fetch(`${baseUrl}/api/learning/${e.id}`, {
			headers: { Cookie: cookie },
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.summaryJson.what_changed).toBe("wc");
	});

	it("GET /api/learning/:id/diff returns raw diff text", async () => {
		const e = await makeEntry();
		const res = await fetch(`${baseUrl}/api/learning/${e.id}/diff`, {
			headers: { Cookie: cookie },
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/plain");
		expect(await res.text()).toBe("diff");
	});

	it("GET /api/learning/:id/messages returns empty list by default", async () => {
		const e = await makeEntry();
		const res = await fetch(`${baseUrl}/api/learning/${e.id}/messages`, {
			headers: { Cookie: cookie },
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual([]);
	});

	it("PATCH title and status", async () => {
		const e = await makeEntry();
		const res = await fetch(`${baseUrl}/api/learning/${e.id}`, {
			method: "PATCH",
			headers: { Cookie: cookie, "content-type": "application/json" },
			body: JSON.stringify({ title: "New", status: "archived" }),
		});
		expect(res.status).toBe(200);
		const reloaded = await store.loadEntry(e.id);
		expect(reloaded!.title).toBe("New");
		expect(reloaded!.status).toBe("archived");
	});

	it("POST merge validates count and delegates to pipeline", async () => {
		const tooFew = await fetch(`${baseUrl}/api/learning/merge`, {
			method: "POST",
			headers: { Cookie: cookie, "content-type": "application/json" },
			body: JSON.stringify({ ids: ["lrn_a"] }),
		});
		expect(tooFew.status).toBe(400);

		const ok = await fetch(`${baseUrl}/api/learning/merge`, {
			method: "POST",
			headers: { Cookie: cookie, "content-type": "application/json" },
			body: JSON.stringify({ ids: ["lrn_a", "lrn_b"] }),
		});
		expect(ok.status).toBe(200);
		expect(pipeline.merge).toHaveBeenCalledWith(["lrn_a", "lrn_b"], undefined);
	});

	it("DELETE removes entry and broadcasts deletion", async () => {
		const e = await makeEntry();
		const res = await fetch(`${baseUrl}/api/learning/${e.id}`, {
			method: "DELETE",
			headers: { Cookie: cookie },
		});
		expect(res.status).toBe(204);
		expect(await store.loadEntry(e.id)).toBeNull();

		// Verify broadcast was called with learning_entry_deleted
		const calls = broadcaster.broadcast.mock.calls;
		const deleteCall = calls.find((c: any) => c[0]?.type === "learning_entry_deleted");
		expect(deleteCall).toBeDefined();
		expect(deleteCall[0].id).toBe(e.id);
	});

	it("GET /api/learning/:id returns 404 when missing", async () => {
		const res = await fetch(`${baseUrl}/api/learning/lrn_missing`, {
			headers: { Cookie: cookie },
		});
		expect(res.status).toBe(404);
	});
});
