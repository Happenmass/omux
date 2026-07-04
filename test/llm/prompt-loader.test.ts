import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PromptLoader } from "../../src/llm/prompt-loader.js";
import { logger } from "../../src/utils/logger.js";

describe("PromptLoader", () => {
	let tempDir: string;
	let builtinDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "omux-test-"));
		builtinDir = join(tempDir, "builtin-prompts");
		await mkdir(builtinDir, { recursive: true });

		// Create builtin prompt files for testing
		await writeFile(join(builtinDir, "memory-flush.md"), "Default memory-flush prompt\n\n{{memory}}");
		await writeFile(join(builtinDir, "state-analyzer.md"), "Default state analyzer prompt\n\n{{memory}}");
		await writeFile(join(builtinDir, "error-analyzer.md"), "Default error analyzer prompt\n\n{{memory}}");
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	it("should return built-in defaults when no custom files exist", async () => {
		const loader = new PromptLoader(builtinDir);
		await loader.load(tempDir);

		expect(loader.getRaw("memory-flush")).toBe("Default memory-flush prompt\n\n{{memory}}");
		expect(loader.getRaw("state-analyzer")).toBe("Default state analyzer prompt\n\n{{memory}}");
		expect(loader.getRaw("error-analyzer")).toBe("Default error analyzer prompt\n\n{{memory}}");
	});

	it("should override with project-level .md files", async () => {
		const promptsDir = join(tempDir, ".omux", "prompts");
		await mkdir(promptsDir, { recursive: true });
		await writeFile(join(promptsDir, "memory-flush.md"), "Custom memory-flush prompt");

		const loader = new PromptLoader(builtinDir);
		await loader.load(tempDir);

		expect(loader.getRaw("memory-flush")).toBe("Custom memory-flush prompt");
		// Other prompts should remain default
		expect(loader.getRaw("state-analyzer")).toBe("Default state analyzer prompt\n\n{{memory}}");
	});

	it("should replace template variables in resolve()", async () => {
		const loader = new PromptLoader(builtinDir);
		await loader.load(tempDir);

		const result = loader.resolve("memory-flush", { memory: "some memory content" });
		expect(result).toContain("some memory content");
		expect(result).not.toContain("{{memory}}");
	});

	it("should replace unmatched variables with empty string", async () => {
		const loader = new PromptLoader(builtinDir);
		await loader.load(tempDir);

		const result = loader.resolve("memory-flush");
		expect(result).not.toContain("{{memory}}");
	});

	it("should merge global context via setGlobalContext()", async () => {
		const loader = new PromptLoader(builtinDir);
		await loader.load(tempDir);

		loader.setGlobalContext({ memory: "global memory" });
		const result = loader.resolve("memory-flush");
		expect(result).toContain("global memory");
	});

	it("should prioritize call-time context over global context", async () => {
		const loader = new PromptLoader(builtinDir);
		await loader.load(tempDir);

		loader.setGlobalContext({ memory: "global memory" });
		const result = loader.resolve("memory-flush", { memory: "call-time memory" });
		expect(result).toContain("call-time memory");
		expect(result).not.toContain("global memory");
	});

	it("should return empty string for unknown prompt names", async () => {
		const loader = new PromptLoader(builtinDir);
		await loader.load(tempDir);

		const result = loader.getRaw("nonexistent" as any);
		expect(result).toBe("");
	});

	it("should warn (naming the variable and prompt) but keep replacing unknown vars with empty string", async () => {
		const loader = new PromptLoader(builtinDir);
		await loader.load(tempDir);

		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const result = loader.resolve("memory-flush");
			expect(result).not.toContain("{{memory}}");
			expect(warnSpy).toHaveBeenCalledTimes(1);
			const [module, message] = warnSpy.mock.calls[0];
			expect(module).toBe("prompt-loader");
			expect(message).toContain("memory");
			expect(message).toContain("memory-flush");
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("should not warn when the variable is provided via context", async () => {
		const loader = new PromptLoader(builtinDir);
		await loader.load(tempDir);

		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		try {
			loader.resolve("memory-flush", { memory: "provided" });
			expect(warnSpy).not.toHaveBeenCalled();
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("should return empty string when builtin dir has no files", async () => {
		const emptyDir = join(tempDir, "empty");
		await mkdir(emptyDir, { recursive: true });

		const loader = new PromptLoader(emptyDir);
		await loader.load(tempDir);

		expect(loader.getRaw("memory-flush")).toBe("");
	});

	describe("adapter capabilities", () => {
		it("should load adapter capabilities from adapters/ subdirectory", async () => {
			const adaptersDir = join(builtinDir, "adapters");
			await mkdir(adaptersDir, { recursive: true });
			await writeFile(join(adaptersDir, "claude-code.md"), "Claude Code capabilities");

			const loader = new PromptLoader(builtinDir);
			await loader.load(tempDir);

			expect(loader.loadAdapterCapabilities("claude-code")).toBe("Claude Code capabilities");
		});

		it("should return empty string for unknown adapter", async () => {
			const loader = new PromptLoader(builtinDir);
			await loader.load(tempDir);

			expect(loader.loadAdapterCapabilities("unknown-adapter")).toBe("");
		});

		it("should override builtin adapter capabilities with project-level", async () => {
			// Builtin
			const builtinAdaptersDir = join(builtinDir, "adapters");
			await mkdir(builtinAdaptersDir, { recursive: true });
			await writeFile(join(builtinAdaptersDir, "claude-code.md"), "Builtin capabilities");

			// Project-level override
			const projectAdaptersDir = join(tempDir, ".omux", "prompts", "adapters");
			await mkdir(projectAdaptersDir, { recursive: true });
			await writeFile(join(projectAdaptersDir, "claude-code.md"), "Project capabilities");

			const loader = new PromptLoader(builtinDir);
			await loader.load(tempDir);

			expect(loader.loadAdapterCapabilities("claude-code")).toBe("Project capabilities");
		});

		it("should skip adapters/ if directory does not exist", async () => {
			const loader = new PromptLoader(builtinDir);
			await loader.load(tempDir);

			// Should not throw, just return empty
			expect(loader.loadAdapterCapabilities("claude-code")).toBe("");
		});
	});

	describe("locale-aware resolution", () => {
		beforeEach(async () => {
			await writeFile(join(builtinDir, "memory-flush.cn.md"), "中文 memory-flush 提示\n\n{{memory}}");
		});

		it("picks the .cn.md variant when locale is zh-CN and it exists", async () => {
			const loader = new PromptLoader(builtinDir, "zh-CN");
			await loader.load(tempDir);

			expect(loader.getRaw("memory-flush")).toBe("中文 memory-flush 提示\n\n{{memory}}");
		});

		it("falls back to the plain .md when locale is zh-CN but no .cn.md exists", async () => {
			// state-analyzer.md has no .cn.md sibling in this test fixture set
			const loader = new PromptLoader(builtinDir, "zh-CN");
			await loader.load(tempDir);

			expect(loader.getRaw("state-analyzer")).toBe("Default state analyzer prompt\n\n{{memory}}");
		});

		it("always picks the plain .md under en-US even when a .cn.md sibling exists", async () => {
			const loader = new PromptLoader(builtinDir, "en-US");
			await loader.load(tempDir);

			expect(loader.getRaw("memory-flush")).toBe("Default memory-flush prompt\n\n{{memory}}");
		});

		it("defaults to en-US behavior when no locale is passed", async () => {
			const loader = new PromptLoader(builtinDir);
			await loader.load(tempDir);

			expect(loader.getRaw("memory-flush")).toBe("Default memory-flush prompt\n\n{{memory}}");
		});

		it("interpolates {{variable}}s identically for the .cn.md variant", async () => {
			const loader = new PromptLoader(builtinDir, "zh-CN");
			await loader.load(tempDir);

			const result = loader.resolve("memory-flush", { memory: "一些记忆内容" });
			expect(result).toContain("一些记忆内容");
			expect(result).not.toContain("{{memory}}");
		});

		it("prefers project-level .cn.md over builtin .md under zh-CN", async () => {
			const promptsDir = join(tempDir, ".omux", "prompts");
			await mkdir(promptsDir, { recursive: true });
			await writeFile(join(promptsDir, "memory-flush.cn.md"), "项目级中文 memory-flush");

			const loader = new PromptLoader(builtinDir, "zh-CN");
			await loader.load(tempDir);

			expect(loader.getRaw("memory-flush")).toBe("项目级中文 memory-flush");
		});

		it("reloadIfChanged() picks up edits to the .cn.md file under zh-CN", async () => {
			const loader = new PromptLoader(builtinDir, "zh-CN");
			await loader.load(tempDir);
			expect(loader.getRaw("memory-flush")).toBe("中文 memory-flush 提示\n\n{{memory}}");

			// Bump the .cn.md mtime forward and change its content.
			const future = new Date(Date.now() + 5000);
			await writeFile(join(builtinDir, "memory-flush.cn.md"), "更新后的中文 memory-flush");
			await utimes(join(builtinDir, "memory-flush.cn.md"), future, future);

			loader.reloadIfChanged("memory-flush");
			expect(loader.getRaw("memory-flush")).toBe("更新后的中文 memory-flush");
		});

		it("resolves .cn.md adapter capabilities under zh-CN and falls back to .md when absent", async () => {
			const adaptersDir = join(builtinDir, "adapters");
			await mkdir(adaptersDir, { recursive: true });
			await writeFile(join(adaptersDir, "claude-code.md"), "Claude Code capabilities (en)");
			await writeFile(join(adaptersDir, "claude-code.cn.md"), "Claude Code 能力说明 (中文)");
			await writeFile(join(adaptersDir, "codex.md"), "Codex capabilities (en only)");

			const zhLoader = new PromptLoader(builtinDir, "zh-CN");
			await zhLoader.load(tempDir);
			expect(zhLoader.loadAdapterCapabilities("claude-code")).toBe("Claude Code 能力说明 (中文)");
			expect(zhLoader.loadAdapterCapabilities("codex")).toBe("Codex capabilities (en only)");

			const enLoader = new PromptLoader(builtinDir, "en-US");
			await enLoader.load(tempDir);
			expect(enLoader.loadAdapterCapabilities("claude-code")).toBe("Claude Code capabilities (en)");
		});
	});
});
