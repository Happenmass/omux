#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import chalk from "chalk";
import type { AgentAdapter } from "./agents/adapter.js";
import { ClaudeCodeAdapter } from "./agents/claude-code.js";
import { CodexAdapter } from "./agents/codex.js";
import { parseCliArgs, printHelp, printVersion, VERSION } from "./cli.js";
import { ChangeTracker } from "./core/change-tracker.js";
import { ContextManager } from "./core/context-manager.js";
import { LearningChat } from "./core/learning-chat.js";
import { LearningPipeline } from "./core/learning-pipeline.js";
import { LearningStore } from "./core/learning-store.js";
import { LearningSummarizer } from "./core/learning-summarizer.js";
import { MainAgent } from "./core/main-agent.js";
import { PromptTracker } from "./core/prompt-tracker.js";
import { runDoctor } from "./doctor/run.js";
import { LLMClient } from "./llm/client.js";
import { PromptLoader } from "./llm/prompt-loader.js";
import { getAllProviders } from "./llm/providers/registry.js";
import { createEmbeddingProvider } from "./memory/embedder.js";
import { loadPersistentMemory } from "./memory/persistent.js";
import { MemoryStore } from "./memory/store.js";
import { syncMemoryFiles } from "./memory/sync.js";
import { AgentStore } from "./persistence/agent-store.js";
import { ConversationStore } from "./persistence/conversation-store.js";
import { AUTH_QUERY_PARAM } from "./server/auth.js";
import { ChatBroadcaster } from "./server/chat-broadcaster.js";
import { CommandRegistry } from "./server/command-registry.js";
import { startServer } from "./server/index.js";
import { getLanIPv4, isValidMdnsName, type MdnsSupervisor, startMdnsSupervisor } from "./server/mdns.js";
import { t } from "./server/messages.js";
import { UiEventStore } from "./server/ui-events.js";
import { discoverSkills } from "./skills/discovery.js";
import { filterSkills } from "./skills/filter.js";
import { type AdapterCapabilityInput, buildAgentCapabilitiesSection } from "./skills/injector.js";
import { SkillRegistry } from "./skills/registry.js";
import { TmuxBridge } from "./tmux/bridge.js";
import { StateDetector } from "./tmux/state-detector.js";
import { runConfigTUI } from "./tui/config-app.js";
import {
	clearServerRuntimeState,
	ensureConfigDir,
	ensureGlobalStorageDir,
	getConfigDir,
	getGlobalDbPath,
	getLogsDir,
	KNOWN_AGENTS,
	loadConfig,
	loadServerRuntimeState,
	projectDotDir,
	type ServerRuntimeState,
	saveServerRuntimeState,
} from "./utils/config.js";
import { resolveLocale } from "./utils/locale.js";
import { logger } from "./utils/logger.js";
import { buildMcpServersSummary, cleanupAllMcpConfigFiles } from "./utils/mcp-config.js";

function createMemorySyncRunner(params: {
	memoryStore: MemoryStore;
	embeddingProvider: Awaited<ReturnType<typeof createEmbeddingProvider>>["provider"];
	config: Awaited<ReturnType<typeof loadConfig>>;
}): () => Promise<void> {
	let inFlight: Promise<void> | null = null;

	return async () => {
		if (!params.memoryStore.isDirty()) return;
		if (inFlight) {
			await inFlight;
			return;
		}

		inFlight = (async () => {
			if (!params.memoryStore.isDirty()) return;
			const syncResult = await syncMemoryFiles(params.memoryStore, {
				chunking: {
					tokens: params.config.memory.chunkTokens,
					overlap: params.config.memory.chunkOverlap,
				},
				embeddingProvider: params.embeddingProvider,
				cache: params.embeddingProvider
					? {
							provider: params.embeddingProvider.id,
							model: params.embeddingProvider.model,
							providerKey: "default",
						}
					: undefined,
			});

			if (syncResult.added + syncResult.updated + syncResult.deleted > 0) {
				logger.info(
					"main",
					`Memory sync: +${syncResult.added} ~${syncResult.updated} -${syncResult.deleted} (${syncResult.chunksIndexed} chunks)`,
				);
			}
		})();

		try {
			await inFlight;
		} finally {
			inFlight = null;
		}
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessRunning(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) {
		return false;
	}

	try {
		process.kill(pid, 0);
		return true;
	} catch (err: any) {
		if (err?.code === "EPERM") {
			// Process exists but we do not have permission to signal it.
			return true;
		}
		return false;
	}
}

function isPortInUse(host: string, port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = createConnection({ host, port });
		socket.once("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.once("error", () => {
			socket.destroy();
			resolve(false);
		});
		socket.setTimeout(1000, () => {
			socket.destroy();
			resolve(false);
		});
	});
}

async function waitForPortRelease(host: string, port: number, timeoutMs = 3000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!(await isPortInUse(host, port))) {
			return true;
		}
		await sleep(200);
	}
	return false;
}

function findPidOnPort(port: number): Promise<number | null> {
	return new Promise((resolve) => {
		execFile("lsof", ["-ti", `:${port}`], (err, stdout) => {
			if (err || !stdout.trim()) {
				resolve(null);
				return;
			}
			const pid = Number.parseInt(stdout.trim().split("\n")[0], 10);
			resolve(Number.isNaN(pid) ? null : pid);
		});
	});
}

async function killByPort(port: number): Promise<boolean> {
	const pid = await findPidOnPort(port);
	if (!pid) return false;
	try {
		process.kill(pid, "SIGTERM");
	} catch {
		return false;
	}
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		if (!isProcessRunning(pid)) return true;
		await sleep(200);
	}
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		/* ignore */
	}
	await sleep(300);
	return !isProcessRunning(pid);
}

async function getActiveServerState(): Promise<ServerRuntimeState | null> {
	const state = await loadServerRuntimeState();
	if (!state) {
		return null;
	}

	if (!isProcessRunning(state.pid)) {
		await clearServerRuntimeState();
		return null;
	}

	return state;
}

function createAdapter(agentName: string): AgentAdapter {
	switch (agentName) {
		case "codex":
			return new CodexAdapter();
		default:
			return new ClaudeCodeAdapter();
	}
}

/** Instantiate one adapter per enabled name, preserving order. */
function buildAdapterMap(enabledNames: string[]): Map<string, AgentAdapter> {
	const adapters = new Map<string, AgentAdapter>();
	for (const name of enabledNames) {
		if (!adapters.has(name)) {
			adapters.set(name, createAdapter(name));
		}
	}
	return adapters;
}

/** Raw capabilities markdown for an adapter (prompts/adapters/<name>.md), or "" if none. */
function loadAdapterCapabilityText(adapter: AgentAdapter, promptLoader: PromptLoader): string {
	const capFile = adapter.getCapabilitiesFile?.();
	if (!capFile) return "";
	return promptLoader.loadAdapterCapabilities(capFile.replace(/^adapters\//, "").replace(/\.md$/, ""));
}

/** Build the ordered capability inputs for the {{agent_capabilities}} section. */
function buildAdapterCapabilityInputs(
	adapters: Map<string, AgentAdapter>,
	defaultName: string,
	promptLoader: PromptLoader,
): AdapterCapabilityInput[] {
	const inputs: AdapterCapabilityInput[] = [];
	for (const [name, adapter] of adapters) {
		inputs.push({
			name,
			displayName: adapter.displayName,
			capabilities: loadAdapterCapabilityText(adapter, promptLoader),
			isDefault: name === defaultName,
		});
	}
	return inputs;
}

function buildDaemonChildArgs(args: ReturnType<typeof parseCliArgs>): string[] {
	const childArgs = [
		"--max-old-space-size=8192",
		process.argv[1],
		"serve",
		"--host",
		args.host,
		"--port",
		String(args.port),
		"--cwd",
		args.cwd,
	];

	if (args.agent) {
		childArgs.push("--agent", args.agent);
	}

	if (args.provider) {
		childArgs.push("--provider", args.provider);
	}
	if (args.model) {
		childArgs.push("--model", args.model);
	}
	if (args.baseUrl) {
		childArgs.push("--base-url", args.baseUrl);
	}
	if (args.contextWindow) {
		childArgs.push("--context-window", String(args.contextWindow));
	}

	return childArgs;
}

function printAccessUrls(state: ServerRuntimeState): void {
	// Append the one-time pairing token so a remote device can pair straight from this
	// banner. Loopback pairs implicitly, so only the LAN URLs need it.
	const withToken = (url: string) => (state.token ? `${url}/?${AUTH_QUERY_PARAM}=${state.token}` : url);
	if (state.mdnsUrl) {
		console.log(`${chalk.dim("LAN URL:  ")}${chalk.cyan(withToken(state.mdnsUrl))}`);
	}
	if (state.lanUrls && state.lanUrls.length > 0) {
		console.log(`${chalk.dim("Also at:  ")}${state.lanUrls.map(withToken).join(", ")}`);
	}
}

async function waitForServerState(pid: number, timeoutMs = 10000): Promise<ServerRuntimeState | null> {
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		const state = await loadServerRuntimeState();
		if (state && state.pid === pid) {
			return state;
		}
		if (!isProcessRunning(pid)) {
			return null;
		}
		await sleep(200);
	}

	return null;
}

async function handleStartCommand(args: ReturnType<typeof parseCliArgs>): Promise<void> {
	await ensureConfigDir();

	const running = await getActiveServerState();
	if (running) {
		console.log(`Omux is already running: ${running.url}`);
		return;
	}

	// Check if port is already in use (e.g. by a foreground process without state file)
	if (await isPortInUse(args.host, args.port)) {
		console.error(`Port ${args.port} is already in use.`);
		console.error("Run 'omux stop' first, or use --port to specify a different port.");
		process.exit(1);
	}

	const logsDir = await getLogsDir();
	const logFile = join(logsDir, "server.log");
	const fd = openSync(logFile, "a");

	try {
		const child = spawn(process.execPath, buildDaemonChildArgs(args), {
			detached: true,
			stdio: ["ignore", fd, fd],
			env: {
				...process.env,
				OMUX_DAEMON: "1",
			},
		});

		child.unref();

		if (!child.pid) {
			console.error("Failed to launch Omux background process.");
			process.exit(1);
		}

		const state = await waitForServerState(child.pid);
		if (state) {
			console.log(`Omux started in background: ${state.url}`);
			printAccessUrls(state);
			console.log(`Log file: ${logFile}`);
			return;
		}

		// Daemon didn't write state file — check if it's actually running
		if (!isProcessRunning(child.pid)) {
			// Process already exited — show last few lines from log
			try {
				const logContent = readFileSync(logFile, "utf-8");
				const lastLines = logContent.split("\n").filter(Boolean).slice(-5).join("\n");
				if (lastLines) {
					console.error(`Failed to start Omux:\n${lastLines}`);
				} else {
					console.error(`Failed to start Omux. See logs: ${logFile}`);
				}
			} catch {
				console.error(`Failed to start Omux. See logs: ${logFile}`);
			}
			process.exit(1);
		}

		// Process is running but no state yet — give it a bit more time
		await sleep(2000);
		const retryState = await waitForServerState(child.pid, 3000);
		if (retryState) {
			console.log(`Omux started in background: ${retryState.url}`);
			printAccessUrls(retryState);
			console.log(`Log file: ${logFile}`);
			return;
		}

		const fallbackUrl = `http://${args.host}:${args.port}`;
		console.log(`Omux started in background: ${fallbackUrl}`);
		console.log(`Log file: ${logFile}`);
	} finally {
		closeSync(fd);
	}
}

async function handleStopCommand(args?: { host?: string; port?: number }): Promise<void> {
	await ensureConfigDir();

	const state = await loadServerRuntimeState();
	const host = args?.host ?? state?.host ?? "127.0.0.1";
	const port = args?.port ?? state?.port ?? 3120;

	if (!state) {
		// No state file — try port-based fallback
		if (await isPortInUse(host, port)) {
			console.log(`No state file found, but port ${port} is in use. Attempting to stop by port...`);
			if (await killByPort(port)) {
				await waitForPortRelease(host, port);
				console.log(`Stopped Omux on port ${port}.`);
			} else {
				console.error(`Failed to stop process on port ${port}. Try manually: lsof -ti :${port} | xargs kill`);
			}
		} else {
			console.log("Omux is not running.");
		}
		return;
	}

	if (!isProcessRunning(state.pid)) {
		await clearServerRuntimeState();
		// Also check port in case a different process is holding it
		if (await isPortInUse(host, port)) {
			console.log(`Stale state cleared, but port ${port} is still in use. Attempting cleanup...`);
			await killByPort(port);
			await waitForPortRelease(host, port);
		} else {
			console.log("Omux is not running (cleared stale state).");
		}
		return;
	}

	// Preserve omux-* (and legacy cliclaw-*) tmux sessions — they will be rediscovered on next startup.

	try {
		process.kill(state.pid, "SIGTERM");
	} catch (err: any) {
		if (err?.code === "ESRCH") {
			await clearServerRuntimeState();
			console.log("Omux is not running (cleared stale state).");
			return;
		}
		throw err;
	}

	const deadline = Date.now() + 8000;
	while (Date.now() < deadline) {
		if (!isProcessRunning(state.pid)) {
			await clearServerRuntimeState();
			// Wait for port release to avoid EADDRINUSE on immediate restart
			await waitForPortRelease(host, port);
			console.log(`Stopped Omux: ${state.url}`);
			return;
		}
		await sleep(200);
	}

	try {
		process.kill(state.pid, "SIGKILL");
	} catch (err: any) {
		if (err?.code !== "ESRCH") {
			throw err;
		}
	}

	await clearServerRuntimeState();
	await waitForPortRelease(host, port);
	console.log(`Stopped Omux (forced): ${state.url}`);
}

async function main(): Promise<void> {
	const args = parseCliArgs();

	if (args.help) {
		printHelp();
		process.exit(0);
	}

	if (args.version) {
		printVersion();
		process.exit(0);
	}

	if (args.subcommand === "config") {
		await runConfigTUI();
		process.exit(0);
	}

	if (args.subcommand === "doctor") {
		await runDoctor();
		return;
	}

	if (args.subcommand === "start") {
		await handleStartCommand(args);
		return;
	}

	if (args.subcommand === "stop") {
		await handleStopCommand({ host: args.host, port: args.port });
		return;
	}

	if (args.subcommand === "restart") {
		await handleStopCommand({ host: args.host, port: args.port });
		await handleStartCommand(args);
		return;
	}

	if (args.listProviders) {
		console.log("Available LLM providers:\n");
		for (const p of getAllProviders()) {
			const envHint = process.env[p.apiKeyEnvVar] ? chalk.green("(key set)") : chalk.dim(`(${p.apiKeyEnvVar})`);
			console.log(`  ${chalk.bold(p.name.padEnd(15))} ${p.displayName.padEnd(20)} ${envHint}`);
			if (p.models?.length) {
				console.log(`  ${"".padEnd(15)} ${chalk.dim(`Models: ${p.models.join(", ")}`)}`);
			}
		}
		process.exit(0);
	}

	// Handle "remember" subcommand
	if (args.rememberText !== undefined) {
		if (args.rememberText) {
			const { appendToPersistentMemory } = await import("./memory/persistent.js");
			const targetPath = args.global
				? join(getConfigDir(), "MEMORY.md")
				: join(projectDotDir(args.cwd), "MEMORY.md");
			await appendToPersistentMemory(targetPath, "active_notes", args.rememberText);
			const scope = args.global ? "global" : "project";
			console.log(`${chalk.green("Remembered")} (${scope}): ${args.rememberText}`);
		} else {
			console.error(chalk.yellow("Please provide text to remember."));
			console.error('Usage: omux remember "your note here"');
			console.error("  --global/-g  Save to global memory instead of project memory");
			process.exit(1);
		}
		process.exit(0);
	}

	// Handle "init" subcommand
	if (args.isInit) {
		const { mkdir, writeFile, access } = await import("node:fs/promises");
		// Reuses an existing legacy cliclaw `.cliclaw/` dir; creates `.omux/` otherwise.
		const omuxDir = projectDotDir(args.cwd);
		const dirs = [join(omuxDir, "skills"), join(omuxDir, "prompts")];
		let created = 0;
		for (const dir of dirs) {
			await mkdir(dir, { recursive: true });
			const gitkeep = join(dir, ".gitkeep");
			try {
				await access(gitkeep);
			} catch {
				await writeFile(gitkeep, "", "utf-8");
				created++;
			}
		}
		if (created > 0) {
			console.log(chalk.green("Initialized Omux project directories:"));
		} else {
			console.log(chalk.dim("Omux project directories already exist:"));
		}
		console.log(`  ${omuxDir}/skills/`);
		console.log(`  ${omuxDir}/prompts/`);
		process.exit(0);
	}

	// ─── Default: Start Server ──────────────────────────
	const isDaemonProcess = process.env.OMUX_DAEMON === "1";

	await ensureConfigDir();
	await logger.init();

	// Check for existing daemon before starting
	if (!isDaemonProcess) {
		const existingDaemon = await getActiveServerState();
		if (existingDaemon) {
			console.error(`Omux is already running as a daemon: ${existingDaemon.url}`);
			console.error("Run 'omux stop' first, or use 'omux restart'.");
			process.exit(1);
		}
		if (await isPortInUse(args.host, args.port)) {
			console.error(`Port ${args.port} is already in use.`);
			console.error("Run 'omux stop' first, or use --port to specify a different port.");
			process.exit(1);
		}
	}

	const config = await loadConfig();

	// Resolve locale from config or system environment
	const locale = resolveLocale(config.locale);

	// Resolve active adapters. --agent (when it names a known adapter) overrides which adapter
	// is the default executor, and activates it if it wasn't already in the enabled set.
	const requestedDefault =
		args.agent && (KNOWN_AGENTS as readonly string[]).includes(args.agent) ? args.agent : config.defaultAgent;
	const enabledAgents = [...config.enabledAgents];
	if (!enabledAgents.includes(requestedDefault)) {
		enabledAgents.unshift(requestedDefault);
	}
	const defaultAgentName = requestedDefault;

	console.log(`${chalk.bold("Omux")} v${VERSION}\n`);

	// Check prerequisites
	const bridge = new TmuxBridge();
	const tmuxInstalled = await bridge.checkInstalled();
	if (!tmuxInstalled) {
		console.error(chalk.red("Error: tmux is not installed. Please install tmux first."));
		console.error("  macOS: brew install tmux");
		console.error("  Ubuntu: sudo apt install tmux");
		process.exit(1);
	}

	const tmuxVersion = await bridge.getVersion();
	logger.info("main", `tmux version: ${tmuxVersion}`);

	// Initialize LLM client
	const llmProvider = args.provider || config.llm.provider;
	const llmModel = args.model || config.llm.model;
	const llmBaseUrl = args.baseUrl || config.llm.baseUrl;
	const llmApiKey = config.providers?.[llmProvider]?.apiKey || config.llm.apiKey;

	const llmClient = new LLMClient({
		provider: llmProvider,
		model: llmModel,
		apiKey: llmApiKey,
		baseUrl: llmBaseUrl,
		proxy: config.llm.proxy,
	});

	// Initialize PromptLoader
	const promptLoader = new PromptLoader(undefined, locale);
	await promptLoader.load(args.cwd);

	// Initialize global storage directory (~/.omux/memory/)
	const storageDir = await ensureGlobalStorageDir();

	logger.info("main", `Memory: ${storageDir}/memory/`);

	// Initialize MemoryStore + Embedding Provider (global DB)
	const memoryStore = new MemoryStore({
		dbPath: getGlobalDbPath(),
		workspaceDir: args.cwd,
		storageDir,
		vectorEnabled: true,
	});

	let embeddingProvider: Awaited<ReturnType<typeof createEmbeddingProvider>>["provider"] = null;

	if (config.memory.embeddingProvider !== "none") {
		const embeddingResult = await createEmbeddingProvider({
			provider: (config.memory.embeddingProvider ?? "auto") as any,
			fallback: "none",
			model: config.memory.embeddingModel,
		});
		embeddingProvider = embeddingResult.provider;
	}
	if (embeddingProvider) {
		logger.info("main", `Embedding provider: ${embeddingProvider.id} (${embeddingProvider.model})`);
		if (embeddingProvider.warmup) {
			await embeddingProvider.warmup();
		}
	} else {
		logger.info("main", "No embedding provider available — FTS-only mode");
	}

	// Initial memory index sync
	try {
		const syncResult = await syncMemoryFiles(memoryStore, {
			chunking: {
				tokens: config.memory.chunkTokens,
				overlap: config.memory.chunkOverlap,
			},
			embeddingProvider,
			cache: embeddingProvider
				? { provider: embeddingProvider.id, model: embeddingProvider.model, providerKey: "default" }
				: undefined,
		});
		if (syncResult.added + syncResult.updated + syncResult.deleted > 0) {
			logger.info(
				"main",
				`Memory sync: +${syncResult.added} ~${syncResult.updated} -${syncResult.deleted} (${syncResult.chunksIndexed} chunks)`,
			);
		}
	} catch (err: any) {
		logger.warn("main", `Memory sync failed (non-fatal): ${err.message}`);
	}

	const syncMemory = createMemorySyncRunner({
		memoryStore,
		embeddingProvider,
		config,
	});

	const agentLabel = enabledAgents.map((name) => (name === defaultAgentName ? `${name} (default)` : name)).join(", ");
	console.log(chalk.dim("Agents:   ") + agentLabel);
	console.log(`${chalk.dim("Provider: ")}${llmProvider} (${llmClient.getModel()})`);
	console.log(`${chalk.dim("Host:     ")}${args.host}`);
	console.log(`${chalk.dim("Port:     ")}${args.port}`);
	console.log();

	// Initialize components
	const stateDetector = new StateDetector(bridge, llmClient, config.stateDetector, promptLoader);

	// Setup agent adapters: one instance per enabled adapter; defaultAdapter handles
	// skills discovery and create_agent calls that omit `adapter`.
	const adapters = buildAdapterMap(enabledAgents);
	const defaultAdapter = adapters.get(defaultAgentName) ?? createAdapter(defaultAgentName);

	// Initialize ConversationStore and AgentStore (reuse global DB)
	const conversationStore = new ConversationStore(memoryStore.getDb());
	const agentStore = new AgentStore(memoryStore.getDb());

	// Initialize ChatBroadcaster
	const broadcaster = new ChatBroadcaster();
	const uiEventStore = new UiEventStore({ db: memoryStore.getDb() });

	// Initialize Learning components (only when enabled via config)
	let learningStore: LearningStore | undefined;
	let changeTracker: ChangeTracker | undefined;
	let promptTracker: PromptTracker | undefined;
	let learningPipeline: LearningPipeline | undefined;
	let learningChat: LearningChat | undefined;

	if (config.learning.enabled) {
		const learningDiffDir = join(getConfigDir(), "learning", "diffs");
		learningStore = new LearningStore(memoryStore.getDb(), learningDiffDir);
		changeTracker = new ChangeTracker();
		promptTracker = new PromptTracker();
		const learningSummarizer = new LearningSummarizer(llmClient, promptLoader, locale);
		learningPipeline = new LearningPipeline({
			store: learningStore,
			tracker: changeTracker,
			summarizer: learningSummarizer,
			memoryStore,
			broadcaster,
			promptLoader,
		});
		learningChat = new LearningChat({
			store: learningStore,
			broadcaster,
			llm: llmClient,
			promptLoader,
			locale,
		});
		logger.info("main", "Learning Sessions enabled");
	} else {
		logger.info("main", "Learning Sessions disabled (enable via `omux config`)");
	}

	// Global persistent memory dir (~/.omux) — captured once and reused by the reloader
	// so that /clear, /compact, and /reset can refresh {{memory}} from disk without rebuilding
	// the path each time.
	const globalDir = getConfigDir();
	const reloadGlobalMemory = async (): Promise<string | null> => {
		try {
			return await loadPersistentMemory(globalDir);
		} catch (err: any) {
			logger.warn("main", `Persistent memory reload failed (non-fatal): ${err.message}`);
			return null;
		}
	};

	// Initialize ContextManager with conversation persistence
	const contextManager = new ContextManager({
		llmClient,
		promptLoader,
		memoryStore,
		syncMemory,
		memoryReloader: reloadGlobalMemory,
		// Explicit override (CLI flag or config); when unset, ContextManager derives the window
		// from the model id via KNOWN_CONTEXT_WINDOWS (→ 500k fallback with a startup warning).
		contextWindowLimit: args.contextWindow || config.context.contextWindowLimit,
		model: llmModel,
		compressionThreshold: config.context.compressionThreshold,
		flushThreshold: config.memory.flushThreshold,
		toolResultRetention: config.memory.toolResultRetention,
		conversationStore,
	});

	// Restore conversation from SQLite if any
	const existingMessageCount = conversationStore.getMessageCount();
	let restoredMessageCount = 0;
	if (existingMessageCount > 0) {
		restoredMessageCount = contextManager.restore(conversationStore);
		logger.info("main", `Restored ${restoredMessageCount} messages from SQLite`);
		console.log(chalk.dim(`Restored ${restoredMessageCount} messages from previous conversation`));
	}

	// Initialize Skill System: discover → filter → inject → registry
	const adapterSkillsDir = defaultAdapter.getSkillsDir?.();
	const discoveredSkills = await discoverSkills({
		adapterSkillsDir,
		workspaceDir: args.cwd,
		trustedWorkspaceDirs: config.skills?.trustedWorkspaceDirs,
	});
	const filteredSkills = filterSkills(discoveredSkills, { disabled: config.skills?.disabled }, args.cwd);
	const capabilityInputs = buildAdapterCapabilityInputs(adapters, defaultAgentName, promptLoader);
	const capabilitiesSummary = buildAgentCapabilitiesSection(capabilityInputs, filteredSkills);
	contextManager.updateModule("agent_capabilities", capabilitiesSummary);

	// Inject configured MCP servers list so MainAgent knows what's available
	contextManager.updateModule("available_mcp_servers", buildMcpServersSummary(config.mcpServers));

	// Load global persistent memory (~/.omux/MEMORY.md) into the {{memory}} module ONCE
	// at session start. The module is intentionally NOT hot-reloaded after `persistent_memory`
	// tool writes — keeping the system prompt byte-stable preserves prompt-cache hits across
	// turns. The module is refreshed only at explicit cache-invalidation breakpoints:
	// /clear, /compact, and /reset (see ContextManager.reloadPersistentMemory).
	// Project-level memory is fetched on demand by create_agent — see main-agent.ts.
	try {
		const persistentMemory = await reloadGlobalMemory();
		if (persistentMemory) {
			contextManager.updateModule("memory", persistentMemory);
			logger.info("main", "Global persistent memory loaded into context");
		}
	} catch (err: any) {
		logger.warn("main", `Failed to load persistent memory (non-fatal): ${err.message}`);
	}

	const skillRegistry = new SkillRegistry(filteredSkills);
	logger.info("main", `Skills loaded: ${skillRegistry.size} (${filteredSkills.map((s) => s.name).join(", ")})`);

	// Initialize MainAgent (the stop latch lives on MainAgent itself)
	const mainAgent = new MainAgent({
		contextManager,
		llmClient,
		adapters,
		defaultAdapter: defaultAgentName,
		bridge,
		stateDetector,
		broadcaster,
		uiEventStore,
		memoryStore,
		syncMemory,
		embeddingProvider,
		skillRegistry,
		agentStore,
		globalDir,
		workspaceDir: args.cwd,
		debug: config.debug,
		thinking: config.llm.thinking ?? "off",
		promptLoader,
		locale,
		autoContinue: config.autoContinue,
		searchConfig: {
			vectorWeight: config.memory.vectorWeight,
			textWeight: 1 - config.memory.vectorWeight,
			temporalDecay: {
				enabled: true,
				halfLifeDays: config.memory.decayHalfLifeDays,
			},
		},
		promptTracker,
		learningPipeline,
		changeTracker,
	});

	mainAgent.setupAgentMonitor();

	// Restore persisted agents (verify tmux is still alive, discard dead ones)
	const persistedAgents = agentStore.loadAgents();
	const restoredAgentIds = new Set<string>();
	if (persistedAgents.length > 0) {
		for (const a of persistedAgents) {
			const alive = await bridge.hasSession(a.agentId);
			if (alive) {
				mainAgent.restoreAgent(
					a.agentId,
					{ paneTarget: a.paneTarget, workingDir: a.workingDir, model: a.model, adapter: a.adapter },
					a.takenOver,
				);
				restoredAgentIds.add(a.agentId);
			} else {
				agentStore.deleteAgent(a.agentId);
				logger.info("main", `Discarded dead agent: ${a.agentId}`);
			}
		}
	}

	// Discover live omux-* (and legacy cliclaw-*) tmux sessions not already restored from AgentStore.
	// This handles agents that survived a crash or were created before persistence existed.
	try {
		const liveSessions = await bridge.listOmuxAgents();
		for (const session of liveSessions) {
			if (restoredAgentIds.has(session.name)) continue;
			// Construct a default pane target for the discovered session
			const paneTarget = `${session.name}:0.0`;
			const workingDir = args.cwd; // best-effort default
			agentStore.saveAgent(session.name, { paneTarget, workingDir });
			mainAgent.restoreAgent(session.name, { paneTarget, workingDir });
			restoredAgentIds.add(session.name);
			logger.info("main", `Discovered orphan tmux agent: ${session.name}`);
		}
	} catch {
		/* tmux listing may fail — non-fatal */
	}

	if (restoredAgentIds.size > 0) {
		logger.info("main", `Restored ${restoredAgentIds.size} agent(s)`);
		console.log(chalk.dim(`Restored ${restoredAgentIds.size} agent(s) from previous run`));
	}

	// Log state changes
	mainAgent.on("state_change", (state) => {
		logger.info("main", `Agent state: ${state}`);
	});

	mainAgent.on("log", (message) => {
		logger.info("main-agent", message);
	});

	// ─── Command Registry ───────────────────────────────

	const commandRegistry = new CommandRegistry();

	// Register skill-declared commands
	for (const skill of filteredSkills) {
		for (const cmd of skill.commands) {
			const cmdName = cmd.startsWith("/") ? cmd.slice(1) : cmd;
			commandRegistry.register({
				name: cmdName,
				description: skill.description,
				category: "skill",
				skillName: skill.name,
			});
		}
	}

	// ─── onReset callback (hot-reload prompts, skills, tools) ───

	const onReset = async () => {
		// 1. Reload prompt templates from disk
		await promptLoader.load(args.cwd);
		contextManager.reloadPromptTemplate();
		logger.info("main", "Prompt templates reloaded");

		// 2. Re-discover and filter skills
		const resetAdapterSkillsDir = defaultAdapter.getSkillsDir?.();
		const resetDiscovered = await discoverSkills({
			adapterSkillsDir: resetAdapterSkillsDir,
			workspaceDir: args.cwd,
			trustedWorkspaceDirs: config.skills?.trustedWorkspaceDirs,
		});
		const resetFiltered = filterSkills(resetDiscovered, { disabled: config.skills?.disabled }, args.cwd);

		// 3. Rebuild capabilities summary and update ContextManager modules
		const resetCapInputs = buildAdapterCapabilityInputs(adapters, defaultAgentName, promptLoader);
		const resetCapSummary = buildAgentCapabilitiesSection(resetCapInputs, resetFiltered);
		contextManager.updateModule("agent_capabilities", resetCapSummary);
		contextManager.updateModule("available_mcp_servers", buildMcpServersSummary(config.mcpServers));

		// 4. Create new SkillRegistry and update MainAgent
		const resetSkillRegistry = new SkillRegistry(resetFiltered);
		mainAgent.setSkillRegistry(resetSkillRegistry);
		logger.info(
			"main",
			`Skills reloaded: ${resetSkillRegistry.size} (${resetFiltered.map((s) => s.name).join(", ")})`,
		);

		// 5. Clear old skill commands and re-register
		commandRegistry.clearSkillCommands();
		for (const skill of resetFiltered) {
			for (const cmd of skill.commands) {
				const cmdName = cmd.startsWith("/") ? cmd.slice(1) : cmd;
				commandRegistry.register({
					name: cmdName,
					description: skill.description,
					category: "skill",
					skillName: skill.name,
				});
			}
		}

		// 6. Refresh {{memory}} module from MEMORY.md — /reset is an explicit
		//    cache-invalidation breakpoint, so it's the right time to pick up any
		//    persistent_memory writes that landed during the prior session.
		//    (ContextManager.clear() also calls reloadPersistentMemory, so this is
		//    belt-and-suspenders; keeping it here makes the reset path self-contained.)
		try {
			const refreshed = await reloadGlobalMemory();
			if (refreshed !== null) {
				contextManager.updateModule("memory", refreshed);
			}
		} catch (err: any) {
			logger.warn("main", `Persistent memory refresh on reset failed (non-fatal): ${err.message}`);
		}

		// 7. Re-sync memory index
		try {
			const syncResult = await syncMemoryFiles(memoryStore, {
				chunking: {
					tokens: config.memory.chunkTokens,
					overlap: config.memory.chunkOverlap,
				},
				embeddingProvider,
				cache: embeddingProvider
					? { provider: embeddingProvider.id, model: embeddingProvider.model, providerKey: "default" }
					: undefined,
			});
			if (syncResult.added + syncResult.updated + syncResult.deleted > 0) {
				logger.info(
					"main",
					`Memory re-sync: +${syncResult.added} ~${syncResult.updated} -${syncResult.deleted} (${syncResult.chunksIndexed} chunks)`,
				);
			}
		} catch (err: any) {
			logger.warn("main", `Memory re-sync failed (non-fatal): ${err.message}`);
		}
	};

	// ─── Start Server ───────────────────────────────────

	// mDNS advertising decision — computed here so the Host/Origin allowlist and pairing URLs
	// can include the LAN IPs and `<name>.local` even though the supervisor starts below.
	const mdnsEnabled = args.mdns ?? config.mdns.enabled;
	const mdnsName = args.mdnsName ?? config.mdns.name;
	const advertisesMdns =
		mdnsEnabled && isValidMdnsName(mdnsName) && args.host !== "127.0.0.1" && args.host !== "localhost";
	const lanIps = getLanIPv4();

	const serverInstance = await startServer({
		host: args.host,
		port: args.port,
		mainAgent,
		contextManager,
		conversationStore,
		broadcaster,
		bridge,
		commandRegistry,
		uiEventStore,
		onReset,
		llmClient,
		promptLoader,
		memoryStore,
		syncMemory,
		learningStore,
		learningPipeline,
		learningChat,
		learningEnabled: config.learning.enabled,
		locale,
		autoTidy: config.memory.autoTidy,
		lanIps,
		mdnsName: advertisesMdns ? mdnsName : undefined,
	});

	// ─── Start mDNS / Bonjour advertising ───────────────
	const startedAt = new Date().toISOString();
	let mdnsSupervisor: MdnsSupervisor | null = null;
	let mdnsUrl: string | undefined;
	let lanUrls: string[] = [];

	// Persist runtime state so `omux stop` and the startup banner can find us;
	// re-called whenever the mDNS supervisor re-publishes after a network change.
	const persistRuntimeState = () =>
		saveServerRuntimeState({
			pid: process.pid,
			host: args.host,
			port: serverInstance.port,
			url: `http://${args.host}:${serverInstance.port}`,
			cwd: args.cwd,
			startedAt,
			mdnsUrl,
			lanUrls,
			token: serverInstance.authToken,
		});

	if (mdnsEnabled) {
		if (!isValidMdnsName(mdnsName)) {
			logger.warn("main", `Invalid mDNS name "${mdnsName}", skipping advertisement`);
		} else if (args.host === "127.0.0.1" || args.host === "localhost") {
			logger.warn("main", "mDNS skipped: server is bound to localhost only");
		} else {
			try {
				let firstPublish = true;
				mdnsSupervisor = startMdnsSupervisor({
					name: mdnsName,
					port: serverInstance.port,
					log: (msg) => logger.info("main", msg),
					// Fires on initial publish and on every IP-change / manual rebind.
					onRebind: (handle) => {
						mdnsUrl = `http://${handle.hostname}:${serverInstance.port}`;
						lanUrls = handle.ips.map((ip) => `http://${ip}:${serverInstance.port}`);
						void persistRuntimeState();
						if (firstPublish) {
							firstPublish = false;
							console.log(`${chalk.dim("LAN URL:  ")}${chalk.cyan(mdnsUrl)}`);
							if (lanUrls.length > 0) {
								console.log(`${chalk.dim("Also at:  ")}${lanUrls.join(", ")}`);
							}
						} else {
							// Network changed under us — tell connected clients the address moved.
							broadcaster.broadcast({
								type: "system",
								message: t("mdns_rebroadcast", locale, { url: mdnsUrl }),
							});
						}
					},
				});
			} catch (err: any) {
				logger.warn("main", `mDNS advertising failed (non-fatal): ${err?.message ?? err}`);
			}
		}
	}

	// Notify connected clients about restored conversation
	if (restoredMessageCount > 0) {
		// Delay slightly to let WebSocket clients connect first
		setTimeout(() => {
			broadcaster.broadcast({
				type: "system",
				message: t("restored_messages", locale, { count: restoredMessageCount }),
			});
		}, 500);
	}

	// Save runtime state for both daemon and foreground modes so `stop` can find us.
	// (The mDNS supervisor re-persists this on every re-publish via persistRuntimeState.)
	await persistRuntimeState();

	// ─── Graceful Shutdown ──────────────────────────────

	let shutdownInProgress = false;

	const shutdown = async () => {
		if (shutdownInProgress) return;
		shutdownInProgress = true;

		console.log(chalk.yellow("\nShutting down..."));

		mainAgent.shutdownMonitor();

		// Stop MainAgent if executing
		if (mainAgent.state === "executing") {
			mainAgent.requestStop();
			// Give the loop a moment to exit cleanly
			await new Promise((resolve) => setTimeout(resolve, 500));
		}

		// Preserve omux-* (and legacy cliclaw-*) tmux sessions across shutdown/restart — they are
		// persisted in AgentStore and will be rediscovered on next startup.

		// Stop mDNS advertising (also stops the IP-change poll loop)
		if (mdnsSupervisor) {
			try {
				await mdnsSupervisor.stop();
			} catch {
				/* best-effort */
			}
		}

		// Close server
		await serverInstance.close();

		// Close MemoryStore
		memoryStore.close();

		// Dispose embedding provider native resources (e.g. local llama context)
		if (embeddingProvider?.dispose) {
			try {
				await embeddingProvider.dispose();
			} catch {
				/* best-effort */
			}
		}

		// Clean up temporary MCP config files
		await cleanupAllMcpConfigFiles().catch(() => {});

		// Clean up runtime state (both daemon and foreground)
		const state = await loadServerRuntimeState();
		if (state?.pid === process.pid) {
			await clearServerRuntimeState();
		}

		logger.info("main", "Graceful shutdown complete");
		process.exit(0);
	};

	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);

	// SIGHUP → manually force an mDNS re-advertise (e.g. `kill -HUP <pid>` after a
	// network change) without restarting the server.
	process.on("SIGHUP", () => {
		if (!mdnsSupervisor) return;
		logger.info("main", "SIGHUP received — forcing mDNS rebind");
		void mdnsSupervisor.rebind("SIGHUP");
	});
}

main().catch((err) => {
	console.error(chalk.red("Fatal error:"), err.message || err);
	process.exit(1);
});
