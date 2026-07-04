import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	SECTION_MAP,
	appendToPersistentMemory,
	ensurePersistentMemoryFile,
	loadPersistentMemory,
	readPersistentMemory,
	updatePersistentMemory,
} from "../../src/memory/persistent.js";

describe("persistent memory", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "persistent-memory-test-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	// ─── SECTION_MAP ────────────────────────────────────

	describe("SECTION_MAP", () => {
		it("should have all 5 sections", () => {
			expect(Object.keys(SECTION_MAP)).toHaveLength(5);
			expect(SECTION_MAP.user_profile).toBe("User Profile");
			expect(SECTION_MAP.project_conventions).toBe("Project Conventions");
			expect(SECTION_MAP.key_decisions).toBe("Key Decisions");
			expect(SECTION_MAP.people_and_context).toBe("People & Context");
			expect(SECTION_MAP.active_notes).toBe("Active Notes");
		});
	});

	// ─── ensurePersistentMemoryFile ─────────────────────

	describe("ensurePersistentMemoryFile", () => {
		it("should create file with template when it does not exist", async () => {
			const filePath = join(tempDir, "sub", "MEMORY.md");
			await ensurePersistentMemoryFile(filePath);

			const content = await readFile(filePath, "utf-8");
			expect(content).toContain("# Memory");
			expect(content).toContain("## User Profile");
			expect(content).toContain("## Project Conventions");
			expect(content).toContain("## Key Decisions");
			expect(content).toContain("## People & Context");
			expect(content).toContain("## Active Notes");
		});

		it("should not overwrite existing file", async () => {
			const filePath = join(tempDir, "MEMORY.md");
			await writeFile(filePath, "custom content");

			await ensurePersistentMemoryFile(filePath);

			const content = await readFile(filePath, "utf-8");
			expect(content).toBe("custom content");
		});
	});

	// ─── readPersistentMemory ───────────────────────────

	describe("readPersistentMemory", () => {
		it("should return file content when file exists", async () => {
			const filePath = join(tempDir, "MEMORY.md");
			await writeFile(filePath, "hello world");

			const content = await readPersistentMemory(filePath);
			expect(content).toBe("hello world");
		});

		it("should return empty string when file does not exist", async () => {
			const content = await readPersistentMemory(join(tempDir, "nonexistent.md"));
			expect(content).toBe("");
		});
	});

	// ─── loadPersistentMemory ───────────────────────────

	describe("loadPersistentMemory", () => {
		it("should return global MEMORY.md content", async () => {
			const globalDir = join(tempDir, "global");
			await mkdir(globalDir, { recursive: true });
			await writeFile(join(globalDir, "MEMORY.md"), "# Memory\n\n## User Profile\n- Chinese replies\n");

			const result = await loadPersistentMemory(globalDir);
			expect(result).toContain("Chinese replies");
			// No merge markers — project memory is no longer injected here.
			expect(result).not.toContain("<!-- global memory -->");
			expect(result).not.toContain("<!-- project memory -->");
		});

		it("should ignore project-level MEMORY.md even if it exists", async () => {
			const globalDir = join(tempDir, "global");
			const workspaceDir = join(tempDir, "workspace");
			await mkdir(globalDir, { recursive: true });
			await mkdir(join(workspaceDir, ".omux"), { recursive: true });
			await writeFile(join(globalDir, "MEMORY.md"), "# Memory\n\n## User Profile\n- Global content\n");
			await writeFile(
				join(workspaceDir, ".omux", "MEMORY.md"),
				"# Memory\n\n## Project Conventions\n- Project content\n",
			);

			const result = await loadPersistentMemory(globalDir);
			expect(result).toContain("Global content");
			expect(result).not.toContain("Project content");
		});

		it("should return empty string when global does not exist", async () => {
			const result = await loadPersistentMemory(join(tempDir, "a"));
			expect(result).toBe("");
		});
	});

	// ─── updatePersistentMemory ─────────────────────────

	describe("updatePersistentMemory", () => {
		const memoryContent = `# Memory

## User Profile

## Project Conventions
- Use Biome
- ESM modules

## Key Decisions

## People & Context

## Active Notes
- Working on auth
`;

		describe("append", () => {
			it("should append entry to a section", async () => {
				const filePath = join(tempDir, "MEMORY.md");
				await writeFile(filePath, memoryContent);

				const result = await updatePersistentMemory({
					filePath,
					section: "user_profile",
					operation: "append",
					content: "Prefers Chinese replies",
				});

				expect(result).toContain("## User Profile\n- Prefers Chinese replies\n");
			});

			it("should append to section with existing entries", async () => {
				const filePath = join(tempDir, "MEMORY.md");
				await writeFile(filePath, memoryContent);

				const result = await updatePersistentMemory({
					filePath,
					section: "project_conventions",
					operation: "append",
					content: "Tab indent width 3",
				});

				expect(result).toContain("- Use Biome");
				expect(result).toContain("- ESM modules");
				expect(result).toContain("- Tab indent width 3");
			});

			it("should auto-add date prefix for key_decisions", async () => {
				const filePath = join(tempDir, "MEMORY.md");
				await writeFile(filePath, memoryContent);

				const result = await updatePersistentMemory({
					filePath,
					section: "key_decisions",
					operation: "append",
					content: "Use Redis for caching",
				});

				const today = new Date().toISOString().slice(0, 10);
				expect(result).toContain(`- [${today}] Use Redis for caching`);
			});

			it("should create file if it does not exist", async () => {
				const filePath = join(tempDir, "new", "MEMORY.md");

				await updatePersistentMemory({
					filePath,
					section: "active_notes",
					operation: "append",
					content: "First note",
				});

				const content = await readFile(filePath, "utf-8");
				expect(content).toContain("- First note");
			});
		});

		describe("remove", () => {
			it("should remove matching entry from a section", async () => {
				const filePath = join(tempDir, "MEMORY.md");
				await writeFile(filePath, memoryContent);

				const result = await updatePersistentMemory({
					filePath,
					section: "project_conventions",
					operation: "remove",
					content: "Biome",
				});

				expect(result).not.toContain("Use Biome");
				expect(result).toContain("ESM modules");
			});

			it("should throw when no matching entry found", async () => {
				const filePath = join(tempDir, "MEMORY.md");
				await writeFile(filePath, memoryContent);

				await expect(
					updatePersistentMemory({
						filePath,
						section: "project_conventions",
						operation: "remove",
						content: "nonexistent",
					}),
				).rejects.toThrow('No entry matching "nonexistent"');
			});
		});

		describe("replace", () => {
			it("should replace entire section content", async () => {
				const filePath = join(tempDir, "MEMORY.md");
				await writeFile(filePath, memoryContent);

				const result = await updatePersistentMemory({
					filePath,
					section: "project_conventions",
					operation: "replace",
					content: "- Completely new content\n- Another line",
				});

				expect(result).not.toContain("Use Biome");
				expect(result).not.toContain("ESM modules");
				expect(result).toContain("- Completely new content");
				expect(result).toContain("- Another line");
				// Other sections should be untouched
				expect(result).toContain("## User Profile");
				expect(result).toContain("- Working on auth");
			});
		});

		it("should throw on unknown section", async () => {
			const filePath = join(tempDir, "MEMORY.md");
			await writeFile(filePath, memoryContent);

			await expect(
				updatePersistentMemory({
					filePath,
					section: "nonexistent_section",
					operation: "append",
					content: "test",
				}),
			).rejects.toThrow('Unknown section: "nonexistent_section"');
		});
	});

	// ─── appendToPersistentMemory ────────────────────────

	describe("appendToPersistentMemory", () => {
		it("should append to active_notes section", async () => {
			const filePath = join(tempDir, "MEMORY.md");
			await ensurePersistentMemoryFile(filePath);

			await appendToPersistentMemory(filePath, "active_notes", "Remember this");

			const content = await readFile(filePath, "utf-8");
			expect(content).toContain("## Active Notes\n- Remember this\n");
		});
	});
});
