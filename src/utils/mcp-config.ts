import { mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getConfigDir, type McpServerDefinition } from "./config.js";

// Resolved lazily via getConfigDir() so the CLICLAW_HOME override applies.
export function getMcpConfigDir(): string {
	return join(getConfigDir(), "tmp", "mcp-configs");
}

/**
 * Generate a temporary MCP config JSON file for a SubAgent.
 * Creates the temp directory if it doesn't exist.
 * Returns the absolute path to the generated file.
 *
 * Strips Cliclaw-only metadata fields (e.g. `description`) before writing,
 * since the consuming agent's `--mcp-config` schema doesn't recognize them.
 */
export async function generateMcpConfigFile(
	servers: Record<string, McpServerDefinition>,
	sessionName: string,
): Promise<string> {
	await mkdir(getMcpConfigDir(), { recursive: true });
	const filePath = join(getMcpConfigDir(), `${sessionName}.json`);
	const sanitized: Record<string, Omit<McpServerDefinition, "description">> = {};
	for (const [name, def] of Object.entries(servers)) {
		const { description: _description, ...runtime } = def;
		sanitized[name] = runtime;
	}
	const content = JSON.stringify({ mcpServers: sanitized }, null, "\t");
	await writeFile(filePath, content, "utf-8");
	return filePath;
}

/**
 * Delete the temporary MCP config file for a given session.
 * Does not throw if the file doesn't exist.
 */
export async function cleanupMcpConfigFile(sessionName: string): Promise<void> {
	const filePath = join(getMcpConfigDir(), `${sessionName}.json`);
	try {
		await unlink(filePath);
	} catch (err: any) {
		if (err?.code !== "ENOENT") {
			throw err;
		}
	}
}

/**
 * Remove the entire MCP config temp directory and all its contents.
 * Does not throw if the directory doesn't exist.
 */
export async function cleanupAllMcpConfigFiles(): Promise<void> {
	try {
		await rm(getMcpConfigDir(), { recursive: true, force: true });
	} catch (err: any) {
		if (err?.code !== "ENOENT") {
			throw err;
		}
	}
}

/**
 * Render a Markdown summary of configured MCP servers for injection into the
 * Main Agent system prompt. Used by `{{available_mcp_servers}}`.
 */
export function buildMcpServersSummary(servers: Record<string, McpServerDefinition> | undefined): string {
	const entries = servers ? Object.entries(servers) : [];
	if (entries.length === 0) {
		return "No MCP servers are currently configured. Use the settings UI (gear icon in the chat header) to register MCP servers before passing `mcp_servers` to `create_agent`.";
	}
	const lines = entries.map(([name, def]) => {
		const desc = def.description?.trim();
		return desc ? `- **${name}** — ${desc}` : `- **${name}** _(no description)_`;
	});
	return [
		"The following MCP servers are configured in Cliclaw and may be passed by name to `create_agent({ mcp_servers: [...] })`. Pick only the servers the SubAgent actually needs:",
		"",
		...lines,
		"",
		"If a relevant server is missing, ask the user to add it via the settings UI rather than guessing names.",
	].join("\n");
}

/**
 * Select a subset of MCP servers by name from the full config.
 * Returns the selected servers record, or an error with available server names.
 */
export function selectMcpServers(
	allServers: Record<string, McpServerDefinition>,
	names: string[],
): { servers: Record<string, McpServerDefinition> } | { error: string } {
	const unknown = names.filter((n) => !(n in allServers));
	if (unknown.length > 0) {
		const available = Object.keys(allServers).join(", ");
		return {
			error: `Unknown MCP server(s): ${unknown.join(", ")}. Available servers: ${available || "(none)"}`,
		};
	}
	const selected: Record<string, McpServerDefinition> = {};
	for (const name of names) {
		selected[name] = allServers[name];
	}
	return { servers: selected };
}
