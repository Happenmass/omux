import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type CliclawConfig,
	getConfigDir,
	getConfigFilePath,
	getGlobalStorageDir,
	loadConfig,
	type McpServerDefinition,
	normalizeAgents,
	saveConfig,
} from "../../src/utils/config.js";

// Sandboxed under CLICLAW_HOME by test/setup.ts — never the real ~/.cliclaw.
const configDir = getConfigDir();
const configFile = getConfigFilePath();

describe("getGlobalStorageDir", () => {
	it("honors the CLICLAW_HOME override (set by test/setup.ts)", () => {
		expect(getGlobalStorageDir()).toBe(process.env.CLICLAW_HOME);
	});

	it("falls back to ~/.cliclaw when CLICLAW_HOME is unset", () => {
		const saved = process.env.CLICLAW_HOME;
		delete process.env.CLICLAW_HOME;
		try {
			// homedir() itself is redirected to the sandbox by test/setup.ts.
			expect(getGlobalStorageDir()).toBe(join(homedir(), ".cliclaw"));
		} finally {
			process.env.CLICLAW_HOME = saved;
		}
	});
});

describe("mcpServers config", () => {
	afterEach(async () => {
		await rm(configFile, { force: true });
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
	afterEach(async () => {
		await rm(configFile, { force: true });
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

describe("autoTidy config", () => {
	afterEach(async () => {
		await rm(configFile, { force: true });
	});

	it("defaults memory.autoTidy to disabled at 23:30", async () => {
		await mkdir(configDir, { recursive: true });
		await writeFile(configFile, JSON.stringify({ debug: false }), "utf-8");
		const config = await loadConfig();
		expect(config.memory.autoTidy).toEqual({ enabled: false, time: "23:30" });
	});

	it("deep-merges a partial memory.autoTidy over the defaults (keeps default time)", async () => {
		await mkdir(configDir, { recursive: true });
		await writeFile(configFile, JSON.stringify({ memory: { autoTidy: { enabled: true } } }), "utf-8");
		const config = await loadConfig();
		expect(config.memory.autoTidy).toEqual({ enabled: true, time: "23:30" });
	});

	it("preserves a custom autoTidy time", async () => {
		await mkdir(configDir, { recursive: true });
		await writeFile(configFile, JSON.stringify({ memory: { autoTidy: { enabled: true, time: "02:15" } } }), "utf-8");
		const config = await loadConfig();
		expect(config.memory.autoTidy).toEqual({ enabled: true, time: "02:15" });
	});
});

describe("normalizeAgents", () => {
	function base(overrides: Partial<CliclawConfig>): CliclawConfig {
		return { defaultAgent: "claude-code", enabledAgents: ["claude-code"], ...overrides } as CliclawConfig;
	}

	it("derives enabledAgents from defaultAgent for legacy configs (no enabledAgents)", () => {
		const config = base({ defaultAgent: "codex", enabledAgents: undefined as any });
		normalizeAgents(config, false);
		expect(config.enabledAgents).toEqual(["codex"]);
		expect(config.defaultAgent).toBe("codex");
	});

	it("keeps a user-provided enabled set and drops unknown adapters", () => {
		const config = base({ defaultAgent: "claude-code", enabledAgents: ["claude-code", "codex", "bogus"] });
		normalizeAgents(config, true);
		expect(config.enabledAgents).toEqual(["claude-code", "codex"]);
	});

	it("repoints defaultAgent to the first active adapter when it is not enabled", () => {
		const config = base({ defaultAgent: "claude-code", enabledAgents: ["codex"] });
		normalizeAgents(config, true);
		expect(config.defaultAgent).toBe("codex");
	});

	it("falls back to claude-code when the enabled set is empty / all-unknown", () => {
		const config = base({ defaultAgent: "claude-code", enabledAgents: ["nope"] });
		normalizeAgents(config, true);
		expect(config.enabledAgents).toEqual(["claude-code"]);
		expect(config.defaultAgent).toBe("claude-code");
	});

	it("de-duplicates the enabled set", () => {
		const config = base({ defaultAgent: "codex", enabledAgents: ["codex", "codex", "claude-code"] });
		normalizeAgents(config, true);
		expect(config.enabledAgents).toEqual(["codex", "claude-code"]);
	});
});

describe("agent activation config (loadConfig)", () => {
	afterEach(async () => {
		await rm(configFile, { force: true });
	});

	it("defaults to claude-code only", async () => {
		await mkdir(configDir, { recursive: true });
		await writeFile(configFile, JSON.stringify({ debug: false }), "utf-8");
		const config = await loadConfig();
		expect(config.enabledAgents).toEqual(["claude-code"]);
		expect(config.defaultAgent).toBe("claude-code");
	});

	it("backfills enabledAgents from a legacy defaultAgent-only config", async () => {
		await mkdir(configDir, { recursive: true });
		await writeFile(configFile, JSON.stringify({ defaultAgent: "codex" }), "utf-8");
		const config = await loadConfig();
		expect(config.enabledAgents).toEqual(["codex"]);
		expect(config.defaultAgent).toBe("codex");
	});

	it("preserves an explicit enabledAgents set", async () => {
		await mkdir(configDir, { recursive: true });
		await writeFile(
			configFile,
			JSON.stringify({ defaultAgent: "claude-code", enabledAgents: ["claude-code", "codex"] }),
			"utf-8",
		);
		const config = await loadConfig();
		expect(config.enabledAgents).toEqual(["claude-code", "codex"]);
		expect(config.defaultAgent).toBe("claude-code");
	});
});
