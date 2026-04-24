import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { type WebSocket, WebSocketServer } from "ws";
import type { ContextManager } from "../core/context-manager.js";
import type { LearningChat } from "../core/learning-chat.js";
import type { LearningPipeline } from "../core/learning-pipeline.js";
import type { LearningStore } from "../core/learning-store.js";
import type { MainAgent } from "../core/main-agent.js";
import type { SignalRouter } from "../core/signal-router.js";
import type { LLMClient } from "../llm/client.js";
import type { PromptLoader } from "../llm/prompt-loader.js";
import type { MemoryStore } from "../memory/store.js";
import type { ConversationStore } from "../persistence/conversation-store.js";
import type { TmuxBridge } from "../tmux/bridge.js";
import { logger } from "../utils/logger.js";
import { buildAuthCookie, createServerAuthToken, isAuthorized } from "./auth.js";
import type { ChatBroadcaster } from "./chat-broadcaster.js";
import type { CommandRegistry } from "./command-registry.js";
import { CommandRouter } from "./command-router.js";
import { UiEventStore } from "./ui-events.js";
import { handleWebSocket } from "./ws-handler.js";

export interface ServerOptions {
	host?: string;
	port: number;
	mainAgent: MainAgent;
	signalRouter: SignalRouter;
	contextManager: ContextManager;
	conversationStore: ConversationStore;
	broadcaster: ChatBroadcaster;
	bridge: TmuxBridge;
	commandRegistry: CommandRegistry;
	uiEventStore?: UiEventStore;
	onReset?: () => Promise<void>;
	/** Dependencies for /tidy command */
	llmClient?: LLMClient;
	promptLoader?: PromptLoader;
	memoryStore?: MemoryStore;
	syncMemory?: () => Promise<void>;
	learningStore?: LearningStore;
	learningPipeline?: LearningPipeline;
	learningChat?: LearningChat;
}

export interface ServerInstance {
	close: () => Promise<void>;
	port: number;
}

/**
 * Create and start the Cliclaw HTTP + WebSocket server.
 */
export async function startServer(opts: ServerOptions): Promise<ServerInstance> {
	const {
		host = "127.0.0.1",
		port,
		mainAgent,
		signalRouter,
		contextManager,
		conversationStore,
		broadcaster,
		bridge,
		commandRegistry,
		uiEventStore = new UiEventStore(),
		onReset,
		llmClient,
		promptLoader,
		memoryStore,
		syncMemory,
		learningStore,
		learningPipeline,
		learningChat,
	} = opts;

	const app = express();
	app.use(express.json());
	const authToken = createServerAuthToken();

	app.use((req, res, next) => {
		if (req.path.startsWith("/api/")) {
			if (!isAuthorized(req.headers, authToken)) {
				res.status(401).json({ error: "Unauthorized" });
				return;
			}
		} else if (req.method === "GET" && req.path !== "/favicon.ico") {
			res.append("Set-Cookie", buildAuthCookie(authToken));
		}
		next();
	});

	// ─── Static files (Chat UI) ─────────────────────────
	const __dirname = dirname(fileURLToPath(import.meta.url));
	const webDir = join(__dirname, "..", "..", "web");
	app.use(express.static(webDir));

	// ─── REST API ───────────────────────────────────────
	app.get("/api/history", (_req, res) => {
		try {
			const messages = conversationStore.loadMessagesWithCreatedAt();
			res.json(messages);
		} catch (err: any) {
			logger.error("server", `Failed to load history: ${err.message}`);
			res.status(500).json({ error: "Failed to load history" });
		}
	});

	app.get("/api/status", (_req, res) => {
		res.json({
			state: mainAgent.state,
			messageCount: conversationStore.getMessageCount(),
			clients: broadcaster.getClientCount(),
		});
	});

	app.get("/api/commands", (req, res) => {
		const query = typeof req.query.q === "string" ? req.query.q : undefined;
		res.json(commandRegistry.search(query));
	});

	app.get("/api/ui-events", (req, res) => {
		const limitRaw = typeof req.query.limit === "string" ? Number.parseInt(req.query.limit, 10) : undefined;
		const limit = Number.isFinite(limitRaw) ? limitRaw : 200;
		res.json(uiEventStore.listRecent(limit));
	});

	// ─── Learning entries API ───────────────────────────
	if (learningStore && learningPipeline) {
		const ls = learningStore;
		const lp = learningPipeline;

		app.get("/api/learning", async (req, res) => {
			try {
				const status = (req.query.status as "active" | "archived") ?? "active";
				const limit = Number(req.query.limit) || 100;
				const offset = Number(req.query.offset) || 0;
				const entries = await ls.list({ status, limit, offset });
				res.json(entries);
			} catch (e) {
				res.status(500).json({ error: (e as Error).message });
			}
		});

		app.get("/api/learning/:id", async (req, res) => {
			const e = await ls.loadEntry(req.params.id);
			if (!e) {
				res.status(404).json({ error: "not found" });
				return;
			}
			res.json(e);
		});

		app.get("/api/learning/:id/diff", async (req, res) => {
			try {
				const content = await ls.readDiffBlob(req.params.id);
				res.type("text/plain").send(content);
			} catch (e) {
				res.status(404).json({ error: (e as Error).message });
			}
		});

		app.get("/api/learning/:id/messages", async (req, res) => {
			const msgs = await ls.loadMessages(req.params.id);
			res.json(msgs);
		});

		app.patch("/api/learning/:id", async (req, res) => {
			try {
				const { title, status } = req.body ?? {};
				if (typeof title === "string") await ls.updateTitle(req.params.id, title);
				if (status === "active" || status === "archived") await ls.setStatus(req.params.id, status);
				const updated = await ls.loadEntry(req.params.id);
				if (!updated) {
					res.status(404).json({ error: "not found" });
					return;
				}
				res.json(updated);
			} catch (e) {
				res.status(500).json({ error: (e as Error).message });
			}
		});

		app.post("/api/learning/merge", async (req, res) => {
			try {
				const { ids, title } = req.body ?? {};
				if (!Array.isArray(ids) || ids.length < 2) {
					res.status(400).json({ error: "ids array of at least 2 required" });
					return;
				}
				const merged = await lp.merge(ids, title);
				res.json(merged);
			} catch (e) {
				res.status(400).json({ error: (e as Error).message });
			}
		});

		app.post("/api/learning/:id/regenerate", async (req, res) => {
			try {
				res.json(await lp.regenerate(req.params.id));
			} catch (e) {
				res.status(400).json({ error: (e as Error).message });
			}
		});

		app.post("/api/learning/:id/flush-to-memory", async (req, res) => {
			try {
				res.json(await lp.flushToMemory(req.params.id));
			} catch (e) {
				res.status(400).json({ error: (e as Error).message });
			}
		});

		app.delete("/api/learning/:id", async (req, res) => {
			try {
				await ls.delete(req.params.id);
				res.status(204).end();
			} catch (e) {
				res.status(500).json({ error: (e as Error).message });
			}
		});
	}

	// ─── Agent terminal snapshot helper ────────────────
	const DEFAULT_TERMINAL_LINES = 100;
	const TERMINAL_LINES_INCREMENT = 50;
	/** Per-agent requested line count (default 100, grows by 50 on each "terminal_more") */
	const agentTerminalLines = new Map<string, number>();

	function getTerminalLines(agentId: string): number {
		return agentTerminalLines.get(agentId) ?? DEFAULT_TERMINAL_LINES;
	}

	function expandTerminalLines(agentId: string): void {
		const current = getTerminalLines(agentId);
		agentTerminalLines.set(agentId, current + TERMINAL_LINES_INCREMENT);
	}

	async function collectAgentTerminals() {
		const activeAgents = mainAgent.getActiveAgents();
		const activeIds = new Set(activeAgents.map((a) => a.agentId));

		// Clean up entries for agents that no longer exist
		for (const id of agentTerminalLines.keys()) {
			if (!activeIds.has(id)) agentTerminalLines.delete(id);
		}

		const agents: Array<{
			agentName: string;
			agentId: string;
			status: string;
			paneContent: string;
			takenOver: boolean;
		}> = [];
		for (const a of activeAgents) {
			let paneContent = "";
			try {
				const lines = getTerminalLines(a.agentId);
				const capture = await bridge.capturePane(a.paneTarget, {
					escapeSequences: true,
					startLine: -lines,
				});
				paneContent = capture.content;
			} catch {
				// tmux pane may have been destroyed — return empty content
			}
			agents.push({
				agentName: a.agentName,
				agentId: a.agentId,
				status: a.status,
				paneContent,
				takenOver: a.takenOver,
			});
		}
		return agents;
	}

	function broadcastAgentTerminals() {
		collectAgentTerminals()
			.then((agents) => {
				broadcaster.broadcast({ type: "agent_terminals", agents });
			})
			.catch((err) => {
				logger.warn("server", `Terminal broadcast failed: ${err.message}`);
			});
	}

	// ─── Terminal broadcast timer ───────────────────────
	let lastBroadcastAgentCount = 0;
	const terminalBroadcastInterval = setInterval(() => {
		if (broadcaster.getClientCount() === 0) return;
		const activeAgents = mainAgent.getActiveAgents();
		if (activeAgents.length === 0 && lastBroadcastAgentCount === 0) return;
		lastBroadcastAgentCount = activeAgents.length;
		broadcastAgentTerminals();
	}, 1000);

	// Register agent change callback for immediate broadcast
	mainAgent.setOnAgentChange(() => {
		if (broadcaster.getClientCount() === 0) return;
		lastBroadcastAgentCount = mainAgent.getActiveAgents().length;
		broadcastAgentTerminals();
	});

	app.get("/api/agents/terminals", async (_req, res) => {
		try {
			const agents = await collectAgentTerminals();
			res.json(agents);
		} catch (err: any) {
			logger.error("server", `Failed to collect agent terminals: ${err.message}`);
			res.json([]);
		}
	});

	// ─── HTTP server ────────────────────────────────────
	const server = createServer(app);

	// ─── WebSocket server ───────────────────────────────
	const wss = new WebSocketServer({ server, path: "/ws" });

	const commandRouter = new CommandRouter({
		mainAgent,
		signalRouter,
		contextManager,
		broadcaster,
		commandRegistry,
		uiEventStore,
		onReset,
		llmClient,
		promptLoader,
		memoryStore,
		syncMemory,
	});

	wss.on("connection", (ws: WebSocket, req) => {
		if (!isAuthorized(req.headers, authToken)) {
			ws.close(1008, "Unauthorized");
			return;
		}
		handleWebSocket(ws, {
			mainAgent,
			broadcaster,
			commandRouter,
			bridge,
			onTerminalMore: expandTerminalLines,
			learningChat,
		});
	});

	// ─── Scheduled nightly tidy (23:30) ────────────────
	let tidyTimer: ReturnType<typeof setTimeout> | null = null;

	function scheduleTidy() {
		const now = new Date();
		const target = new Date(now);
		target.setHours(23, 30, 0, 0);
		if (target.getTime() <= now.getTime()) {
			// Already past 23:30 today — schedule for tomorrow
			target.setDate(target.getDate() + 1);
		}
		const delay = target.getTime() - now.getTime();
		logger.info("server", `Next scheduled tidy at ${target.toLocaleString()} (in ${Math.round(delay / 60000)}min)`);

		tidyTimer = setTimeout(async () => {
			logger.info("server", "Running scheduled nightly tidy");
			try {
				await commandRouter.handle("tidy");
			} catch (err: any) {
				logger.warn("server", `Scheduled tidy failed: ${err.message}`);
			}
			// Re-schedule for next night
			scheduleTidy();
		}, delay);
	}

	scheduleTidy();

	// ─── Start listening ────────────────────────────────
	return new Promise<ServerInstance>((resolve, reject) => {
		server.on("error", (err: NodeJS.ErrnoException) => {
			if (err.code === "EADDRINUSE") {
				logger.error("server", `Port ${port} is already in use`);
				reject(new Error(`Port ${port} is already in use. Use --port to specify a different port.`));
			} else {
				reject(err);
			}
		});

		server.listen(port, host, () => {
			const address = server.address();
			const actualPort = typeof address === "object" && address ? address.port : port;
			logger.info("server", `Cliclaw server running at http://${host}:${actualPort}`);
			console.log(`Cliclaw server running at http://${host}:${actualPort}`);

			resolve({
				port: actualPort,
				close: async () => {
					if (tidyTimer) clearTimeout(tidyTimer);
					clearInterval(terminalBroadcastInterval);
					// Close all WebSocket connections
					for (const client of wss.clients) {
						client.close();
					}
					wss.close();
					await new Promise<void>((res, rej) => {
						server.close((err) => (err ? rej(err) : res()));
					});
					logger.info("server", "Server shut down");
				},
			});
		});
	});
}
