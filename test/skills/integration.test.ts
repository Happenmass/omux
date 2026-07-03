import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolDefinition } from "../../src/llm/types.js";
import { discoverSkills } from "../../src/skills/discovery.js";
import { filterSkills } from "../../src/skills/filter.js";
import { buildCapabilitiesSummary } from "../../src/skills/injector.js";
import { SkillRegistry } from "../../src/skills/registry.js";
import { mergeSkillTools } from "../../src/skills/tool-merge.js";

let tmpDir: string;

const BUILTIN_TOOLS: ToolDefinition[] = [
	{
		name: "send_to_agent",
		description: "Send instruction",
		parameters: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] },
	},
];

describe("Skill System Integration", () => {
	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "cliclaw-skill-integration-"));
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	it("should complete full flow: discover → filter → inject → registry", async () => {
		// Setup adapter skills
		const adapterDir = join(tmpDir, "adapter-skills");
		await mkdir(join(adapterDir, "openspec"), { recursive: true });
		await writeFile(
			join(adapterDir, "openspec", "SKILL.md"),
			`---
name: openspec
description: "Spec-driven development"
type: agent-capability
commands: [/opsx:new, /opsx:ff, /opsx:apply]
---

# OpenSpec

Detailed OpenSpec instructions.`,
		);

		await mkdir(join(adapterDir, "commit"), { recursive: true });
		await writeFile(
			join(adapterDir, "commit", "SKILL.md"),
			`---
name: commit
description: "Git commits"
type: agent-capability
commands: [/commit]
---

# Commit

How to use commit.`,
		);

		// Setup workspace skill
		const workspaceDir = tmpDir;
		await mkdir(join(workspaceDir, ".cliclaw", "skills", "deploy"), { recursive: true });
		await writeFile(
			join(workspaceDir, ".cliclaw", "skills", "deploy", "SKILL.md"),
			`---
name: deploy
description: "Deployment automation"
type: agent-capability
commands: [/deploy]
when:
  files: ["Dockerfile"]
---

# Deploy

Deployment instructions.`,
		);

		// Step 1: Discover
		const discovered = await discoverSkills({
			adapterSkillsDir: adapterDir,
			workspaceDir,
			trustedWorkspaceDirs: [workspaceDir],
		});
		expect(discovered).toHaveLength(3);

		// Step 2: Filter (deploy should be filtered — no Dockerfile)
		const filtered = filterSkills(discovered, {}, workspaceDir);
		expect(filtered).toHaveLength(2); // openspec + commit (deploy filtered by missing Dockerfile)
		expect(filtered.map((s) => s.name).sort()).toEqual(["commit", "openspec"]);

		// Step 3: Inject
		const summary = buildCapabilitiesSummary("Code editing\nTerminal commands", filtered);
		expect(summary).toContain("Code editing");
		expect(summary).toContain("**openspec** — Spec-driven development");
		expect(summary).toContain("**commit** — Git commits");
		expect(summary).toContain("Commands: /opsx:new, /opsx:ff, /opsx:apply");
		expect(summary).toContain('read_skill("openspec")');

		// Step 4: Registry
		const registry = new SkillRegistry(filtered);
		expect(registry.size).toBe(2);
		expect(registry.getByName("openspec")?.body).toContain("# OpenSpec");
		expect(registry.getByName("commit")?.commands).toEqual(["/commit"]);
	});

	it("should handle workspace override + main-agent-tool registration", async () => {
		// Adapter has commit skill
		const adapterDir = join(tmpDir, "adapter-skills");
		await mkdir(join(adapterDir, "commit"), { recursive: true });
		await writeFile(
			join(adapterDir, "commit", "SKILL.md"),
			`---\nname: commit\ntype: agent-capability\ndescription: "adapter commit"\ncommands: [/commit]\n---\nAdapter commit.`,
		);

		// Workspace overrides commit
		const workspaceDir = tmpDir;
		await mkdir(join(workspaceDir, ".cliclaw", "skills", "commit"), { recursive: true });
		await writeFile(
			join(workspaceDir, ".cliclaw", "skills", "commit", "SKILL.md"),
			`---\nname: commit\ntype: agent-capability\ndescription: "custom commit"\ncommands: [/commit, /commit:amend]\n---\nCustom commit.`,
		);

		// Workspace also has a main-agent-tool
		await mkdir(join(workspaceDir, ".cliclaw", "skills", "risk"), { recursive: true });
		await writeFile(
			join(workspaceDir, ".cliclaw", "skills", "risk", "SKILL.md"),
			`---
name: risk
type: main-agent-tool
description: "Risk analyzer"
tool:
  name: analyze_risk
  description: "Analyze task risk"
  parameters: {"type":"object","properties":{"task":{"type":"string"}},"required":["task"]}
---

# Risk Analysis

Steps to analyze risk.`,
		);

		const discovered = await discoverSkills({
			adapterSkillsDir: adapterDir,
			workspaceDir,
			trustedWorkspaceDirs: [workspaceDir],
		});
		const filtered = filterSkills(discovered, {}, workspaceDir);
		const registry = new SkillRegistry(filtered);

		// Override worked
		expect(registry.getByName("commit")?.description).toBe("custom commit");
		expect(registry.getByName("commit")?.commands).toEqual(["/commit", "/commit:amend"]);

		// Tool registered
		expect(registry.getByToolName("analyze_risk")?.name).toBe("risk");

		// Tool merge
		const mergedTools = mergeSkillTools(BUILTIN_TOOLS, filtered);
		expect(mergedTools).toHaveLength(2); // builtin + analyze_risk
		expect(mergedTools[1].name).toBe("analyze_risk");

		// Summary excludes main-agent-tool
		const summary = buildCapabilitiesSummary("Base", filtered);
		expect(summary).toContain("**commit**");
		expect(summary).not.toContain("**risk**"); // main-agent-tool excluded from summary
	});
});
