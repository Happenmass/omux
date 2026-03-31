import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { type WebSocket, WebSocketServer } from "ws";
import type { ContextManager } from "../core/context-manager.js";
import type { MainAgent } from "../core/main-agent.js";
import type { SignalRouter } from "../core/signal-router.js";
import type { ConversationStore } from "../persistence/conversation-store.js";
import type { TmuxBridge } from "../tmux/bridge.js";
import { logger } from "../utils/logger.js";
import { buildAuthCookie, createServerAuthToken, isAuthorized } from "./auth.js";
import type { ChatBroadcaster } from "./chat-broadcaster.js";
import type { CommandRegistry } from "./command-registry.js";
import { CommandRouter } from "./command-router.js";
import type { ExecutionEventStore } from "./execution-events.js";
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
	executionEventStore: ExecutionEventStore;
	uiEventStore?: UiEventStore;
	onReset?: () => Promise<void>;
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
		executionEventStore,
		uiEventStore = new UiEventStore(),
		onReset,
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

	app.get("/api/execution-events", (req, res) => {
		const limitRaw = typeof req.query.limit === "string" ? Number.parseInt(req.query.limit, 10) : undefined;
		const limit = Number.isFinite(limitRaw) ? limitRaw : 50;
		res.json(executionEventStore.listRecent(limit));
	});

	app.get("/api/ui-events", (req, res) => {
		const limitRaw = typeof req.query.limit === "string" ? Number.parseInt(req.query.limit, 10) : undefined;
		const limit = Number.isFinite(limitRaw) ? limitRaw : 200;
		res.json(uiEventStore.listRecent(limit));
	});

	// ─── Session terminal snapshot helper ───────────────
	async function collectSessionTerminals() {
		const activeSessions = mainAgent.getActiveSessions();
		const sessions: Array<{
			sessionName: string;
			sessionId: string;
			status: string;
			paneContent: string;
		}> = [];
		for (const s of activeSessions) {
			let paneContent = "";
			try {
				const capture = await bridge.capturePane(s.paneTarget, {
					escapeSequences: true,
					startLine: -100,
				});
				paneContent = capture.content;
			} catch {
				// tmux pane may have been destroyed — return empty content
			}
			sessions.push({
				sessionName: s.sessionName,
				sessionId: s.sessionId,
				status: s.status,
				paneContent,
			});
		}
		return sessions;
	}

	function broadcastSessionTerminals() {
		collectSessionTerminals()
			.then((sessions) => {
				broadcaster.broadcast({ type: "session_terminals", sessions });
			})
			.catch((err) => {
				logger.warn("server", `Terminal broadcast failed: ${err.message}`);
			});
	}

	// ─── Terminal broadcast timer ───────────────────────
	let lastBroadcastSessionCount = 0;
	const terminalBroadcastInterval = setInterval(() => {
		if (broadcaster.getClientCount() === 0) return;
		const activeSessions = mainAgent.getActiveSessions();
		if (activeSessions.length === 0 && lastBroadcastSessionCount === 0) return;
		lastBroadcastSessionCount = activeSessions.length;
		broadcastSessionTerminals();
	}, 1000);

	// Register session change callback for immediate broadcast
	mainAgent.setOnSessionChange(() => {
		if (broadcaster.getClientCount() === 0) return;
		lastBroadcastSessionCount = mainAgent.getActiveSessions().length;
		broadcastSessionTerminals();
	});

	app.get("/api/sessions/terminals", async (_req, res) => {
		try {
			const sessions = await collectSessionTerminals();
			res.json(sessions);
		} catch (err: any) {
			logger.error("server", `Failed to collect session terminals: ${err.message}`);
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
		executionEventStore,
		uiEventStore,
		onReset,
	});

	wss.on("connection", (ws: WebSocket, req) => {
		if (!isAuthorized(req.headers, authToken)) {
			ws.close(1008, "Unauthorized");
			return;
		}
		handleWebSocket(ws, { mainAgent, broadcaster, commandRouter });
	});

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
