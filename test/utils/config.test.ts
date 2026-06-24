import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type CliclawConfig,
	type McpServerDefinition,
	getGlobalStorageDir,
	loadConfig,
	saveConfig,
} from "../../src/utils/config.js";

describe("getGlobalStorageDir", () => {
	it("returns ~/.cliclaw/", () => {
		const dir = getGlobalStorageDir();
		expect(dir).toBe(join(homedir(), ".cliclaw"));
	});
});

describe("mcpServers config", () => {
	const configDir = join(homedir(), ".cliclaw");
	const configFile = join(configDir, "config.json");
	let originalContent: string | null = null;

	beforeEach(async () => {
		if (existsSync(configFile)) {
			originalContent = await readFile(configFile, "utf-8");
		} else {
			originalContent = null;
		}
	});

	afterEach(async () => {
		if (originalContent !== null) {
			await writeFile(configFile, originalContent, "utf-8");
		} else if (existsSync(configFile)) {
			await rm(configFile);
		}
	});

	it("returns undefined mcpServers when config has no mcpServers key", async () => {
		await mkdir(configDir, { recursive: true });
		await writeFile(configFile, JSON.stringify({ debug: false }), "utf-8");
		const config = await loadConfig();
		expect(config.mcpServers).toBeUndefined();
	});

	it("preserves mcpServers when present in config", async () => {
		const servers: Record<string, McpServerDefinition> = {
			"my-server": { command: "node", args: ["server.js"], type: "stdio" },
			"sse-server": { command: "curl", type: "sse", url: "http://localhost:3001/sse" },
			"http-server": { command: "curl", type: "http", url: "http://localhost:3002/mcp" },
		};
		await mkdir(configDir, { recursive: true });
		await writeFile(configFile, JSON.stringify({ mcpServers: servers }), "utf-8");
		const config = await loadConfig();
		expect(config.mcpServers).toEqual(servers);
	});

	it("round-trips an http-type mcp server through save and load", async () => {
		const servers: Record<string, McpServerDefinition> = {
			"alibaba-obs": {
				command: "curl",
				type: "http",
				url: "https://example.aliyun.com/mcp",
				description: "Alibaba observability MCP",
			},
		};
		const config = await loadConfig();
		config.mcpServers = servers;
		await saveConfig(config);

		const reloaded = await loadConfig();
		expect(reloaded.mcpServers).toEqual(servers);
		expect(reloaded.mcpServers?.["alibaba-obs"].type).toBe("http");
		expect(reloaded.mcpServers?.["alibaba-obs"].url).toBe("https://example.aliyun.com/mcp");
	});

	it("round-trips mcpServers through save and load", async () => {
		const servers: Record<string, McpServerDefinition> = {
			"test-mcp": { command: "uvx", args: ["code-review-graph", "serve"], type: "stdio" },
		};
		const config = await loadConfig();
		config.mcpServers = servers;
		await saveConfig(config);

		const reloaded = await loadConfig();
		expect(reloaded.mcpServers).toEqual(servers);
	});
});

describe("autoContinue config", () => {
	const configDir = join(homedir(), ".cliclaw");
	const configFile = join(configDir, "config.json");
	let saved: string | null = null;

	beforeEach(async () => {
		saved = existsSync(configFile) ? await readFile(configFile, "utf-8") : null;
	});
	afterEach(async () => {
		if (saved !== null) await writeFile(configFile, saved, "utf-8");
		else if (existsSync(configFile)) await rm(configFile);
	});

	it("defaults autoContinue to disabled with a maxConsecutive cap", async () => {
		await mkdir(configDir, { recursive: true });
		await writeFile(configFile, JSON.stringify({ debug: false }), "utf-8");
		const config = await loadConfig();
		expect(config.autoContinue).toEqual({ enabled: false, maxConsecutive: 10 });
	});

	it("merges a partial autoContinue over the defaults", async () => {
		await mkdir(configDir, { recursive: true });
		await writeFile(configFile, JSON.stringify({ autoContinue: { enabled: true } }), "utf-8");
		const config = await loadConfig();
		expect(config.autoContinue).toEqual({ enabled: true, maxConsecutive: 10 });
	});
});
