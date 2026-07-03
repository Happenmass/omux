import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getConfigDir, type McpServerDefinition } from "../../src/utils/config.js";
import {
	buildMcpServersSummary,
	cleanupAllMcpConfigFiles,
	cleanupMcpConfigFile,
	generateMcpConfigFile,
	getMcpConfigDir,
	selectMcpServers,
} from "../../src/utils/mcp-config.js";

// Sandboxed under CLICLAW_HOME by test/setup.ts — never the real ~/.cliclaw.
const MCP_DIR = join(getConfigDir(), "tmp", "mcp-configs");

afterEach(async () => {
	// Clean up any test artifacts
	await rm(MCP_DIR, { recursive: true, force: true }).catch(() => {});
});

describe("getMcpConfigDir", () => {
	it("returns the expected path", () => {
		expect(getMcpConfigDir()).toBe(MCP_DIR);
	});
});

describe("generateMcpConfigFile", () => {
	it("creates a JSON file with selected servers", async () => {
		const servers: Record<string, McpServerDefinition> = {
			"server-a": { command: "node", args: ["a.js"], type: "stdio" },
			"server-b": { command: "uvx", args: ["b"], type: "stdio" },
		};
		const path = await generateMcpConfigFile(servers, "cliclaw-chat-1");
		expect(path).toBe(join(MCP_DIR, "cliclaw-chat-1.json"));
		expect(existsSync(path)).toBe(true);

		const content = JSON.parse(await readFile(path, "utf-8"));
		expect(content).toEqual({ mcpServers: servers });
	});

	it("strips description field from runtime mcp config file", async () => {
		const servers: Record<string, McpServerDefinition> = {
			"server-a": {
				command: "node",
				args: ["a.js"],
				type: "stdio",
				description: "Knowledge graph for code review",
			},
			"server-b": { command: "uvx", args: ["b"], type: "stdio" },
		};
		const path = await generateMcpConfigFile(servers, "cliclaw-strip");
		const content = JSON.parse(await readFile(path, "utf-8"));
		expect(content.mcpServers["server-a"]).toEqual({
			command: "node",
			args: ["a.js"],
			type: "stdio",
		});
		expect(content.mcpServers["server-a"].description).toBeUndefined();
		expect(content.mcpServers["server-b"]).toEqual(servers["server-b"]);
	});

	it("preserves type and url for http-type servers", async () => {
		const servers: Record<string, McpServerDefinition> = {
			"alibaba-obs": {
				command: "curl",
				type: "http",
				url: "https://example.aliyun.com/mcp",
				description: "Alibaba observability MCP",
			},
		};
		const path = await generateMcpConfigFile(servers, "cliclaw-http");
		const content = JSON.parse(await readFile(path, "utf-8"));
		expect(content.mcpServers["alibaba-obs"]).toEqual({
			command: "curl",
			type: "http",
			url: "https://example.aliyun.com/mcp",
		});
		expect(content.mcpServers["alibaba-obs"].description).toBeUndefined();
	});

	it("creates file with empty servers", async () => {
		const path = await generateMcpConfigFile({}, "cliclaw-empty");
		const content = JSON.parse(await readFile(path, "utf-8"));
		expect(content).toEqual({ mcpServers: {} });
	});

	it("auto-creates directory if it does not exist", async () => {
		await rm(MCP_DIR, { recursive: true, force: true }).catch(() => {});
		expect(existsSync(MCP_DIR)).toBe(false);

		await generateMcpConfigFile({ s: { command: "x", type: "stdio" } }, "test");
		expect(existsSync(MCP_DIR)).toBe(true);
	});
});

describe("cleanupMcpConfigFile", () => {
	it("deletes an existing config file", async () => {
		const path = await generateMcpConfigFile({}, "cleanup-test");
		expect(existsSync(path)).toBe(true);

		await cleanupMcpConfigFile("cleanup-test");
		expect(existsSync(path)).toBe(false);
	});

	it("does not throw for non-existent file", async () => {
		await expect(cleanupMcpConfigFile("nonexistent-session")).resolves.not.toThrow();
	});
});

describe("cleanupAllMcpConfigFiles", () => {
	it("removes the entire directory", async () => {
		await generateMcpConfigFile({}, "file-1");
		await generateMcpConfigFile({}, "file-2");
		await generateMcpConfigFile({}, "file-3");
		expect(existsSync(MCP_DIR)).toBe(true);

		await cleanupAllMcpConfigFiles();
		expect(existsSync(MCP_DIR)).toBe(false);
	});

	it("does not throw when directory does not exist", async () => {
		await rm(MCP_DIR, { recursive: true, force: true }).catch(() => {});
		await expect(cleanupAllMcpConfigFiles()).resolves.not.toThrow();
	});
});

describe("buildMcpServersSummary", () => {
	it("returns a guidance message when no servers are configured", () => {
		expect(buildMcpServersSummary(undefined)).toMatch(/No MCP servers/i);
		expect(buildMcpServersSummary({})).toMatch(/No MCP servers/i);
	});

	it("renders each configured server with its description", () => {
		const summary = buildMcpServersSummary({
			"code-review-graph": {
				command: "node",
				type: "stdio",
				description: "Knowledge graph for code review",
			},
			filesystem: { command: "fs", type: "stdio" },
		});
		expect(summary).toContain("**code-review-graph**");
		expect(summary).toContain("Knowledge graph for code review");
		expect(summary).toContain("**filesystem**");
		expect(summary).toContain("(no description)");
	});
});

describe("selectMcpServers", () => {
	const allServers: Record<string, McpServerDefinition> = {
		a: { command: "cmd-a", type: "stdio" },
		b: { command: "cmd-b", args: ["arg1"], type: "stdio" },
		c: { command: "cmd-c", type: "sse", url: "http://localhost:3001" },
	};

	it("selects a subset of servers", () => {
		const result = selectMcpServers(allServers, ["a", "c"]);
		expect("servers" in result).toBe(true);
		if ("servers" in result) {
			expect(Object.keys(result.servers)).toEqual(["a", "c"]);
			expect(result.servers.a).toEqual(allServers.a);
			expect(result.servers.c).toEqual(allServers.c);
		}
	});

	it("returns error for unknown server names", () => {
		const result = selectMcpServers(allServers, ["a", "unknown"]);
		expect("error" in result).toBe(true);
		if ("error" in result) {
			expect(result.error).toContain("unknown");
			expect(result.error).toContain("Available servers");
		}
	});

	it("returns empty record for empty names array", () => {
		const result = selectMcpServers(allServers, []);
		expect("servers" in result).toBe(true);
		if ("servers" in result) {
			expect(result.servers).toEqual({});
		}
	});
});
