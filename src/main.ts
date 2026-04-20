#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import chalk from "chalk";
import type { AgentAdapter } from "./agents/adapter.js";
import { ClaudeCodeAdapter } from "./agents/claude-code.js";
import { CodexAdapter } from "./agents/codex.js";
import { parseCliArgs, printHelp, printVersion } from "./cli.js";
import { ContextManager } from "./core/context-manager.js";
import { MainAgent } from "./core/main-agent.js";
import { SignalRouter } from "./core/signal-router.js";
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
import { ChatBroadcaster } from "./server/chat-broadcaster.js";
import { CommandRegistry } from "./server/command-registry.js";
import { startServer } from "./server/index.js";
import { UiEventStore } from "./server/ui-events.js";
import { discoverSkills } from "./skills/discovery.js";
import { filterSkills } from "./skills/filter.js";
import { buildCapabilitiesSummary } from "./skills/injector.js";
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
	getGlobalStorageDir,
	getLogsDir,
	loadConfig,
	loadServerRuntimeState,
	type ServerRuntimeState,
	saveServerRuntimeState,
} from "./utils/config.js";
import { logger } from "./utils/logger.js";

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

async function triggerTmuxEscapeCascade(opts?: { repeats?: number; intervalMs?: number }): Promise<void> {
	const repeats = Math.max(1, opts?.repeats ?? 2);
	const intervalMs = Math.max(0, opts?.intervalMs ?? 80);
	const bridge = new TmuxBridge();

	const tmuxInstalled = await bridge.checkInstalled();
	if (!tmuxInstalled) {
		return;
	}

	const sessions = await bridge.listCliclawAgents();
	for (const session of sessions) {
		let panes = [];
		try {
			panes = await bridge.listPanes(session.name);
		} catch {
			continue;
		}

		for (const pane of panes) {
			for (let i = 0; i < repeats; i++) {
				try {
					await bridge.sendEscape(pane.id);
				} catch {
					break;
				}
				if (intervalMs > 0) {
					await sleep(intervalMs);
				}
			}
		}
	}
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
		case "claude-code":
		default:
			return new ClaudeCodeAdapter();
	}
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
		console.log(`Cliclaw is already running: ${running.url}`);
		return;
	}

	// Check if port is already in use (e.g. by a foreground process without state file)
	if (await isPortInUse(args.host, args.port)) {
		console.error(`Port ${args.port} is already in use.`);
		console.error("Run 'cliclaw stop' first, or use --port to specify a different port.");
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
				CLICLAW_DAEMON: "1",
			},
		});

		child.unref();

		if (!child.pid) {
			console.error("Failed to launch Cliclaw background process.");
			process.exit(1);
		}

		const state = await waitForServerState(child.pid);
		if (state) {
			console.log(`Cliclaw started in background: ${state.url}`);
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
					console.error(`Failed to start Cliclaw:\n${lastLines}`);
				} else {
					console.error(`Failed to start Cliclaw. See logs: ${logFile}`);
				}
			} catch {
				console.error(`Failed to start Cliclaw. See logs: ${logFile}`);
			}
			process.exit(1);
		}

		// Process is running but no state yet — give it a bit more time
		await sleep(2000);
		const retryState = await waitForServerState(child.pid, 3000);
		if (retryState) {
			console.log(`Cliclaw started in background: ${retryState.url}`);
			console.log(`Log file: ${logFile}`);
			return;
		}

		const fallbackUrl = `http://${args.host}:${args.port}`;
		console.log(`Cliclaw started in background: ${fallbackUrl}`);
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
				console.log(`Stopped Cliclaw on port ${port}.`);
			} else {
				console.error(`Failed to stop process on port ${port}. Try manually: lsof -ti :${port} | xargs kill`);
			}
		} else {
			console.log("Cliclaw is not running.");
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
			console.log("Cliclaw is not running (cleared stale state).");
		}
		return;
	}

	// Best-effort: cascade ESC to cliclaw tmux panes before stopping server process.
	await triggerTmuxEscapeCascade();

	try {
		process.kill(state.pid, "SIGTERM");
	} catch (err: any) {
		if (err?.code === "ESRCH") {
			await clearServerRuntimeState();
			console.log("Cliclaw is not running (cleared stale state).");
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
			console.log(`Stopped Cliclaw: ${state.url}`);
			return;
		}
		await sleep(200);
	}

	// Try one more ESC cascade before forcing SIGKILL.
	await triggerTmuxEscapeCascade({ repeats: 1, intervalMs: 40 });

	try {
		process.kill(state.pid, "SIGKILL");
	} catch (err: any) {
		if (err?.code !== "ESRCH") {
			throw err;
		}
	}

	await clearServerRuntimeState();
	await waitForPortRelease(host, port);
	console.log(`Stopped Cliclaw (forced): ${state.url}`);
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
			const targetPath = args.global ? join(getConfigDir(), "MEMORY.md") : join(args.cwd, ".cliclaw", "MEMORY.md");
			await appendToPersistentMemory(targetPath, "active_notes", args.rememberText);
			const scope = args.global ? "global" : "project";
			console.log(`${chalk.green("Remembered")} (${scope}): ${args.rememberText}`);
		} else {
			console.error(chalk.yellow("Please provide text to remember."));
			console.error('Usage: cliclaw remember "your note here"');
			console.error("  --global/-g  Save to global memory instead of project memory");
			process.exit(1);
		}
		process.exit(0);
	}

	// Handle "init" subcommand
	if (args.isInit) {
		const { mkdir, writeFile, access } = await import("node:fs/promises");
		const cliclawDir = join(args.cwd, ".cliclaw");
		const dirs = [join(cliclawDir, "skills"), join(cliclawDir, "prompts")];
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
			console.log(chalk.green("Initialized Cliclaw project directories:"));
		} else {
			console.log(chalk.dim("Cliclaw project directories already exist:"));
		}
		console.log(`  ${cliclawDir}/skills/`);
		console.log(`  ${cliclawDir}/prompts/`);
		process.exit(0);
	}

	// ─── Default: Start Server ──────────────────────────
	const isDaemonProcess = process.env.CLICLAW_DAEMON === "1";

	await ensureConfigDir();
	await logger.init();

	// Check for existing daemon before starting
	if (!isDaemonProcess) {
		const existingDaemon = await getActiveServerState();
		if (existingDaemon) {
			console.error(`Cliclaw is already running as a daemon: ${existingDaemon.url}`);
			console.error("Run 'cliclaw stop' first, or use 'cliclaw restart'.");
			process.exit(1);
		}
		if (await isPortInUse(args.host, args.port)) {
			console.error(`Port ${args.port} is already in use.`);
			console.error("Run 'cliclaw stop' first, or use --port to specify a different port.");
			process.exit(1);
		}
	}

	const config = await loadConfig();

	// Resolve agent: CLI --agent flag takes precedence over config.defaultAgent
	const agentName = args.agent ?? config.defaultAgent;

	console.log(`${chalk.bold("Cliclaw")} v0.2.0\n`);

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
	});

	// Initialize PromptLoader
	const promptLoader = new PromptLoader();
	await promptLoader.load(args.cwd);

	// Initialize global storage directory (~/.cliclaw/memory/)
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

	console.log(chalk.dim("Agent:    ") + agentName);
	console.log(`${chalk.dim("Provider: ")}${llmProvider} (${llmClient.getModel()})`);
	console.log(`${chalk.dim("Host:     ")}${args.host}`);
	console.log(`${chalk.dim("Port:     ")}${args.port}`);
	console.log();

	// Initialize components
	const stateDetector = new StateDetector(bridge, llmClient, config.stateDetector, promptLoader);

	// Setup agent adapter
	const defaultAdapter = createAdapter(agentName);

	// Initialize ConversationStore and AgentStore (reuse global DB)
	const conversationStore = new ConversationStore(memoryStore.getDb());
	const agentStore = new AgentStore(memoryStore.getDb());

	// Initialize ChatBroadcaster
	const broadcaster = new ChatBroadcaster();
	const uiEventStore = new UiEventStore({ db: memoryStore.getDb() });

	// Initialize ContextManager with conversation persistence
	const contextManager = new ContextManager({
		llmClient,
		promptLoader,
		memoryStore,
		syncMemory,
		contextWindowLimit: args.contextWindow || config.context.contextWindowLimit,
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
	});
	const filteredSkills = filterSkills(discoveredSkills, { disabled: config.skills?.disabled }, args.cwd);
	const capFile = defaultAdapter.getCapabilitiesFile?.();
	const adapterCapabilities = capFile
		? promptLoader.loadAdapterCapabilities(capFile.replace(/^adapters\//, "").replace(/\.md$/, ""))
		: "";
	const baseCapabilities = adapterCapabilities || "Direct code editing and file operations\nRunning terminal commands";
	const capabilitiesSummary = buildCapabilitiesSummary(baseCapabilities, filteredSkills);
	contextManager.updateModule("agent_capabilities", capabilitiesSummary);

	// Load persistent memory (MEMORY.md) into {{memory}} module
	const globalDir = getConfigDir();
	try {
		const persistentMemory = await loadPersistentMemory(globalDir, args.cwd);
		if (persistentMemory) {
			contextManager.updateModule("memory", persistentMemory);
			logger.info("main", "Persistent memory loaded into context");
		}
	} catch (err: any) {
		logger.warn("main", `Failed to load persistent memory (non-fatal): ${err.message}`);
	}

	const openspecCmds = defaultAdapter.getOpenSpecCommands?.() ?? {
		toolName: "claude",
		explore: "/opsx:explore",
		propose: "/opsx:propose",
		apply: "/opsx:apply",
		archive: "/opsx:archive",
		wildcard: "/opsx:*",
	};
	contextManager.updateModule("openspec_tool_name", openspecCmds.toolName);
	contextManager.updateModule("openspec_cmd_explore", openspecCmds.explore);
	contextManager.updateModule("openspec_cmd_propose", openspecCmds.propose);
	contextManager.updateModule("openspec_cmd_apply", openspecCmds.apply);
	contextManager.updateModule("openspec_cmd_archive", openspecCmds.archive);
	contextManager.updateModule("openspec_cmd_wildcard", openspecCmds.wildcard);
	const skillRegistry = new SkillRegistry(filteredSkills);
	logger.info("main", `Skills loaded: ${skillRegistry.size} (${filteredSkills.map((s) => s.name).join(", ")})`);

	// Initialize SignalRouter and MainAgent
	const signalRouter = new SignalRouter(stateDetector, bridge, contextManager);

	const mainAgent = new MainAgent({
		contextManager,
		signalRouter,
		llmClient,
		adapter: defaultAdapter,
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
		searchConfig: {
			vectorWeight: config.memory.vectorWeight,
			textWeight: 1 - config.memory.vectorWeight,
			temporalDecay: {
				enabled: true,
				halfLifeDays: config.memory.decayHalfLifeDays,
			},
		},
	});

	mainAgent.setupAgentMonitor();

	// Restore persisted agents (verify tmux is still alive, discard dead ones)
	const persistedAgents = agentStore.loadAgents();
	if (persistedAgents.length > 0) {
		let restoredCount = 0;
		for (const a of persistedAgents) {
			const alive = await bridge.hasSession(a.agentId);
			if (alive) {
				mainAgent.restoreAgent(a.agentId, { paneTarget: a.paneTarget, workingDir: a.workingDir }, a.takenOver);
				restoredCount++;
			} else {
				agentStore.deleteAgent(a.agentId);
				logger.info("main", `Discarded dead agent: ${a.agentId}`);
			}
		}
		if (restoredCount > 0) {
			logger.info("main", `Restored ${restoredCount} agent(s)`);
			console.log(chalk.dim(`Restored ${restoredCount} agent(s) from previous run`));
		}
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
		});
		const resetFiltered = filterSkills(resetDiscovered, { disabled: config.skills?.disabled }, args.cwd);

		// 3. Rebuild capabilities summary and update ContextManager modules
		const resetCapFile = defaultAdapter.getCapabilitiesFile?.();
		const resetAdapterCaps = resetCapFile
			? promptLoader.loadAdapterCapabilities(resetCapFile.replace(/^adapters\//, "").replace(/\.md$/, ""))
			: "";
		const resetBaseCaps = resetAdapterCaps || "Direct code editing and file operations\nRunning terminal commands";
		const resetCapSummary = buildCapabilitiesSummary(resetBaseCaps, resetFiltered);
		contextManager.updateModule("agent_capabilities", resetCapSummary);

		const resetOpenspec = defaultAdapter.getOpenSpecCommands?.() ?? {
			toolName: "claude",
			explore: "/opsx:explore",
			propose: "/opsx:propose",
			apply: "/opsx:apply",
			archive: "/opsx:archive",
			wildcard: "/opsx:*",
		};
		contextManager.updateModule("openspec_tool_name", resetOpenspec.toolName);
		contextManager.updateModule("openspec_cmd_explore", resetOpenspec.explore);
		contextManager.updateModule("openspec_cmd_propose", resetOpenspec.propose);
		contextManager.updateModule("openspec_cmd_apply", resetOpenspec.apply);
		contextManager.updateModule("openspec_cmd_archive", resetOpenspec.archive);
		contextManager.updateModule("openspec_cmd_wildcard", resetOpenspec.wildcard);

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

		// 6. Re-sync memory index
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

	const serverInstance = await startServer({
		host: args.host,
		port: args.port,
		mainAgent,
		signalRouter,
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
	});

	// Notify connected clients about restored conversation
	if (restoredMessageCount > 0) {
		// Delay slightly to let WebSocket clients connect first
		setTimeout(() => {
			broadcaster.broadcast({
				type: "system",
				message: `已从上次会话恢复 ${restoredMessageCount} 条消息`,
			});
		}, 500);
	}

	// Save runtime state for both daemon and foreground modes so `stop` can find us
	await saveServerRuntimeState({
		pid: process.pid,
		host: args.host,
		port: serverInstance.port,
		url: `http://${args.host}:${serverInstance.port}`,
		cwd: args.cwd,
		startedAt: new Date().toISOString(),
	});

	// ─── Graceful Shutdown ──────────────────────────────

	const shutdown = async () => {
		console.log(chalk.yellow("\nShutting down..."));

		mainAgent.shutdownMonitor();

		// Stop MainAgent if executing
		if (mainAgent.state === "executing") {
			signalRouter.stop();
			// Give the loop a moment to exit cleanly
			await new Promise((resolve) => setTimeout(resolve, 500));
		}

		// Close server
		await serverInstance.close();

		// Close MemoryStore
		memoryStore.close();

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
}

main().catch((err) => {
	console.error(chalk.red("Fatal error:"), err.message || err);
	process.exit(1);
});
