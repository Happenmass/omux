import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface LLMConfig {
	provider: string;
	model: string;
	apiKey?: string;
	baseUrl?: string;
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
}

export interface SkillsConfig {
	/** Skill names to disable (won't be loaded even if discovered) */
	disabled: string[];
}

export interface ContextConfig {
	/** Context window size in tokens. Should match the model's actual context limit. Default 500000. */
	contextWindowLimit: number;
	/** Compression threshold ratio (0-1). Conversation is compressed when usage exceeds this ratio. Default 0.7. */
	compressionThreshold: number;
}

export interface CliclawConfig {
	defaultAgent: string;
	debug: boolean;
	llm: LLMConfig;
	providers?: ProviderKeyConfig;
	context: ContextConfig;
	stateDetector: StateDetectorConfig;
	tmux: TmuxConfig;
	memory: MemoryConfig;
	skills: SkillsConfig;
}

const CONFIG_DIR = join(homedir(), ".cliclaw");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const SERVER_STATE_FILE = join(CONFIG_DIR, "server-state.json");

export interface ServerRuntimeState {
	pid: number;
	host: string;
	port: number;
	url: string;
	cwd: string;
	startedAt: string;
}

const DEFAULT_CONFIG: CliclawConfig = {
	defaultAgent: "claude-code",
	debug: false,
	llm: {
		provider: "anthropic",
		model: "claude-sonnet-4-6",
	},
	context: {
		contextWindowLimit: 500000,
		compressionThreshold: 0.7,
	},
	stateDetector: {
		pollIntervalMs: 2000,
		stableThresholdMs: 10000,
		captureLines: 50,
	},
	tmux: {
		sessionPrefix: "cliclaw",
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
	},
	skills: {
		disabled: [],
	},
};

export function getConfigDir(): string {
	return CONFIG_DIR;
}

export function getConfigFilePath(): string {
	return CONFIG_FILE;
}

export function getServerStateFilePath(): string {
	return SERVER_STATE_FILE;
}

export async function ensureConfigDir(): Promise<void> {
	await mkdir(CONFIG_DIR, { recursive: true });
}

export async function loadConfig(): Promise<CliclawConfig> {
	if (!existsSync(CONFIG_FILE)) {
		return { ...DEFAULT_CONFIG };
	}

	try {
		const raw = await readFile(CONFIG_FILE, "utf-8");
		const userConfig = JSON.parse(raw);

		// Deep merge with defaults
		return {
			...DEFAULT_CONFIG,
			...userConfig,
			llm: { ...DEFAULT_CONFIG.llm, ...userConfig.llm },
			context: { ...DEFAULT_CONFIG.context, ...userConfig.context },
			stateDetector: { ...DEFAULT_CONFIG.stateDetector, ...userConfig.stateDetector },
			tmux: { ...DEFAULT_CONFIG.tmux, ...userConfig.tmux },
			memory: { ...DEFAULT_CONFIG.memory, ...userConfig.memory },
			skills: { ...DEFAULT_CONFIG.skills, ...userConfig.skills },
		};
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

export async function saveConfig(config: CliclawConfig): Promise<void> {
	await ensureConfigDir();
	await writeFile(CONFIG_FILE, JSON.stringify(config, null, "\t"), "utf-8");
}

export async function loadServerRuntimeState(): Promise<ServerRuntimeState | null> {
	if (!existsSync(SERVER_STATE_FILE)) {
		return null;
	}

	try {
		const raw = await readFile(SERVER_STATE_FILE, "utf-8");
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
		};
	} catch {
		return null;
	}
}

export async function saveServerRuntimeState(state: ServerRuntimeState): Promise<void> {
	await ensureConfigDir();
	await writeFile(SERVER_STATE_FILE, JSON.stringify(state, null, "\t"), "utf-8");
}

export async function clearServerRuntimeState(): Promise<void> {
	try {
		await unlink(SERVER_STATE_FILE);
	} catch (err: any) {
		if (err?.code !== "ENOENT") {
			throw err;
		}
	}
}

export async function getAgentRunsDir(): Promise<string> {
	const dir = join(CONFIG_DIR, "sessions");
	await mkdir(dir, { recursive: true });
	return dir;
}

export async function getLogsDir(): Promise<string> {
	const dir = join(CONFIG_DIR, "logs");
	await mkdir(dir, { recursive: true });
	return dir;
}

/**
 * Get the global storage directory (memory files live here).
 * Layout: ~/.cliclaw/ (storageDir) → ~/.cliclaw/memory/*.md
 */
export function getGlobalStorageDir(): string {
	return CONFIG_DIR;
}

/**
 * Get the global SQLite database path.
 */
export function getGlobalDbPath(): string {
	return join(CONFIG_DIR, "memory.sqlite");
}

/**
 * Ensure the global storage directory and memory subdirectory exist.
 */
export async function ensureGlobalStorageDir(): Promise<string> {
	const dir = getGlobalStorageDir();
	await mkdir(join(dir, "memory"), { recursive: true });
	return dir;
}
