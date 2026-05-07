import type { WebSocket } from "ws";
import type { LearningChat } from "../core/learning-chat.js";
import type { MainAgent } from "../core/main-agent.js";
import type { TmuxBridge } from "../tmux/bridge.js";
import { logger } from "../utils/logger.js";
import type { ChatBroadcaster } from "./chat-broadcaster.js";
import type { CommandRouter } from "./command-router.js";

/**
 * Handles a single WebSocket connection:
 * - Registers client with ChatBroadcaster
 * - Sends current state on connect
 * - Routes incoming messages to MainAgent or CommandRouter
 * - Cleans up on disconnect
 */
export function handleWebSocket(
	ws: WebSocket,
	opts: {
		mainAgent: MainAgent;
		broadcaster: ChatBroadcaster;
		commandRouter: CommandRouter;
		bridge: TmuxBridge;
		onTerminalMore?: (agentId: string) => void;
		learningChat?: LearningChat;
	},
): void {
	const { mainAgent, broadcaster, commandRouter, bridge } = opts;

	// Register client
	broadcaster.addClient(ws);

	// Send current state on connect
	ws.send(
		JSON.stringify({
			type: "state",
			state: mainAgent.state,
			queueSize: mainAgent.getPendingUserMessageCount(),
			contextUsage: mainAgent.getContextUsage(),
		}),
	);

	ws.on("message", async (data) => {
		let parsed: any;
		try {
			parsed = JSON.parse(data.toString());
		} catch {
			logger.warn("ws-handler", `Invalid JSON received: ${data.toString().slice(0, 200)}`);
			return;
		}

		if (!parsed.type) {
			logger.warn("ws-handler", "Message missing type field");
			return;
		}

		switch (parsed.type) {
			case "message": {
				const content = parsed.content as string;
				if (!content || typeof content !== "string") {
					logger.warn("ws-handler", "Message missing content field");
					return;
				}
				// Fire-and-forget: handleMessage manages its own lifecycle
				mainAgent.handleMessage(content).catch((err) => {
					logger.error("ws-handler", `handleMessage error: ${err.message}`);
					broadcaster.broadcast({
						type: "system",
						message: `处理消息时出错: ${err.message}`,
					});
				});
				break;
			}

			case "command": {
				const name = parsed.name as string;
				if (!name || typeof name !== "string") {
					logger.warn("ws-handler", "Command missing name field");
					return;
				}
				commandRouter.handle(name).catch((err) => {
					logger.error("ws-handler", `Command error: ${err.message}`);
					broadcaster.broadcast({
						type: "system",
						message: `指令执行出错: ${err.message}`,
					});
				});
				break;
			}

			case "takeover": {
				const agentId = parsed.agentId as string;
				if (!agentId) {
					logger.warn("ws-handler", "Takeover missing agentId");
					return;
				}
				mainAgent.setTakenOver(agentId, true);
				broadcaster.broadcast({ type: "system", message: `会话 ${agentId} 已被人工接管` });
				break;
			}

			case "release": {
				const agentId = parsed.agentId as string;
				if (!agentId) {
					logger.warn("ws-handler", "Release missing agentId");
					return;
				}
				mainAgent.setTakenOver(agentId, false);
				broadcaster.broadcast({ type: "system", message: `会话 ${agentId} 已恢复 MainAgent 控制` });
				break;
			}

			case "terminal_input": {
				const agentId = parsed.agentId as string;
				const data = (parsed.data as string) ?? "";
				const inputType = parsed.inputType as string;
				if (!agentId || !inputType) {
					logger.warn("ws-handler", "terminal_input missing agentId or inputType");
					return;
				}
				if (!mainAgent.isTakenOver(agentId)) {
					logger.warn("ws-handler", `terminal_input rejected: agent ${agentId} is not taken over`);
					return;
				}
				const paneTarget = mainAgent.getAgentPaneTarget(agentId);
				if (!paneTarget) {
					logger.warn("ws-handler", `terminal_input: agent ${agentId} not found`);
					return;
				}
				try {
					switch (inputType) {
						case "keys":
							await bridge.sendKeys(paneTarget, data);
							break;
						case "text":
							await bridge.sendKeys(paneTarget, data, { literal: true });
							break;
						case "enter":
							await bridge.sendEnter(paneTarget);
							break;
						case "ctrl-c":
							await bridge.sendCtrlC(paneTarget);
							break;
						case "escape":
							await bridge.sendEscape(paneTarget);
							break;
						default:
							logger.warn("ws-handler", `Unknown terminal_input type: ${inputType}`);
					}
				} catch (err: any) {
					logger.error("ws-handler", `terminal_input error: ${err.message}`);
				}
				break;
			}

			case "agent_abort": {
				const agentId = parsed.agentId as string;
				if (!agentId) {
					logger.warn("ws-handler", "agent_abort missing agentId");
					return;
				}
				const paneTarget = mainAgent.getAgentPaneTarget(agentId);
				if (!paneTarget) {
					logger.warn("ws-handler", `agent_abort: agent ${agentId} not found`);
					return;
				}
				try {
					await bridge.sendEscape(paneTarget);
					logger.info("ws-handler", `agent_abort: sent ESC to ${agentId}`);
				} catch (err: any) {
					logger.error("ws-handler", `agent_abort error: ${err.message}`);
				}
				break;
			}

			case "terminal_more": {
				const agentId = parsed.agentId as string;
				if (!agentId) {
					logger.warn("ws-handler", "terminal_more missing agentId");
					return;
				}
				if (opts.onTerminalMore) {
					opts.onTerminalMore(agentId);
				}
				break;
			}

			case "learning_message": {
				if (opts.learningChat && typeof parsed.entryId === "string" && typeof parsed.content === "string") {
					opts.learningChat.handleMessage(parsed.entryId, parsed.content).catch((err) => {
						ws.send(
							JSON.stringify({
								type: "learning_error",
								entryId: parsed.entryId,
								message: (err as Error).message,
							}),
						);
					});
				}
				break;
			}

			case "learning_stop": {
				if (opts.learningChat && typeof parsed.entryId === "string") {
					opts.learningChat.stop(parsed.entryId);
				}
				break;
			}

			default:
				logger.warn("ws-handler", `Unknown message type: ${parsed.type}`);
		}
	});

	ws.on("close", () => {
		broadcaster.removeClient(ws);
	});

	ws.on("error", (err) => {
		logger.error("ws-handler", `WebSocket error: ${err.message}`);
		broadcaster.removeClient(ws);
	});
}
