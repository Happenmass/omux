import { describe, it, expect } from "vitest";
import { type AdapterCapabilityInput, buildAgentCapabilitiesSection, buildCapabilitiesSummary } from "../../src/skills/injector.js";
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
		body: "Body",
		...overrides,
	};
}

const BASE = "Direct code editing and file operations\nRunning terminal commands";

describe("buildCapabilitiesSummary", () => {
	it("should include base capabilities and skill entries", () => {
		const skills = [
			makeSkill({ name: "openspec", description: "Spec-driven dev", commands: ["/opsx:new", "/opsx:ff"] }),
			makeSkill({ name: "commit", description: "Git commits", commands: ["/commit"] }),
		];

		const summary = buildCapabilitiesSummary(BASE, skills);

		expect(summary).toContain("Direct code editing and file operations");
		expect(summary).toContain("Running terminal commands");
		expect(summary).toContain("**openspec** — Spec-driven dev");
		expect(summary).toContain("Commands: /opsx:new, /opsx:ff");
		expect(summary).toContain("**commit** — Git commits");
		expect(summary).toContain('read_skill("openspec")');
	});

	it("should only include base capabilities when no skills", () => {
		const summary = buildCapabilitiesSummary(BASE, []);

		expect(summary).toContain("Direct code editing");
		expect(summary).not.toContain("Available Skills");
	});

	it("should exclude main-agent-tool from summary", () => {
		const skills = [
			makeSkill({ name: "visible", type: "agent-capability" }),
			makeSkill({ name: "hidden", type: "main-agent-tool" }),
		];

		const summary = buildCapabilitiesSummary(BASE, skills);

		expect(summary).toContain("**visible**");
		expect(summary).not.toContain("**hidden**");
	});

	it("should include prompt-enrichment in summary", () => {
		const skills = [
			makeSkill({ name: "conventions", type: "prompt-enrichment", commands: [] }),
		];

		const summary = buildCapabilitiesSummary(BASE, skills);

		expect(summary).toContain("**conventions**");
	});

	it("should omit commands line when no commands", () => {
		const skills = [
			makeSkill({ name: "no-cmds", commands: [] }),
		];

		const summary = buildCapabilitiesSummary(BASE, skills);

		expect(summary).toContain("**no-cmds**");
		expect(summary).not.toContain("Commands:");
	});

	it("should truncate when exceeding 2000 char budget", () => {
		// Create many skills with long descriptions
		const skills = Array.from({ length: 30 }, (_, i) =>
			makeSkill({
				name: `skill-${i}`,
				description: "A".repeat(100),
				commands: [`/cmd-${i}`],
			}),
		);

		const summary = buildCapabilitiesSummary(BASE, skills);

		expect(summary.length).toBeLessThanOrEqual(2100); // some tolerance for truncation notice
		expect(summary).toContain("more skills available via read_skill");
	});

	it("should not show truncation notice when all fit", () => {
		const skills = [makeSkill({ name: "small", description: "tiny" })];

		const summary = buildCapabilitiesSummary(BASE, skills);

		expect(summary).not.toContain("more skills available");
	});
});

describe("buildAgentCapabilitiesSection", () => {
	function adapter(overrides: Partial<AdapterCapabilityInput> = {}): AdapterCapabilityInput {
		return {
			name: "claude-code",
			displayName: "Claude Code",
			capabilities: "- edits files\n- runs commands",
			isDefault: true,
			...overrides,
		};
	}

	it("renders a single adapter without orchestration preamble", () => {
		const section = buildAgentCapabilitiesSection([adapter()], []);

		expect(section).toContain('### Claude Code — `adapter: "claude-code"` (default)');
		expect(section).toContain("- edits files");
		expect(section).not.toContain("coding-agent adapters");
		expect(section).not.toContain("Multi-Agent Orchestration");
	});

	it("adds adapter selection preamble and orchestration block for multiple adapters", () => {
		const section = buildAgentCapabilitiesSection(
			[
				adapter(),
				adapter({ name: "codex", displayName: "Codex", capabilities: "- reviews code", isDefault: false }),
			],
			[],
		);

		expect(section).toContain("2 coding-agent adapters");
		expect(section).toContain('`claude-code` (default)');
		expect(section).toContain("### Multi-Agent Orchestration");
		// claude-code + codex present → the execute-then-review playbook is used
		expect(section).toContain("full implementers");
		expect(section).toContain("execute with Claude Code, review with Codex");
		expect(section).toContain("Choose by task-fit");
	});

	it("marks the default adapter and not the others", () => {
		const section = buildAgentCapabilitiesSection(
			[
				adapter({ name: "codex", displayName: "Codex", isDefault: true }),
				adapter({ name: "claude-code", displayName: "Claude Code", isDefault: false }),
			],
			[],
		);

		expect(section).toContain('### Codex — `adapter: "codex"` (default)');
		expect(section).toContain('### Claude Code — `adapter: "claude-code"`');
		expect(section).not.toContain('### Claude Code — `adapter: "claude-code"` (default)');
	});

	it("falls back to default capability text when an adapter provides none", () => {
		const section = buildAgentCapabilitiesSection([adapter({ capabilities: "" })], []);

		expect(section).toContain("Direct code editing and file operations");
	});
});
