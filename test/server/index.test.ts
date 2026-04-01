import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { startServer, type ServerInstance } from "../../src/server/index.js";
import { CommandRegistry } from "../../src/server/command-registry.js";
import { ExecutionEventStore } from "../../src/server/execution-events.js";
import { UiEventStore } from "../../src/server/ui-events.js";

function createMainAgentMock() {
	return {
		state: "idle" as const,
		handleMessage: async () => undefined,
		handleResume: async () => undefined,
		waitForIdle: async () => undefined,
		setOnAgentChange: () => undefined,
		getActiveAgents: () => [],
	} as any;
}

function createContextManagerMock() {
	return {
		clear: async () => undefined,
	} as any;
}

function createSignalRouterMock() {
	return {
		stop: () => undefined,
		resume: () => undefined,
		isStopRequested: () => false,
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

	it("should require auth cookie for API endpoints", async () => {
		server = await startServer({
			host: "127.0.0.1",
			port: 0,
			mainAgent: createMainAgentMock(),
			signalRouter: createSignalRouterMock(),
			contextManager: createContextManagerMock(),
			conversationStore: createConversationStoreMock(),
			broadcaster: createBroadcasterMock(),
			bridge: createBridgeMock(),
			commandRegistry: new CommandRegistry(),
			executionEventStore: new ExecutionEventStore(),
		});

		const unauthorized = await fetch(`http://127.0.0.1:${server.port}/api/status`);
		expect(unauthorized.status).toBe(401);

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
		});
	});

	it("should require auth cookie for websocket connections", async () => {
		server = await startServer({
			host: "127.0.0.1",
			port: 0,
			mainAgent: createMainAgentMock(),
			signalRouter: createSignalRouterMock(),
			contextManager: createContextManagerMock(),
			conversationStore: createConversationStoreMock(),
			broadcaster: createBroadcasterMock(),
			bridge: createBridgeMock(),
			commandRegistry: new CommandRegistry(),
			executionEventStore: new ExecutionEventStore(),
		});

		const unauthorizedWs = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
		await expect(waitForWsClose(unauthorizedWs)).resolves.toBe(1008);

		const landing = await fetch(`http://127.0.0.1:${server.port}/`);
		const cookie = getCookieHeader(landing);
		const authorizedWs = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, {
			headers: { Cookie: cookie },
		});

		await expect(waitForWsMessage(authorizedWs)).resolves.toBe(JSON.stringify({ type: "state", state: "idle" }));
		authorizedWs.close();
	});

	it("should return recent execution events from the API", async () => {
		const executionEventStore = new ExecutionEventStore();
		executionEventStore.add({
			id: "evt-1",
			runId: "run-1",
			phase: "planned",
			toolName: "send_to_agent",
			summary: "Prompting agent",
			createdAt: Date.now(),
		});

		server = await startServer({
			host: "127.0.0.1",
			port: 0,
			mainAgent: createMainAgentMock(),
			signalRouter: createSignalRouterMock(),
			contextManager: createContextManagerMock(),
			conversationStore: createConversationStoreMock(),
			broadcaster: createBroadcasterMock(),
			bridge: createBridgeMock(),
			commandRegistry: new CommandRegistry(),
			executionEventStore,
		});

		const landing = await fetch(`http://127.0.0.1:${server.port}/`);
		const cookie = getCookieHeader(landing);
		const response = await fetch(`http://127.0.0.1:${server.port}/api/execution-events`, {
			headers: { Cookie: cookie },
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual([
			expect.objectContaining({
				id: "evt-1",
				runId: "run-1",
				toolName: "send_to_agent",
			}),
		]);
	});

	it("should return agent terminals from the API", async () => {
		const mainAgent = createMainAgentMock();
		mainAgent.getActiveAgents = () => [
			{ agentName: "cliclaw-auth", agentId: "cliclaw-auth", paneTarget: "auth:0.0", status: "active" },
		];

		const bridge = createBridgeMock();
		bridge.capturePane = async () => ({ content: "$ claude\n> Working...\n", lines: 2 });

		server = await startServer({
			host: "127.0.0.1",
			port: 0,
			mainAgent,
			signalRouter: createSignalRouterMock(),
			contextManager: createContextManagerMock(),
			conversationStore: createConversationStoreMock(),
			broadcaster: createBroadcasterMock(),
			bridge,
			commandRegistry: new CommandRegistry(),
			executionEventStore: new ExecutionEventStore(),
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
			agentName: "cliclaw-auth",
			agentId: "cliclaw-auth",
			status: "active",
			paneContent: "$ claude\n> Working...\n",
		});
	});

	it("should return empty array when no active agents", async () => {
		server = await startServer({
			host: "127.0.0.1",
			port: 0,
			mainAgent: createMainAgentMock(),
			signalRouter: createSignalRouterMock(),
			contextManager: createContextManagerMock(),
			conversationStore: createConversationStoreMock(),
			broadcaster: createBroadcasterMock(),
			bridge: createBridgeMock(),
			commandRegistry: new CommandRegistry(),
			executionEventStore: new ExecutionEventStore(),
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
			{ agentName: "cliclaw-broken", agentId: "cliclaw-broken", paneTarget: "broken:0.0", status: "active" },
			{ agentName: "cliclaw-ok", agentId: "cliclaw-ok", paneTarget: "ok:0.0", status: "idle" },
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
			signalRouter: createSignalRouterMock(),
			contextManager: createContextManagerMock(),
			conversationStore: createConversationStoreMock(),
			broadcaster: createBroadcasterMock(),
			bridge,
			commandRegistry: new CommandRegistry(),
			executionEventStore: new ExecutionEventStore(),
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
		expect(sessions[0].agentName).toBe("cliclaw-broken");
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
				agentName: "cliclaw-test",
				agentId: "cliclaw-test",
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
			signalRouter: createSignalRouterMock(),
			contextManager: createContextManagerMock(),
			conversationStore: createConversationStoreMock(),
			broadcaster,
			bridge,
			commandRegistry: new CommandRegistry(),
			executionEventStore: new ExecutionEventStore(),
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
		expect(terminalMsg.agents[0].agentId).toBe("cliclaw-test");
		expect(terminalMsg.agents[0].agentName).toBe("cliclaw-test");
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
			signalRouter: createSignalRouterMock(),
			contextManager: createContextManagerMock(),
			conversationStore: createConversationStoreMock(),
			broadcaster,
			bridge: createBridgeMock(),
			commandRegistry: new CommandRegistry(),
			executionEventStore: new ExecutionEventStore(),
		});

		capturedOnAgentChange!();
		await new Promise((r) => setTimeout(r, 100));

		const terminalMsg = broadcasts.find((m) => m.type === "agent_terminals");
		expect(terminalMsg).toBeDefined();
		expect(terminalMsg.agents).toEqual([]);
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
			signalRouter: createSignalRouterMock(),
			contextManager: createContextManagerMock(),
			conversationStore: createConversationStoreMock(),
			broadcaster: createBroadcasterMock(),
			bridge: createBridgeMock(),
			commandRegistry: new CommandRegistry(),
			executionEventStore: new ExecutionEventStore(),
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
