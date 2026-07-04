import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ThinkingLevel } from "../llm/types.js";

export type { ThinkingLevel };

export interface LLMConfig {
	provider: string;
	model: string;
	apiKey?: string;
	baseUrl?: string;
	/** HTTP/HTTPS/SOCKS proxy URL for main-agent LLM API calls only (e.g. "http://127.0.0.1:7890"). Sub-agents are unaffected. */
	proxy?: string;
	/** Extended thinking / reasoning effort. Default "off". */
	thinking?: ThinkingLevel;
}

export interface ProviderKeyConfig {
	[providerName: string]: {
		apiKey?: string;
		baseUrl?: string;
	};
}

export interface StateDetectorConfig {
	pollIntervalMs: number;
	stableThresholdMs: number;
	captureLines: number;
}

export interface TmuxConfig {
	sessionPrefix: string;
}

export interface AutoTidyConfig {
	/**
	 * When true, a nightly `/tidy` runs on a schedule to archive outdated memory entries.
	 * Default false — otherwise it silently interrupts long overnight autonomous runs.
	 */
	enabled: boolean;
	/** Local wall-clock time to run the nightly tidy, "HH:MM". Default "23:30". */
	time?: string;
}

export interface MemoryConfig {
	/** Embedding provider: "auto" | "local" | "openai" | "gemini" | "voyage" | "mistral" | "none" */
	embeddingProvider: string;
	/** Embedding model override (provider-specific). If omitted, uses provider default. */
	embeddingModel?: string;
	/** Maximum tokens per chunk when indexing markdown files. Default 400. */
	chunkTokens: number;
	/** Overlap tokens between adjacent chunks. Default 50. */
	chunkOverlap: number;
	/** Hybrid search vector weight (0-1). Keyword weight = 1 - vectorWeight. Default 0.7. */
	vectorWeight: number;
	/** Minimum score threshold for search results (0-1). Default 0.1. */
	minScore: number;
	/** Maximum number of search results to return. Default 10. */
	topK: number;
	/** Temporal decay half-life in days for date-named files. Default 30. */
	decayHalfLifeDays: number;
	/** Context window flush threshold ratio. Default 0.6. */
	flushThreshold: number;
	/** Number of recent tool results to keep in full context. Older results are summarized. Default 20. */
	toolResultRetention: number;
	/** Scheduled nightly memory tidy. Disabled by default so it never interrupts overnight runs. */
	autoTidy: AutoTidyConfig;
}

export interface SkillsConfig {
	/** Skill names to disable (won't be loaded even if discovered) */
	disabled: string[];
	/**
	 * Absolute workspace directories whose `.omux/skills/` (or legacy cliclaw `.cliclaw/skills/`) are trusted to be loaded.
	 * Workspace skills execute with orchestrator authority (prompt-enrichment lands in the
	 * MainAgent SYSTEM PROMPT, main-agent-tool bodies carry tool-result authority), so a
	 * cloned repo's skills are NOT loaded unless its absolute path is listed here. Default [].
	 * Adapter-bundled skills are unaffected.
	 */
	trustedWorkspaceDirs?: string[];
}

export interface LearningConfig {
	/** Whether the Learning Sessions feature is enabled. Default false. */
	enabled: boolean;
}

export interface AutoContinueConfig {
	/** When true, after the loop naturally finishes a gate LLM decides whether to keep going. Default false. */
	enabled: boolean;
	/** Max consecutive auto-continues before forcing a hand-back to the user. Default 10. */
	maxConsecutive: number;
}

export interface McpServerDefinition {
	command: string;
	args?: string[];
	env?: Record<string, string>;
	type: "stdio" | "sse" | "http";
	/** URL for SSE-type and HTTP-type servers */
	url?: string;
	/** Human-readable description shown to the Main Agent when selecting MCPs for SubAgents. Not written to the runtime mcp config file. */
	description?: string;
}

export interface MdnsConfig {
	/** Whether to advertise the server over mDNS so it's reachable as `<name>.local`. Default true. */
	enabled: boolean;
	/** Bare hostname without ".local" suffix (e.g. "omux" → "omux.local"). */
	name: string;
}

export interface ContextConfig {
	/**
	 * Explicit context window size in tokens. When set, it overrides the automatic per-model
	 * lookup ContextManager performs from the model id. Leave unset (omit / 0) to let Omux
	 * pick a sensible window for known model families (claude → 200k, gemini/gpt-4.1 → 1M, …),
	 * falling back to 500000 with a startup warning for unrecognized models.
	 */
	contextWindowLimit?: number;
	/** Compression threshold ratio (0-1). Conversation is compressed when usage exceeds this ratio. Default 0.7. */
	compressionThreshold: number;
}

/** Coding-agent adapters Omux knows how to launch. */
export const KNOWN_AGENTS = ["claude-code", "codex"] as const;
export type KnownAgent = (typeof KNOWN_AGENTS)[number];

export interface OmuxConfig {
	/** Adapter used by `create_agent` when no `adapter` is specified. Must be one of `enabledAgents`. */
	defaultAgent: string;
	/** Adapters that are active: their capabilities are injected into the Main Agent prompt and selectable via `create_agent`. */
	enabledAgents: string[];
	debug: boolean;
	/** UI/prompt language override. Auto-detected from system locale if omitted. */
	locale?: string;
	llm: LLMConfig;
	providers?: ProviderKeyConfig;
	context: ContextConfig;
	stateDetector: StateDetectorConfig;
	tmux: TmuxConfig;
	memory: MemoryConfig;
	skills: SkillsConfig;
	learning: LearningConfig;
	autoContinue: AutoContinueConfig;
	mdns: MdnsConfig;
	mcpServers?: Record<string, McpServerDefinition>;
}

let warnedLegacyHomeEnv = false;
let warnedLegacyHomeDir = false;

/**
 * Root of Omux's global storage (config, memory, logs, learning, ...).
 *
 * Resolution order:
 *   1. `OMUX_HOME` env var (tests set it to a temp dir so they never touch
 *      the real home directory)
 *   2. `CLICLAW_HOME` env var — legacy cliclaw override, honored with a
 *      one-time deprecation notice
 *   3. `~/.omux` if it exists
 *   4. `~/.cliclaw` if it exists — legacy cliclaw home, used as-is (no
 *      automatic migration), with a one-time notice
 *   5. `~/.omux` (created lazily by the ensure* helpers)
 *
 * Resolved lazily on every call so an env change made after module load
 * still applies.
 */
export function omuxHome(): string {
	if (process.env.OMUX_HOME) {
		return process.env.OMUX_HOME;
	}
	if (process.env.CLICLAW_HOME) {
		if (!warnedLegacyHomeEnv) {
			warnedLegacyHomeEnv = true;
			console.error("[omux] CLICLAW_HOME is deprecated; use OMUX_HOME instead.");
		}
		return process.env.CLICLAW_HOME;
	}
	const omuxDir = join(homedir(), ".omux");
	if (existsSync(omuxDir)) {
		return omuxDir;
	}
	const legacyDir = join(homedir(), ".cliclaw");
	if (existsSync(legacyDir)) {
		if (!warnedLegacyHomeDir) {
			warnedLegacyHomeDir = true;
			console.error("[omux] using legacy ~/.cliclaw home");
		}
		return legacyDir;
	}
	return omuxDir;
}

/**
 * Resolve the per-project dot directory (project MEMORY.md, workspace skills,
 * prompt overrides live under it).
 *
 * Prefers `<projectDir>/.omux` when it exists; falls back to the legacy
 * `<projectDir>/.cliclaw` when only that exists; defaults to `.omux` when
 * neither exists (writers create it on demand).
 */
export function projectDotDir(projectDir: string): string {
	const omuxDir = join(projectDir, ".omux");
	if (existsSync(omuxDir)) {
		return omuxDir;
	}
	const legacyDir = join(projectDir, ".cliclaw");
	if (existsSync(legacyDir)) {
		return legacyDir;
	}
	return omuxDir;
}

export interface ServerRuntimeState {
	pid: number;
	host: string;
	port: number;
	url: string;
	cwd: string;
	startedAt: string;
	/** URL via mDNS (e.g. http://omux.local:3120) when advertising is enabled. */
	mdnsUrl?: string;
	/** LAN IPv4 URLs the server is reachable at. */
	lanUrls?: string[];
}

const DEFAULT_CONFIG: OmuxConfig = {
	defaultAgent: "claude-code",
	enabledAgents: ["claude-code"],
	debug: false,
	llm: {
		provider: "anthropic",
		model: "claude-sonnet-4-6",
		thinking: "off",
	},
	context: {
		// contextWindowLimit intentionally omitted: ContextManager derives it from the model id
		// (per-model lookup → 500k fallback). Users can still set it explicitly to override.
		compressionThreshold: 0.7,
	},
	stateDetector: {
		pollIntervalMs: 2000,
		stableThresholdMs: 10000,
		captureLines: 50,
	},
	tmux: {
		sessionPrefix: "omux",
	},
	memory: {
		embeddingProvider: "auto",
		chunkTokens: 400,
		chunkOverlap: 50,
		vectorWeight: 0.7,
		minScore: 0.1,
		topK: 10,
		decayHalfLifeDays: 30,
		flushThreshold: 0.6,
		toolResultRetention: 20,
		autoTidy: {
			enabled: false,
			time: "23:30",
		},
	},
	skills: {
		disabled: [],
		trustedWorkspaceDirs: [],
	},
	learning: {
		enabled: false,
	},
	autoContinue: {
		enabled: false,
		maxConsecutive: 10,
	},
	mdns: {
		enabled: true,
		name: "omux",
	},
};

export function getConfigDir(): string {
	return omuxHome();
}

export function getConfigFilePath(): string {
	return join(omuxHome(), "config.json");
}

export function getServerStateFilePath(): string {
	return join(omuxHome(), "server-state.json");
}

export async function ensureConfigDir(): Promise<void> {
	await mkdir(omuxHome(), { recursive: true });
}

export async function loadConfig(): Promise<OmuxConfig> {
	const configFile = getConfigFilePath();
	if (!existsSync(configFile)) {
		return { ...DEFAULT_CONFIG };
	}

	try {
		const raw = await readFile(configFile, "utf-8");
		const userConfig = JSON.parse(raw);

		// Deep merge with defaults
		const merged: OmuxConfig = {
			...DEFAULT_CONFIG,
			...userConfig,
			llm: { ...DEFAULT_CONFIG.llm, ...userConfig.llm },
			context: { ...DEFAULT_CONFIG.context, ...userConfig.context },
			stateDetector: { ...DEFAULT_CONFIG.stateDetector, ...userConfig.stateDetector },
			tmux: { ...DEFAULT_CONFIG.tmux, ...userConfig.tmux },
			memory: {
				...DEFAULT_CONFIG.memory,
				...userConfig.memory,
				autoTidy: { ...DEFAULT_CONFIG.memory.autoTidy, ...userConfig.memory?.autoTidy },
			},
			skills: { ...DEFAULT_CONFIG.skills, ...userConfig.skills },
			learning: { ...DEFAULT_CONFIG.learning, ...userConfig.learning },
			autoContinue: { ...DEFAULT_CONFIG.autoContinue, ...userConfig.autoContinue },
			mdns: { ...DEFAULT_CONFIG.mdns, ...userConfig.mdns },
			mcpServers: userConfig.mcpServers,
		};
		normalizeAgents(merged, Array.isArray(userConfig.enabledAgents));
		return merged;
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

/**
 * Reconcile `defaultAgent` and `enabledAgents` into a consistent, valid state.
 * Backward-compat: a config that predates `enabledAgents` derives it from `defaultAgent`.
 * Mutates `config` in place.
 */
export function normalizeAgents(config: OmuxConfig, userProvidedEnabled: boolean): void {
	const known = new Set<string>(KNOWN_AGENTS);

	// Legacy configs (only `defaultAgent`) → the active set is just that one adapter.
	if (!userProvidedEnabled || !Array.isArray(config.enabledAgents) || config.enabledAgents.length === 0) {
		config.enabledAgents = [config.defaultAgent];
	}

	// Keep only adapters we know how to launch, de-duplicated and order-preserving.
	config.enabledAgents = [...new Set(config.enabledAgents.filter((a) => known.has(a)))];
	if (config.enabledAgents.length === 0) {
		config.enabledAgents = ["claude-code"];
	}

	// The default must be one of the active adapters.
	if (!config.enabledAgents.includes(config.defaultAgent)) {
		config.defaultAgent = config.enabledAgents[0];
	}
}

export async function saveConfig(config: OmuxConfig): Promise<void> {
	await ensureConfigDir();
	await writeFile(getConfigFilePath(), JSON.stringify(config, null, "\t"), "utf-8");
}

export async function loadServerRuntimeState(): Promise<ServerRuntimeState | null> {
	const stateFile = getServerStateFilePath();
	if (!existsSync(stateFile)) {
		return null;
	}

	try {
		const raw = await readFile(stateFile, "utf-8");
		const parsed = JSON.parse(raw) as Partial<ServerRuntimeState>;
		if (
			typeof parsed.pid !== "number" ||
			typeof parsed.host !== "string" ||
			typeof parsed.port !== "number" ||
			typeof parsed.url !== "string" ||
			typeof parsed.cwd !== "string" ||
			typeof parsed.startedAt !== "string"
		) {
			return null;
		}
		return {
			pid: parsed.pid,
			host: parsed.host,
			port: parsed.port,
			url: parsed.url,
			cwd: parsed.cwd,
			startedAt: parsed.startedAt,
			mdnsUrl: typeof parsed.mdnsUrl === "string" ? parsed.mdnsUrl : undefined,
			lanUrls: Array.isArray(parsed.lanUrls)
				? parsed.lanUrls.filter((u): u is string => typeof u === "string")
				: undefined,
		};
	} catch {
		return null;
	}
}

export async function saveServerRuntimeState(state: ServerRuntimeState): Promise<void> {
	await ensureConfigDir();
	await writeFile(getServerStateFilePath(), JSON.stringify(state, null, "\t"), "utf-8");
}

export async function clearServerRuntimeState(): Promise<void> {
	try {
		await unlink(getServerStateFilePath());
	} catch (err: any) {
		if (err?.code !== "ENOENT") {
			throw err;
		}
	}
}

export async function getAgentRunsDir(): Promise<string> {
	const dir = join(omuxHome(), "sessions");
	await mkdir(dir, { recursive: true });
	return dir;
}

export async function getLogsDir(): Promise<string> {
	const dir = join(omuxHome(), "logs");
	await mkdir(dir, { recursive: true });
	return dir;
}

/**
 * Get the global storage directory (memory files live here).
 * Layout: ~/.omux/ (storageDir) → ~/.omux/memory/*.md
 */
export function getGlobalStorageDir(): string {
	return omuxHome();
}

/**
 * Get the global SQLite database path.
 *
 * Resolution: `<home>/omux.db` if it exists; otherwise an existing legacy
 * cliclaw database (`memory.sqlite`, the filename all cliclaw releases used,
 * or `cliclaw.db`) is reused so upgraded installs keep their data; otherwise
 * `<home>/omux.db` (created on first open).
 */
export function getGlobalDbPath(): string {
	const home = omuxHome();
	const dbPath = join(home, "omux.db");
	if (existsSync(dbPath)) {
		return dbPath;
	}
	for (const legacyName of ["memory.sqlite", "cliclaw.db"]) {
		const legacyPath = join(home, legacyName);
		if (existsSync(legacyPath)) {
			return legacyPath;
		}
	}
	return dbPath;
}

/**
 * Ensure the global storage directory and memory subdirectory exist.
 */
export async function ensureGlobalStorageDir(): Promise<string> {
	const dir = getGlobalStorageDir();
	await mkdir(join(dir, "memory"), { recursive: true });
	return dir;
}
