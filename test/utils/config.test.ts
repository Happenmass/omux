import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type OmuxConfig,
	getConfigDir,
	getConfigFilePath,
	getGlobalDbPath,
	getGlobalStorageDir,
	loadConfig,
	type McpServerDefinition,
	normalizeAgents,
	omuxHome,
	projectDotDir,
	saveConfig,
} from "../../src/utils/config.js";

// Sandboxed under OMUX_HOME by test/setup.ts — never the real ~/.omux.
const configDir = getConfigDir();
const configFile = getConfigFilePath();

describe("getGlobalStorageDir", () => {
	it("honors the OMUX_HOME override (set by test/setup.ts)", () => {
		expect(getGlobalStorageDir()).toBe(process.env.OMUX_HOME);
	});

	it("falls back to ~/.omux when OMUX_HOME is unset", () => {
		const saved = process.env.OMUX_HOME;
		delete process.env.OMUX_HOME;
		try {
			// homedir() itself is redirected to the sandbox by test/setup.ts.
			expect(getGlobalStorageDir()).toBe(join(homedir(), ".omux"));
		} finally {
			process.env.OMUX_HOME = saved;
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
	function base(overrides: Partial<OmuxConfig>): OmuxConfig {
		return { defaultAgent: "claude-code", enabledAgents: ["claude-code"], ...overrides } as OmuxConfig;
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

describe("legacy cliclaw compatibility", () => {
	describe("omuxHome", () => {
		it("honors the legacy CLICLAW_HOME env var when OMUX_HOME is unset", () => {
			const savedOmux = process.env.OMUX_HOME;
			const savedLegacy = process.env.CLICLAW_HOME;
			delete process.env.OMUX_HOME;
			process.env.CLICLAW_HOME = join(homedir(), ".legacy-cliclaw-env");
			try {
				expect(omuxHome()).toBe(join(homedir(), ".legacy-cliclaw-env"));
			} finally {
				process.env.OMUX_HOME = savedOmux;
				if (savedLegacy === undefined) delete process.env.CLICLAW_HOME;
				else process.env.CLICLAW_HOME = savedLegacy;
			}
		});

		it("prefers OMUX_HOME over CLICLAW_HOME when both are set", () => {
			const savedLegacy = process.env.CLICLAW_HOME;
			process.env.CLICLAW_HOME = join(homedir(), ".legacy-cliclaw-env");
			try {
				expect(omuxHome()).toBe(process.env.OMUX_HOME);
			} finally {
				if (savedLegacy === undefined) delete process.env.CLICLAW_HOME;
				else process.env.CLICLAW_HOME = savedLegacy;
			}
		});

		it("uses an existing legacy ~/.cliclaw dir when no env override and no ~/.omux exist", async () => {
			const savedOmux = process.env.OMUX_HOME;
			delete process.env.OMUX_HOME;
			const omuxDir = join(homedir(), ".omux");
			const legacyDir = join(homedir(), ".cliclaw");
			await rm(omuxDir, { recursive: true, force: true });
			await mkdir(legacyDir, { recursive: true });
			try {
				expect(omuxHome()).toBe(legacyDir);
			} finally {
				process.env.OMUX_HOME = savedOmux;
				await rm(legacyDir, { recursive: true, force: true });
			}
		});

		it("prefers an existing ~/.omux dir over a legacy ~/.cliclaw dir", async () => {
			const savedOmux = process.env.OMUX_HOME;
			delete process.env.OMUX_HOME;
			const omuxDir = join(homedir(), ".omux");
			const legacyDir = join(homedir(), ".cliclaw");
			await mkdir(omuxDir, { recursive: true });
			await mkdir(legacyDir, { recursive: true });
			try {
				expect(omuxHome()).toBe(omuxDir);
			} finally {
				process.env.OMUX_HOME = savedOmux;
				await rm(omuxDir, { recursive: true, force: true });
				await rm(legacyDir, { recursive: true, force: true });
			}
		});
	});

	describe("projectDotDir", () => {
		const projectRoot = join(homedir(), "compat-project");

		afterEach(async () => {
			await rm(projectRoot, { recursive: true, force: true });
		});

		it("defaults to .omux when neither dot dir exists", async () => {
			await mkdir(projectRoot, { recursive: true });
			expect(projectDotDir(projectRoot)).toBe(join(projectRoot, ".omux"));
		});

		it("falls back to a legacy .cliclaw dir when only it exists", async () => {
			await mkdir(join(projectRoot, ".cliclaw"), { recursive: true });
			expect(projectDotDir(projectRoot)).toBe(join(projectRoot, ".cliclaw"));
		});

		it("prefers .omux when both dot dirs exist", async () => {
			await mkdir(join(projectRoot, ".omux"), { recursive: true });
			await mkdir(join(projectRoot, ".cliclaw"), { recursive: true });
			expect(projectDotDir(projectRoot)).toBe(join(projectRoot, ".omux"));
		});
	});

	describe("getGlobalDbPath", () => {
		afterEach(async () => {
			for (const name of ["omux.db", "memory.sqlite", "cliclaw.db"]) {
				await rm(join(configDir, name), { force: true });
			}
		});

		it("defaults to omux.db when no database exists yet", () => {
			expect(getGlobalDbPath()).toBe(join(configDir, "omux.db"));
		});

		it("reuses a legacy memory.sqlite database", async () => {
			await mkdir(configDir, { recursive: true });
			await writeFile(join(configDir, "memory.sqlite"), "", "utf-8");
			expect(getGlobalDbPath()).toBe(join(configDir, "memory.sqlite"));
		});

		it("reuses a legacy cliclaw.db database", async () => {
			await mkdir(configDir, { recursive: true });
			await writeFile(join(configDir, "cliclaw.db"), "", "utf-8");
			expect(getGlobalDbPath()).toBe(join(configDir, "cliclaw.db"));
		});

		it("prefers omux.db over legacy databases when both exist", async () => {
			await mkdir(configDir, { recursive: true });
			await writeFile(join(configDir, "omux.db"), "", "utf-8");
			await writeFile(join(configDir, "memory.sqlite"), "", "utf-8");
			expect(getGlobalDbPath()).toBe(join(configDir, "omux.db"));
		});
	});
});
