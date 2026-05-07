import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MainAgent } from "../../src/core/main-agent.js";
import type { LLMStreamEvent } from "../../src/llm/types.js";

// Mock the config and mcp-config modules
vi.mock("../../src/utils/config.js", async (importOriginal) => {
	const actual = (await importOriginal()) as any;
	return {
		...actual,
		loadConfig: vi.fn(),
	};
});

vi.mock("../../src/utils/mcp-config.js", async (importOriginal) => {
	const actual = (await importOriginal()) as any;
	return {
		...actual,
		selectMcpServers: vi.fn(),
		generateMcpConfigFile: vi.fn(),
		cleanupMcpConfigFile: vi.fn(),
	};
});

// Import after mocking
const { loadConfig } = await import("../../src/utils/config.js");
const { selectMcpServers, generateMcpConfigFile, cleanupMcpConfigFile } = await import(
	"../../src/utils/mcp-config.js"
);

// ─── Mock factories ──────────────────────────────────

function createMockContextManager() {
	return {
		addMessage: vi.fn(),
		getMessages: vi.fn().mockReturnValue([]),
		getSystemPrompt: vi.fn().mockReturnValue("You are the Main Agent"),
		updateModule: vi.fn(),
		shouldCompress: vi.fn().mockReturnValue(false),
		compress: vi.fn(),
		getConversationLength: vi.fn().mockReturnValue(0),
		prepareForLLM: vi.fn().mockReturnValue({ system: "You are the Main Agent", messages: [] }),
		reportUsage: vi.fn(),
		shouldRunMemoryFlush: vi.fn().mockReturnValue(false),
		runMemoryFlush: vi.fn(),
		getCurrentTokenEstimate: vi.fn().mockReturnValue(0),
		getContextWindowLimit: vi.fn().mockReturnValue(200000),
		getConversationId: vi.fn().mockReturnValue("test-conversation-id"),
		setCompactTuning: vi.fn(),
	} as any;
}

function createMockSignalRouter() {
	return {
		onSignal: vi.fn(),
		startMonitoring: vi.fn(),
		stopMonitoring: vi.fn(),
		notifyPromptSent: vi.fn(),
		resetCaptureExpansion: vi.fn(),
		isStopRequested: vi.fn().mockReturnValue(false),
		stop: vi.fn(),
		resume: vi.fn(),
		emit: vi.fn(),
		on: vi.fn(),
	} as any;
}

function createMockBroadcaster() {
	return {
		broadcast: vi.fn(),
		addClient: vi.fn(),
		removeClient: vi.fn(),
		getClientCount: vi.fn().mockReturnValue(0),
	} as any;
}

function createMockStreamingLLM(responses: LLMStreamEvent[][]) {
	let callCount = 0;
	return {
		stream: vi.fn().mockImplementation(() => {
			const events = responses[callCount] ?? [];
			callCount++;
			return (async function* () {
				for (const event of events) {
					yield event;
				}
			})();
		}),
		complete: vi.fn(),
	} as any;
}

function createMockAdapter() {
	return {
		name: "test-agent",
		displayName: "Test Agent",
		launch: vi.fn().mockResolvedValue("test-session:0.0"),
		sendPrompt: vi.fn().mockResolvedValue(undefined),
		sendResponse: vi.fn().mockResolvedValue(undefined),
		abort: vi.fn(),
		exitAgent: vi.fn().mockResolvedValue({ content: "exited", resumeId: "r-123" }),
		getCharacteristics: vi.fn().mockReturnValue({
			waitingPatterns: [],
			completionPatterns: [],
			errorPatterns: [],
			activePatterns: [],
			confirmKey: "Enter",
			abortKey: "C-c",
		}),
	} as any;
}

function createMockBridge() {
	return {
		capturePane: vi.fn().mockResolvedValue({ content: "pane content\n", lines: 50, timestamp: Date.now() }),
		hasSession: vi.fn().mockResolvedValue(false),
		listCliclawAgents: vi.fn().mockResolvedValue([]),
		createSession: vi.fn().mockResolvedValue(undefined),
		sendEscape: vi.fn().mockResolvedValue(undefined),
		killSession: vi.fn().mockResolvedValue(undefined),
	} as any;
}

function createMockStateDetector() {
	return {
		setCharacteristics: vi.fn(),
		captureHash: vi.fn().mockResolvedValue("mock-hash"),
		waitForSettled: vi.fn().mockResolvedValue({
			analysis: { status: "completed", confidence: 0.9, detail: "done" },
			content: "> done",
			timedOut: false,
		}),
		startMonitoring: vi.fn(),
		stopMonitoring: vi.fn(),
		onStateChange: vi.fn().mockReturnValue(() => {}),
	} as any;
}

function textResponse(text: string): LLMStreamEvent[] {
	const events: LLMStreamEvent[] = [];
	for (const char of text) {
		events.push({ type: "text_delta", delta: char });
	}
	events.push({
		type: "done",
		response: {
			content: text,
			contentBlocks: [{ type: "text", text }],
			usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
			stopReason: "end_turn",
			model: "test",
		},
	});
	return events;
}

function toolCallResponse(
	toolName: string,
	args: Record<string, any>,
	toolCallId = "tc1",
	text = "",
): LLMStreamEvent[] {
	const events: LLMStreamEvent[] = [];
	if (text) {
		events.push({ type: "text_delta", delta: text });
	}
	const argsJson = JSON.stringify(args);
	events.push({
		type: "tool_call_delta",
		index: 0,
		id: toolCallId,
		name: toolName,
		argumentsDelta: argsJson,
	});
	events.push({
		type: "done",
		response: {
			content: text,
			contentBlocks: [
				...(text ? [{ type: "text" as const, text }] : []),
				{ type: "tool_call" as const, id: toolCallId, name: toolName, arguments: args },
			],
			usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
			stopReason: "tool_use",
			model: "test",
		},
	});
	return events;
}

// ─── Tests ─────────────────────────────────────────────

describe("MainAgent MCP server integration", () => {
	let mockAdapter: ReturnType<typeof createMockAdapter>;
	let mockBridge: ReturnType<typeof createMockBridge>;

	function setupAgent(responses: LLMStreamEvent[][], overrides: Record<string, any> = {}) {
		const mockCtx = createMockContextManager();
		const mockRouter = createMockSignalRouter();
		const mockBroadcaster = createMockBroadcaster();
		mockAdapter = createMockAdapter();
		mockBridge = createMockBridge();
		const mockDetector = createMockStateDetector();
		const mockLLM = createMockStreamingLLM(responses);

		return new MainAgent({
			contextManager: mockCtx,
			signalRouter: mockRouter,
			llmClient: mockLLM,
			adapter: mockAdapter,
			bridge: mockBridge,
			stateDetector: mockDetector,
			broadcaster: mockBroadcaster,
			...overrides,
		});
	}

	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("create_agent with mcp_servers", () => {
		it("should generate MCP config and pass mcpConfigPath to adapter when mcp_servers provided", async () => {
			(loadConfig as any).mockResolvedValue({
				mcpServers: {
					"code-review": { command: "uvx", args: ["crg", "serve"], type: "stdio" },
					filesystem: { command: "node", args: ["fs.js"], type: "stdio" },
				},
			});
			(selectMcpServers as any).mockReturnValue({
				servers: { "code-review": { command: "uvx", args: ["crg", "serve"], type: "stdio" } },
			});
			(generateMcpConfigFile as any).mockResolvedValue("/tmp/mcp-configs/cliclaw-test.json");

			const agent = setupAgent([
				toolCallResponse("create_agent", {
					agent_name: "test",
					mcp_servers: ["code-review"],
				}),
				textResponse("Done."),
			]);
			await agent.handleMessage("create agent with MCP");

			expect(loadConfig).toHaveBeenCalled();
			expect(selectMcpServers).toHaveBeenCalledWith(
				{
					"code-review": { command: "uvx", args: ["crg", "serve"], type: "stdio" },
					filesystem: { command: "node", args: ["fs.js"], type: "stdio" },
				},
				["code-review"],
			);
			expect(generateMcpConfigFile).toHaveBeenCalledWith(
				{ "code-review": { command: "uvx", args: ["crg", "serve"], type: "stdio" } },
				"cliclaw-test",
			);
			expect(mockAdapter.launch).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({
					mcpConfigPath: "/tmp/mcp-configs/cliclaw-test.json",
				}),
			);
		});

		it("should not generate MCP config when mcp_servers is omitted", async () => {
			const agent = setupAgent([
				toolCallResponse("create_agent", { agent_name: "test" }),
				textResponse("Done."),
			]);
			await agent.handleMessage("create agent");

			expect(loadConfig).not.toHaveBeenCalled();
			expect(generateMcpConfigFile).not.toHaveBeenCalled();
			expect(mockAdapter.launch).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({
					mcpConfigPath: undefined,
				}),
			);
		});

		it("should return error when mcp_servers requested but none configured", async () => {
			(loadConfig as any).mockResolvedValue({ mcpServers: undefined });

			const agent = setupAgent([
				toolCallResponse("create_agent", { agent_name: "test", mcp_servers: ["x"] }),
				textResponse("Done."),
			]);
			await agent.handleMessage("create agent with MCP");

			// Agent should not be launched
			expect(mockAdapter.launch).not.toHaveBeenCalled();
		});

		it("should return error when unknown MCP server name provided", async () => {
			(loadConfig as any).mockResolvedValue({
				mcpServers: { known: { command: "x", type: "stdio" } },
			});
			(selectMcpServers as any).mockReturnValue({
				error: 'Unknown MCP server(s): unknown. Available servers: known',
			});

			const agent = setupAgent([
				toolCallResponse("create_agent", { agent_name: "test", mcp_servers: ["unknown"] }),
				textResponse("Done."),
			]);
			await agent.handleMessage("create agent with unknown MCP");

			expect(mockAdapter.launch).not.toHaveBeenCalled();
		});
	});

	describe("kill_agent MCP cleanup", () => {
		it("should cleanup MCP config file on kill_agent", async () => {
			// First create an agent, then kill it
			(loadConfig as any).mockResolvedValue({
				mcpServers: { s: { command: "x", type: "stdio" } },
			});
			(selectMcpServers as any).mockReturnValue({
				servers: { s: { command: "x", type: "stdio" } },
			});
			(generateMcpConfigFile as any).mockResolvedValue("/tmp/mcp.json");
			(cleanupMcpConfigFile as any).mockResolvedValue(undefined);
			mockBridge.hasSession
				.mockResolvedValueOnce(false) // create_agent: session doesn't exist yet
				.mockResolvedValueOnce(true); // kill_agent: session exists

			const agent = setupAgent([
				toolCallResponse("create_agent", { agent_name: "test", mcp_servers: ["s"] }, "tc1"),
				// After create_agent result, LLM returns kill_agent
				toolCallResponse("kill_agent", { agent_id: "cliclaw-test", summary: "done" }, "tc2"),
				textResponse("Cleaned up."),
			]);
			await agent.handleMessage("create and kill");

			expect(cleanupMcpConfigFile).toHaveBeenCalledWith("cliclaw-test");
		});
	});
});
