import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filterSkills } from "../../src/skills/filter.js";
import type { SkillEntry } from "../../src/skills/types.js";

let tmpDir: string;

function makeSkill(overrides: Partial<SkillEntry> = {}): SkillEntry {
	return {
		name: "test-skill",
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

describe("filterSkills", () => {
	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "omux-filter-"));
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	it("should pass through skills with no when-conditions and no disable list", () => {
		const skills = [makeSkill({ name: "a" }), makeSkill({ name: "b" })];
		const result = filterSkills(skills, {}, tmpDir);
		expect(result).toHaveLength(2);
	});

	it("should filter out disabled skills", () => {
		const skills = [makeSkill({ name: "keep" }), makeSkill({ name: "remove" })];
		const result = filterSkills(skills, { disabled: ["remove"] }, tmpDir);
		expect(result).toHaveLength(1);
		expect(result[0].name).toBe("keep");
	});

	it("should filter out skills when file condition fails", () => {
		const skills = [
			makeSkill({ name: "needs-file", when: { files: ["package.json"] } }),
		];
		// tmpDir doesn't have package.json
		const result = filterSkills(skills, {}, tmpDir);
		expect(result).toHaveLength(0);
	});

	it("should pass skills when file condition succeeds", async () => {
		await writeFile(join(tmpDir, ".openspec.yaml"), "version: 1");
		const skills = [
			makeSkill({ name: "openspec", when: { files: [".openspec.yaml"] } }),
		];
		const result = filterSkills(skills, {}, tmpDir);
		expect(result).toHaveLength(1);
	});

	it("should filter by OS condition", () => {
		const currentOs = process.platform;
		const otherOs = currentOs === "darwin" ? "win32" : "darwin";

		const skills = [
			makeSkill({ name: "current-os", when: { os: [currentOs] } }),
			makeSkill({ name: "other-os", when: { os: [otherOs] } }),
		];
		const result = filterSkills(skills, {}, tmpDir);
		expect(result).toHaveLength(1);
		expect(result[0].name).toBe("current-os");
	});

	it("should filter by env condition", () => {
		// PATH is always set
		const skills = [
			makeSkill({ name: "has-path", when: { env: ["PATH"] } }),
			makeSkill({ name: "needs-missing", when: { env: ["OMUX_TEST_NONEXISTENT_VAR_12345"] } }),
		];
		const result = filterSkills(skills, {}, tmpDir);
		expect(result).toHaveLength(1);
		expect(result[0].name).toBe("has-path");
	});

	it("should require ALL when-conditions to pass", async () => {
		await writeFile(join(tmpDir, "exists.txt"), "");
		const skills = [
			makeSkill({
				name: "multi-condition",
				when: {
					files: ["exists.txt"],
					os: ["nonexistent-os"],
				},
			}),
		];
		const result = filterSkills(skills, {}, tmpDir);
		expect(result).toHaveLength(0);
	});

	it("should apply disable list before when-conditions", () => {
		// Even if when-conditions would pass, disabled skill is filtered
		const skills = [
			makeSkill({ name: "disabled-but-passing", when: null }),
		];
		const result = filterSkills(skills, { disabled: ["disabled-but-passing"] }, tmpDir);
		expect(result).toHaveLength(0);
	});

	it("should handle empty disabled list", () => {
		const skills = [makeSkill({ name: "a" })];
		const result = filterSkills(skills, { disabled: [] }, tmpDir);
		expect(result).toHaveLength(1);
	});

	it("should handle empty skills array", () => {
		const result = filterSkills([], {}, tmpDir);
		expect(result).toHaveLength(0);
	});
});
