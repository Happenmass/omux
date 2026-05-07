import { describe, it, expect, vi } from "vitest";
import { MainAgent } from "../../src/core/main-agent.js";
import { SkillRegistry } from "../../src/skills/registry.js";
import type { SkillEntry } from "../../src/skills/types.js";

function makeSkill(overrides: Partial<SkillEntry> = {}): SkillEntry {
	return {
		name: "test",
		description: "A test skill",
		type: "agent-capability",
		commands: ["/test"],
		when: null,
		tool: null,
		source: "adapter",
		filePath: "/fake/SKILL.md",
		dirPath: "/fake",
		body: "# Test Skill\n\nDetailed instructions here.",
		...overrides,
	};
}

function createMockContextManager() {
	return {
		addMessage: vi.fn(),
		getMessages: vi.fn().mockReturnValue([]),
		getSystemPrompt: vi.fn().mockReturnValue("system prompt"),
		updateModule: vi.fn(),
		shouldCompress: vi.fn().mockReturnValue(false),
		compress: vi.fn(),
		getConversationLength: vi.fn().mockReturnValue(0),
		prepareForLLM: vi.fn().mockReturnValue({ system: "system prompt", messages: [] }),
		reportUsage: vi.fn(),
		shouldRunMemoryFlush: vi.fn().mockReturnValue(false),
		runMemoryFlush: vi.fn(),
		getCurrentTokenEstimate: vi.fn().mockReturnValue(0),
		getContextWindowLimit: vi.fn().mockReturnValue(200000),
		getConversationId: vi.fn().mockReturnValue("test-conversation-id"),
		setCompactTuning: vi.fn(),
	} as any;
}

function createMockLLMClient() {
	return {
		complete: vi.fn().mockResolvedValue({
			content: "ok",
			contentBlocks: [{ type: "text", text: "ok" }],
			usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
			stopReason: "end_turn",
			model: "test",
		}),
	} as any;
}

function createAgent(registry?: SkillRegistry) {
	return new MainAgent({
		contextManager: createMockContextManager(),
		signalRouter: { onSignal: vi.fn(), startMonitoring: vi.fn(), stopMonitoring: vi.fn(), notifyPromptSent: vi.fn(), resetCaptureExpansion: vi.fn(), isPaused: vi.fn().mockReturnValue(false), isAborted: vi.fn().mockReturnValue(false), emit: vi.fn(), on: vi.fn() } as any,
		llmClient: createMockLLMClient(),
		adapter: { sendPrompt: vi.fn(), sendResponse: vi.fn(), abort: vi.fn(), getCharacteristics: vi.fn().mockReturnValue({}) } as any,
		bridge: { capturePane: vi.fn() } as any,
		stateDetector: { setCooldown: vi.fn(), startMonitoring: vi.fn(), stopMonitoring: vi.fn(), onStateChange: vi.fn() } as any,
		goal: "test",
		skillRegistry: registry,
	});
}

describe("read_skill tool", () => {
	it("should return skill body content when found", async () => {
		const registry = new SkillRegistry([
			makeSkill({ name: "openspec", body: "# OpenSpec\n\nUse /opsx:ff for fast-forward." }),
		]);
		const agent = createAgent(registry);

		const result = await (agent as any).executeTool({
			type: "tool_call",
			id: "tc1",
			name: "read_skill",
			arguments: { name: "openspec" },
		});

		expect(result.output).toContain("# OpenSpec");
		expect(result.output).toContain("/opsx:ff");
		expect(result.terminal).toBe(false);
	});

	it("should return error for non-existent skill", async () => {
		const registry = new SkillRegistry([]);
		const agent = createAgent(registry);

		const result = await (agent as any).executeTool({
			type: "tool_call",
			id: "tc1",
			name: "read_skill",
			arguments: { name: "nonexistent" },
		});

		expect(result.output).toContain("Skill not found: nonexistent");
		expect(result.terminal).toBe(false);
	});

	it("should return not available when no registry", async () => {
		const agent = createAgent(); // no registry

		const result = await (agent as any).executeTool({
			type: "tool_call",
			id: "tc1",
			name: "read_skill",
			arguments: { name: "openspec" },
		});

		expect(result.output).toContain("not available");
		expect(result.terminal).toBe(false);
	});

	it("should handle skill-registered tool execution via default case", async () => {
		const registry = new SkillRegistry([
			makeSkill({
				name: "risk-analyzer",
				type: "main-agent-tool",
				body: "# Risk Analysis\n\nFollow these steps to analyze risk.",
				tool: {
					name: "analyze_risk",
					description: "Analyze risk",
					parameters: { type: "object", properties: {}, required: [] },
				},
			}),
		]);
		const agent = createAgent(registry);

		const result = await (agent as any).executeTool({
			type: "tool_call",
			id: "tc1",
			name: "analyze_risk",
			arguments: {},
		});

		expect(result.output).toContain("# Risk Analysis");
		expect(result.terminal).toBe(false);
	});
});
