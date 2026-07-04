import { request as httpRequest } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { CommandRegistry } from "../../src/server/command-registry.js";
import { type ServerInstance, startServer } from "../../src/server/index.js";
import { UiEventStore } from "../../src/server/ui-events.js";

/** Issue a raw HTTP GET with an explicit Host header (fetch/undici forbids overriding Host). */
function rawRequestStatus(port: number, path: string, host: string): Promise<number> {
	return new Promise((resolve, reject) => {
		const req = httpRequest({ host: "127.0.0.1", port, path, method: "GET", headers: { Host: host } }, (res) => {
			res.resume();
			res.on("end", () => resolve(res.statusCode ?? 0));
		});
		req.on("error", reject);
		req.end();
	});
}

function createMainAgentMock() {
	return {
		state: "idle" as const,
		handleMessage: async () => undefined,
		requestStop: () => undefined,
		waitForIdle: async () => undefined,
		runMaintenance: async (fn: () => Promise<unknown>) => fn(),
		setOnAgentChange: () => undefined,
		getActiveAgents: () => [],
		getPendingUserMessageCount: () => 0,
		getContextUsage: () => ({ tokens: 0, limit: 200000 }),
	} as any;
}

function createContextManagerMock() {
	return {
		clear: async () => undefined,
	} as any;
}

function createConversationStoreMock() {
	return {
		loadMessages: () => [],
		loadMessagesWithCreatedAt: () => [],
		getMessageCount: () => 0,
	} as any;
}

function createBroadcasterMock() {
	return {
		addClient: () => undefined,
		removeClient: () => undefined,
		broadcast: () => undefined,
		getClientCount: () => 0,
	} as any;
}

function createBridgeMock() {
	return {
		capturePane: async () => ({ content: "", lines: 0 }),
	} as any;
}

function getCookieHeader(response: Response): string {
	const cookie = response.headers.get("set-cookie");
	if (!cookie) {
		throw new Error("Expected Set-Cookie header");
	}
	return cookie.split(";")[0];
}

function waitForWsClose(ws: WebSocket): Promise<number> {
	return new Promise((resolve, reject) => {
		ws.once("close", (code) => resolve(code));
		ws.once("error", reject);
	});
}

function waitForWsMessage(ws: WebSocket): Promise<string> {
	return new Promise((resolve, reject) => {
		ws.once("message", (data) => resolve(data.toString()));
		ws.once("error", reject);
	});
}

describe("startServer", () => {
	let server: ServerInstance | null = null;

	afterEach(async () => {
		if (server) {
			await server.close();
			server = null;
		}
	});

	it("serves loopback callers and sets the auth cookie on the landing page", async () => {
		// Pairing model (SRV-1): loopback is trusted implicitly, so a cookieless request from
		// 127.0.0.1 is served. Landing GETs still set the cookie so subsequent requests carry it.
		server = await startServer({
			host: "127.0.0.1",
			port: 0,
			mainAgent: createMainAgentMock(),
			contextManager: createContextManagerMock(),
			conversationStore: createConversationStoreMock(),
			broadcaster: createBroadcasterMock(),
			bridge: createBridgeMock(),
			commandRegistry: new CommandRegistry(),
		});

		// Loopback API request is served without a cookie (trusted single-machine UX).
		const loopbackApi = await fetch(`http://127.0.0.1:${server.port}/api/status`);
		expect(loopbackApi.status).toBe(200);

		const landing = await fetch(`http://127.0.0.1:${server.port}/`);
		expect(landing.status).toBe(200);
		const cookie = getCookieHeader(landing);

		const authorized = await fetch(`http://127.0.0.1:${server.port}/api/status`, {
			headers: { Cookie: cookie },
		});
		expect(authorized.status).toBe(200);
		expect(await authorized.json()).toEqual({
			state: "idle",
			messageCount: 0,
			clients: 0,
			learningEnabled: false,
			locale: "en-US",
			contextUsage: { tokens: 0, limit: 200000 },
		});
	});

	it("rejects requests with a disallowed Host header (DNS rebinding, SRV-2)", async () => {
		server = await startServer({
			host: "127.0.0.1",
			port: 0,
			mainAgent: createMainAgentMock(),
			contextManager: createContextManagerMock(),
			conversationStore: createConversationStoreMock(),
			broadcaster: createBroadcasterMock(),
			bridge: createBridgeMock(),
			commandRegistry: new CommandRegistry(),
		});

		// undici's fetch() forbids overriding the Host header, so use a raw http request.
		const status = await rawRequestStatus(server.port, "/api/status", "evil.example.com");
		expect(status).toBe(403);

		// A Host matching the actual bind host is accepted.
		const okStatus = await rawRequestStatus(server.port, "/api/status", `127.0.0.1:${server.port}`);
		expect(okStatus).toBe(200);
	});

	it("should require auth cookie for websocket connections", async () => {
		server = await startServer({
			host: "127.0.0.1",
			port: 0,
			mainAgent: createMainAgentMock(),
			contextManager: createContextManagerMock(),
			conversationStore: createConversationStoreMock(),
			broadcaster: createBroadcasterMock(),
			bridge: createBridgeMock(),
			commandRegistry: new CommandRegistry(),
		});

		const unauthorizedWs = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
		await expect(waitForWsClose(unauthorizedWs)).resolves.toBe(1008);

		const landing = await fetch(`http://127.0.0.1:${server.port}/`);
		const cookie = getCookieHeader(landing);
		const authorizedWs = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, {
			headers: { Cookie: cookie },
		});

		await expect(waitForWsMessage(authorizedWs)).resolves.toBe(
			JSON.stringify({
				type: "state",
				state: "idle",
				queueSize: 0,
				contextUsage: { tokens: 0, limit: 200000 },
			}),
		);
		authorizedWs.close();
	});

	it("should hide internal orchestration messages from /api/history", async () => {
		const conversationStore = createConversationStoreMock();
		conversationStore.loadMessagesWithCreatedAt = () => [
			{ role: "user", content: "fix the bug", createdAt: 1 },
			{ role: "assistant", content: "on it", createdAt: 2 },
			{
				role: "user",
				content: "[AGENT_EVENT agent_id=a task_id=t status=completed duration=5s]\nfull pane output here",
				createdAt: 3,
			},
			{ role: "user", content: "[CONTEXT_RECOVERY] history compressed", createdAt: 4 },
			{ role: "user", content: "[HUMAN] a queued note", createdAt: 5 },
		];

		server = await startServer({
			host: "127.0.0.1",
			port: 0,
			mainAgent: createMainAgentMock(),
			contextManager: createContextManagerMock(),
			conversationStore,
			broadcaster: createBroadcasterMock(),
			bridge: createBridgeMock(),
			commandRegistry: new CommandRegistry(),
		});

		const landing = await fetch(`http://127.0.0.1:${server.port}/`);
		const cookie = getCookieHeader(landing);
		const response = await fetch(`http://127.0.0.1:${server.port}/api/history`, {
			headers: { Cookie: cookie },
		});

		expect(response.status).toBe(200);
		const history = (await response.json()) as Array<{ role: string; content: string }>;
		// Only the real user/assistant turns survive; synthetic internal messages are stripped.
		expect(history.map((m) => m.content)).toEqual(["fix the bug", "on it"]);
	});

	it("should return agent terminals from the API", async () => {
		const mainAgent = createMainAgentMock();
		mainAgent.getActiveAgents = () => [
			{ agentName: "omux-auth", agentId: "omux-auth", paneTarget: "auth:0.0", status: "active" },
		];

		const bridge = createBridgeMock();
		bridge.capturePane = async () => ({ content: "$ claude\n> Working...\n", lines: 2 });

		server = await startServer({
			host: "127.0.0.1",
			port: 0,
			mainAgent,
			contextManager: createContextManagerMock(),
			conversationStore: createConversationStoreMock(),
			broadcaster: createBroadcasterMock(),
			bridge,
			commandRegistry: new CommandRegistry(),
		});

		const landing = await fetch(`http://127.0.0.1:${server.port}/`);
		const cookie = getCookieHeader(landing);
		const response = await fetch(`http://127.0.0.1:${server.port}/api/agents/terminals`, {
			headers: { Cookie: cookie },
		});

		expect(response.status).toBe(200);
		const sessions = await response.json();
		expect(sessions).toHaveLength(1);
		expect(sessions[0]).toEqual({
			agentName: "omux-auth",
			agentId: "omux-auth",
			status: "active",
			paneContent: "$ claude\n> Working...\n",
		});
	});

	it("should return empty array when no active agents", async () => {
		server = await startServer({
			host: "127.0.0.1",
			port: 0,
			mainAgent: createMainAgentMock(),
			contextManager: createContextManagerMock(),
			conversationStore: createConversationStoreMock(),
			broadcaster: createBroadcasterMock(),
			bridge: createBridgeMock(),
			commandRegistry: new CommandRegistry(),
		});

		const landing = await fetch(`http://127.0.0.1:${server.port}/`);
		const cookie = getCookieHeader(landing);
		const response = await fetch(`http://127.0.0.1:${server.port}/api/agents/terminals`, {
			headers: { Cookie: cookie },
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual([]);
	});

	it("should handle capturePane failure gracefully in agent terminals", async () => {
		const mainAgent = createMainAgentMock();
		mainAgent.getActiveAgents = () => [
			{ agentName: "omux-broken", agentId: "omux-broken", paneTarget: "broken:0.0", status: "active" },
			{ agentName: "omux-ok", agentId: "omux-ok", paneTarget: "ok:0.0", status: "idle" },
		];

		const bridge = createBridgeMock();
		bridge.capturePane = async (target: string) => {
			if (target === "broken:0.0") throw new Error("tmux pane destroyed");
			return { content: "ok content", lines: 1 };
		};

		server = await startServer({
			host: "127.0.0.1",
			port: 0,
			mainAgent,
			contextManager: createContextManagerMock(),
			conversationStore: createConversationStoreMock(),
			broadcaster: createBroadcasterMock(),
			bridge,
			commandRegistry: new CommandRegistry(),
		});

		const landing = await fetch(`http://127.0.0.1:${server.port}/`);
		const cookie = getCookieHeader(landing);
		const response = await fetch(`http://127.0.0.1:${server.port}/api/agents/terminals`, {
			headers: { Cookie: cookie },
		});

		expect(response.status).toBe(200);
		const sessions = await response.json();
		expect(sessions).toHaveLength(2);
		// Failed agent should have empty paneContent
		expect(sessions[0].paneContent).toBe("");
		expect(sessions[0].agentName).toBe("omux-broken");
		// Working agent should have content
		expect(sessions[1].paneContent).toBe("ok content");
	});

	it("should broadcast agent_terminals with 'agents' key (not 'sessions')", async () => {
		const mainAgent = createMainAgentMock();
		let capturedOnAgentChange: (() => void) | undefined;
		mainAgent.setOnAgentChange = (cb: () => void) => {
			capturedOnAgentChange = cb;
		};
		mainAgent.getActiveAgents = () => [
			{
				agentName: "omux-test",
				agentId: "omux-test",
				paneTarget: "test:0.0",
				status: "active",
				takenOver: false,
			},
		];

		const broadcasts: any[] = [];
		const broadcaster = createBroadcasterMock();
		broadcaster.getClientCount = () => 1;
		broadcaster.broadcast = (msg: any) => {
			broadcasts.push(msg);
		};

		const bridge = createBridgeMock();

		server = await startServer({
			host: "127.0.0.1",
			port: 0,
			mainAgent,
			contextManager: createContextManagerMock(),
			conversationStore: createConversationStoreMock(),
			broadcaster,
			bridge,
			commandRegistry: new CommandRegistry(),
		});

		// Trigger agent change callback (simulates agent creation/kill)
		expect(capturedOnAgentChange).toBeDefined();
		capturedOnAgentChange!();

		// Wait for async collectAgentTerminals to complete
		await new Promise((r) => setTimeout(r, 100));

		const terminalMsg = broadcasts.find((m) => m.type === "agent_terminals");
		expect(terminalMsg).toBeDefined();
		// Must use 'agents' key, NOT 'sessions'
		expect(terminalMsg.agents).toBeDefined();
		expect(terminalMsg.sessions).toBeUndefined();
		expect(terminalMsg.agents).toHaveLength(1);
		expect(terminalMsg.agents[0].agentId).toBe("omux-test");
		expect(terminalMsg.agents[0].agentName).toBe("omux-test");
	});

	it("should broadcast empty agents array after all agents killed", async () => {
		const mainAgent = createMainAgentMock();
		let capturedOnAgentChange: (() => void) | undefined;
		mainAgent.setOnAgentChange = (cb: () => void) => {
			capturedOnAgentChange = cb;
		};
		// No active agents (simulates post-kill state)
		mainAgent.getActiveAgents = () => [];

		const broadcasts: any[] = [];
		const broadcaster = createBroadcasterMock();
		broadcaster.getClientCount = () => 1;
		broadcaster.broadcast = (msg: any) => {
			broadcasts.push(msg);
		};

		server = await startServer({
			host: "127.0.0.1",
			port: 0,
			mainAgent,
			contextManager: createContextManagerMock(),
			conversationStore: createConversationStoreMock(),
			broadcaster,
			bridge: createBridgeMock(),
			commandRegistry: new CommandRegistry(),
		});

		capturedOnAgentChange!();
		await new Promise((r) => setTimeout(r, 100));

		const terminalMsg = broadcasts.find((m) => m.type === "agent_terminals");
		expect(terminalMsg).toBeDefined();
		expect(terminalMsg.agents).toEqual([]);
	});

	describe("scheduled nightly tidy", () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		const ENABLED_TIDY = { enabled: true, time: "23:30" as const };

		it("does NOT schedule tidy when autoTidy is disabled (default)", async () => {
			vi.setSystemTime(new Date("2026-04-03T23:00:00"));

			const broadcasts: any[] = [];
			const broadcaster = createBroadcasterMock();
			broadcaster.broadcast = (msg: any) => {
				broadcasts.push(msg);
			};

			server = await startServer({
				host: "127.0.0.1",
				port: 0,
				mainAgent: createMainAgentMock(),
				contextManager: createContextManagerMock(),
				conversationStore: createConversationStoreMock(),
				broadcaster,
				bridge: createBridgeMock(),
				commandRegistry: new CommandRegistry(),
				// autoTidy omitted → disabled by default
			});

			// Advance well past 23:30 — nothing should fire.
			await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
			expect(broadcasts.find((m) => m.type === "system" && m.message.includes("unavailable"))).toBeUndefined();
		});

		it("should trigger tidy at the configured time when enabled", async () => {
			// Set current time to 23:00 — tidy should fire in 30 minutes
			vi.setSystemTime(new Date("2026-04-03T23:00:00"));

			const broadcasts: any[] = [];
			const broadcaster = createBroadcasterMock();
			broadcaster.broadcast = (msg: any) => {
				broadcasts.push(msg);
			};

			server = await startServer({
				host: "127.0.0.1",
				port: 0,
				mainAgent: createMainAgentMock(),
				contextManager: createContextManagerMock(),
				conversationStore: createConversationStoreMock(),
				broadcaster,
				bridge: createBridgeMock(),
				commandRegistry: new CommandRegistry(),
				autoTidy: ENABLED_TIDY,
				// No llmClient/promptLoader/memoryStore → tidy will broadcast "unavailable"
			});

			// Advance 30 minutes to hit 23:30
			await vi.advanceTimersByTimeAsync(30 * 60 * 1000);

			const tidyMsg = broadcasts.find((m) => m.type === "system" && m.message.includes("unavailable"));
			expect(tidyMsg).toBeDefined();
		});

		it("skips (does not stop) the tidy when MainAgent is executing", async () => {
			vi.setSystemTime(new Date("2026-04-03T23:00:00"));

			const broadcasts: any[] = [];
			const broadcaster = createBroadcasterMock();
			broadcaster.broadcast = (msg: any) => {
				broadcasts.push(msg);
			};

			const mainAgent = createMainAgentMock();
			mainAgent.requestStop = vi.fn();
			mainAgent.state = "executing";

			server = await startServer({
				host: "127.0.0.1",
				port: 0,
				mainAgent,
				contextManager: createContextManagerMock(),
				conversationStore: createConversationStoreMock(),
				broadcaster,
				bridge: createBridgeMock(),
				commandRegistry: new CommandRegistry(),
				autoTidy: ENABLED_TIDY,
			});

			await vi.advanceTimersByTimeAsync(30 * 60 * 1000);

			// It must NOT have run tidy (no broadcast) and must NOT have stopped execution.
			expect(broadcasts.find((m) => m.type === "system" && m.message.includes("unavailable"))).toBeUndefined();
			expect(mainAgent.requestStop).not.toHaveBeenCalled();
		});

		it("should not trigger tidy before the configured time", async () => {
			vi.setSystemTime(new Date("2026-04-03T23:00:00"));

			const broadcasts: any[] = [];
			const broadcaster = createBroadcasterMock();
			broadcaster.broadcast = (msg: any) => {
				broadcasts.push(msg);
			};

			server = await startServer({
				host: "127.0.0.1",
				port: 0,
				mainAgent: createMainAgentMock(),
				contextManager: createContextManagerMock(),
				conversationStore: createConversationStoreMock(),
				broadcaster,
				bridge: createBridgeMock(),
				commandRegistry: new CommandRegistry(),
				autoTidy: ENABLED_TIDY,
			});

			// Advance only 20 minutes — should NOT trigger yet
			await vi.advanceTimersByTimeAsync(20 * 60 * 1000);

			const tidyMsg = broadcasts.find((m) => m.type === "system" && m.message.includes("unavailable"));
			expect(tidyMsg).toBeUndefined();
		});

		it("should schedule for next day if already past the configured time", async () => {
			// Set current time to 23:45 — should schedule for tomorrow 23:30
			vi.setSystemTime(new Date("2026-04-03T23:45:00"));

			const broadcasts: any[] = [];
			const broadcaster = createBroadcasterMock();
			broadcaster.broadcast = (msg: any) => {
				broadcasts.push(msg);
			};

			server = await startServer({
				host: "127.0.0.1",
				port: 0,
				mainAgent: createMainAgentMock(),
				contextManager: createContextManagerMock(),
				conversationStore: createConversationStoreMock(),
				broadcaster,
				bridge: createBridgeMock(),
				commandRegistry: new CommandRegistry(),
				autoTidy: ENABLED_TIDY,
			});

			// Advance 30 minutes (still today) — should NOT trigger
			await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
			expect(broadcasts.find((m) => m.type === "system" && m.message.includes("unavailable"))).toBeUndefined();

			// Advance to tomorrow 23:30 (23h15m more from 00:15)
			await vi.advanceTimersByTimeAsync(23 * 60 * 60 * 1000 + 15 * 60 * 1000);
			const tidyMsg = broadcasts.find((m) => m.type === "system" && m.message.includes("unavailable"));
			expect(tidyMsg).toBeDefined();
		});

		it("should re-schedule after tidy executes", async () => {
			vi.setSystemTime(new Date("2026-04-03T23:00:00"));

			const broadcasts: any[] = [];
			const broadcaster = createBroadcasterMock();
			broadcaster.broadcast = (msg: any) => {
				broadcasts.push(msg);
			};

			server = await startServer({
				host: "127.0.0.1",
				port: 0,
				mainAgent: createMainAgentMock(),
				contextManager: createContextManagerMock(),
				conversationStore: createConversationStoreMock(),
				broadcaster,
				bridge: createBridgeMock(),
				commandRegistry: new CommandRegistry(),
				autoTidy: ENABLED_TIDY,
			});

			// First trigger at 23:30
			await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
			const firstCount = broadcasts.filter((m) => m.type === "system" && m.message.includes("unavailable")).length;
			expect(firstCount).toBe(1);

			// Advance 24 hours to next 23:30
			await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
			const secondCount = broadcasts.filter((m) => m.type === "system" && m.message.includes("unavailable")).length;
			expect(secondCount).toBe(2);
		});
	});

	it("should return recent ui summary events from the API", async () => {
		const uiEventStore = new UiEventStore();
		uiEventStore.add({
			id: "ui-1",
			type: "agent_update",
			summary: "正在让 agent 修改 X",
			createdAt: Date.now(),
		});

		server = await startServer({
			host: "127.0.0.1",
			port: 0,
			mainAgent: createMainAgentMock(),
			contextManager: createContextManagerMock(),
			conversationStore: createConversationStoreMock(),
			broadcaster: createBroadcasterMock(),
			bridge: createBridgeMock(),
			commandRegistry: new CommandRegistry(),
			uiEventStore,
		});

		const landing = await fetch(`http://127.0.0.1:${server.port}/`);
		const cookie = getCookieHeader(landing);
		const response = await fetch(`http://127.0.0.1:${server.port}/api/ui-events`, {
			headers: { Cookie: cookie },
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual([
			expect.objectContaining({
				id: "ui-1",
				type: "agent_update",
				summary: "正在让 agent 修改 X",
			}),
		]);
	});
});
