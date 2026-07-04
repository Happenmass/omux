import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSkillDir } from "../../src/skills/reader.js";

let tmpDir: string;

describe("readSkillDir", () => {
	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "omux-skill-reader-"));
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	it("should read a valid SKILL.md with frontmatter", async () => {
		const skillDir = join(tmpDir, "openspec");
		await mkdir(skillDir);
		await writeFile(
			join(skillDir, "SKILL.md"),
			`---
name: openspec
description: "Spec-driven dev"
type: agent-capability
commands: [/opsx:new, /opsx:ff]
---

# OpenSpec

Use OpenSpec for structured development.`,
		);

		const result = await readSkillDir(skillDir, "adapter");

		expect("entry" in result).toBe(true);
		if ("entry" in result) {
			expect(result.entry.name).toBe("openspec");
			expect(result.entry.description).toBe("Spec-driven dev");
			expect(result.entry.type).toBe("agent-capability");
			expect(result.entry.commands).toEqual(["/opsx:new", "/opsx:ff"]);
			expect(result.entry.source).toBe("adapter");
			expect(result.entry.body).toContain("# OpenSpec");
			expect(result.entry.body).not.toContain("---");
		}
	});

	it("should use directory name as default name", async () => {
		const skillDir = join(tmpDir, "my-custom-skill");
		await mkdir(skillDir);
		await writeFile(
			join(skillDir, "SKILL.md"),
			`---
type: agent-capability
---

A custom skill that does things.`,
		);

		const result = await readSkillDir(skillDir, "workspace");

		expect("entry" in result).toBe(true);
		if ("entry" in result) {
			expect(result.entry.name).toBe("my-custom-skill");
			expect(result.entry.description).toBe("A custom skill that does things.");
		}
	});

	it("should extract first paragraph as description fallback", async () => {
		const skillDir = join(tmpDir, "test-skill");
		await mkdir(skillDir);
		await writeFile(
			join(skillDir, "SKILL.md"),
			`---
type: prompt-enrichment
---

# Title

This is the first paragraph that should be used as description.

And this is the second paragraph.`,
		);

		const result = await readSkillDir(skillDir, "adapter");

		expect("entry" in result).toBe(true);
		if ("entry" in result) {
			expect(result.entry.description).toBe(
				"This is the first paragraph that should be used as description.",
			);
		}
	});

	it("should return error for missing SKILL.md", async () => {
		const skillDir = join(tmpDir, "empty-dir");
		await mkdir(skillDir);

		const result = await readSkillDir(skillDir, "adapter");

		expect("error" in result).toBe(true);
		if ("error" in result) {
			expect(result.error).toContain("SKILL.md not found");
		}
	});

	it("should return error for oversized SKILL.md", async () => {
		const skillDir = join(tmpDir, "large-skill");
		await mkdir(skillDir);
		await writeFile(join(skillDir, "SKILL.md"), "x".repeat(101 * 1024));

		const result = await readSkillDir(skillDir, "adapter");

		expect("error" in result).toBe(true);
		if ("error" in result) {
			expect(result.error).toContain("exceeds");
		}
	});

	it("should handle SKILL.md without frontmatter", async () => {
		const skillDir = join(tmpDir, "no-fm");
		await mkdir(skillDir);
		await writeFile(join(skillDir, "SKILL.md"), "# Just Markdown\n\nNo frontmatter here.");

		const result = await readSkillDir(skillDir, "workspace");

		expect("entry" in result).toBe(true);
		if ("entry" in result) {
			expect(result.entry.name).toBe("no-fm");
			expect(result.entry.type).toBe("agent-capability"); // default
			expect(result.entry.body).toBe("# Just Markdown\n\nNo frontmatter here.");
		}
	});

	it("should set source correctly", async () => {
		const skillDir = join(tmpDir, "src-test");
		await mkdir(skillDir);
		await writeFile(join(skillDir, "SKILL.md"), "---\ntype: agent-capability\n---\nBody");

		const adapterResult = await readSkillDir(skillDir, "adapter");
		const workspaceResult = await readSkillDir(skillDir, "workspace");

		expect("entry" in adapterResult && adapterResult.entry.source).toBe("adapter");
		expect("entry" in workspaceResult && workspaceResult.entry.source).toBe("workspace");
	});
});
