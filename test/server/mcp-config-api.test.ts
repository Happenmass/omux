import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommandRegistry } from "../../src/server/command-registry.js";
import { type ServerInstance, startServer } from "../../src/server/index.js";

const configFile = join(homedir(), ".cliclaw", "config.json");

function createMainAgentMock() {
	return {
		state: "idle" as const,
		handleMessage: async () => undefined,
		waitForIdle: async () => undefined,
		setOnAgentChange: () => undefined,
		getActiveAgents: () => [],
		getPendingUserMessageCount: () => 0,
	} as any;
}

function createMocks() {
	return {
		mainAgent: createMainAgentMock(),
		contextManager: { clear: async () => {}, updateModule: () => {} } as any,
		conversationStore: {
			loadMessages: () => [],
			loadMessagesWithCreatedAt: () => [],
			getMessageCount: () => 0,
		} as any,
		broadcaster: {
			addClient: () => {},
			removeClient: () => {},
			broadcast: () => {},
			getClientCount: () => 0,
		} as any,
		bridge: { capturePane: async () => ({ content: "", lines: 0 }) } as any,
		commandRegistry: new CommandRegistry(),
	};
}

function getCookieHeader(response: Response): string {
	const cookie = response.headers.get("set-cookie");
	if (!cookie) throw new Error("Expected Set-Cookie header");
	return cookie.split(";")[0];
}

describe("MCP Server Config API", () => {
	let server: ServerInstance | null = null;
	let originalConfig: string | null = null;

	beforeEach(async () => {
		if (existsSync(configFile)) {
			originalConfig = await readFile(configFile, "utf-8");
		} else {
			originalConfig = null;
		}
	});

	afterEach(async () => {
		if (server) {
			await server.close();
			server = null;
		}
		// Restore original config
		if (originalConfig !== null) {
			await writeFile(configFile, originalConfig, "utf-8");
		}
	});

	async function startAndGetCookie() {
		server = await startServer({
			host: "127.0.0.1",
			port: 0,
			...createMocks(),
		});
		const landing = await fetch(`http://127.0.0.1:${server.port}/`);
		return getCookieHeader(landing);
	}

	it("GET /api/config/mcp-servers returns empty object when no servers configured", async () => {
		// Ensure config has no mcpServers
		if (existsSync(configFile)) {
			const raw = JSON.parse(await readFile(configFile, "utf-8"));
			delete raw.mcpServers;
			await writeFile(configFile, JSON.stringify(raw), "utf-8");
		}

		const cookie = await startAndGetCookie();
		const res = await fetch(`http://127.0.0.1:${server!.port}/api/config/mcp-servers`, {
			headers: { Cookie: cookie },
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({});
	});

	it("PUT /api/config/mcp-servers saves and returns server config", async () => {
		const cookie = await startAndGetCookie();
		const servers = {
			"my-server": { command: "node", args: ["srv.js"], type: "stdio" },
		};

		const putRes = await fetch(`http://127.0.0.1:${server!.port}/api/config/mcp-servers`, {
			method: "PUT",
			headers: { Cookie: cookie, "Content-Type": "application/json" },
			body: JSON.stringify(servers),
		});
		expect(putRes.status).toBe(200);
		expect(await putRes.json()).toEqual(servers);

		// Verify GET returns the saved data
		const getRes = await fetch(`http://127.0.0.1:${server!.port}/api/config/mcp-servers`, {
			headers: { Cookie: cookie },
		});
		expect(getRes.status).toBe(200);
		expect(await getRes.json()).toEqual(servers);
	});

	it("PUT /api/config/mcp-servers rejects array body", async () => {
		const cookie = await startAndGetCookie();

		const res = await fetch(`http://127.0.0.1:${server!.port}/api/config/mcp-servers`, {
			method: "PUT",
			headers: { Cookie: cookie, "Content-Type": "application/json" },
			body: JSON.stringify([1, 2, 3]),
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toBeDefined();
	});

	it("serves the API to loopback callers without an explicit cookie (trusted single-machine UX)", async () => {
		// Under the pairing model (SRV-1) loopback is trusted implicitly, so a cookieless
		// request from 127.0.0.1 is served rather than 401'd. Remote (non-loopback) callers
		// without a valid token still get 401 — covered by the auth unit tests.
		server = await startServer({
			host: "127.0.0.1",
			port: 0,
			...createMocks(),
		});

		const res = await fetch(`http://127.0.0.1:${server.port}/api/config/mcp-servers`);
		expect(res.status).toBe(200);
	});
});
