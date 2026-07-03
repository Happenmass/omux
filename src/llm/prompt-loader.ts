import { readFileSync, statSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getConfigDir } from "../utils/config.js";
import type { SupportedLocale } from "../utils/locale.js";
import { logger } from "../utils/logger.js";

export type PromptName =
	| "state-analyzer"
	| "error-analyzer"
	| "main-agent"
	| "history-compressor"
	| "memory-flush"
	| "memory-tidy"
	| "learning-summary"
	| "learning-chat"
	| "learning-memory"
	| "auto-continue";

const PROMPT_FILE_MAP: Record<PromptName, string> = {
	"state-analyzer": "state-analyzer.md",
	"error-analyzer": "error-analyzer.md",
	"main-agent": "main-agent.md",
	"history-compressor": "history-compressor.md",
	"memory-flush": "memory-flush.md",
	"memory-tidy": "memory-tidy.md",
	"learning-summary": "learning-summary.md",
	"learning-chat": "learning-chat.md",
	"learning-memory": "learning-memory.md",
	"auto-continue": "auto-continue.md",
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_BUILTIN_DIR = join(__dirname, "..", "..", "prompts");

export class PromptLoader {
	private prompts: Map<string, string> = new Map();
	private adapterCapabilities: Map<string, string> = new Map();
	private globalContext: Record<string, string> = {};
	private builtinDir: string;
	private projectDir?: string;
	private locale: SupportedLocale;
	// mtime cache for hot-reload (per prompt name): tracks the mtime of the
	// last-read file across layered dirs, so we skip disk reads when nothing changed.
	private mtimeCache: Map<string, number> = new Map();

	constructor(builtinDir?: string, locale?: SupportedLocale) {
		this.builtinDir = builtinDir ?? DEFAULT_BUILTIN_DIR;
		this.locale = locale ?? "en-US";
	}

	/** Update the active locale (e.g. after a config change). Takes effect on the next load()/reload. */
	setLocale(locale: SupportedLocale): void {
		this.locale = locale;
	}

	/**
	 * Candidate file names for `fileName`, most-preferred first.
	 * Under zh-CN, prefer the sibling `<name>.cn.md` and fall back to `<name>.md`.
	 */
	private candidateFileNames(fileName: string): string[] {
		if (this.locale !== "zh-CN") return [fileName];
		const cnFileName = fileName.replace(/\.md$/, ".cn.md");
		return [cnFileName, fileName];
	}

	async load(projectDir?: string): Promise<void> {
		this.projectDir = projectDir;

		// Layer 1: Built-in defaults from package's prompts/ directory
		await this.loadFromDir(this.builtinDir);

		// Layer 2: User-level overrides (~/.cliclaw/prompts/*.md)
		const userPromptsDir = join(getConfigDir(), "prompts");
		await this.loadFromDir(userPromptsDir);

		// Layer 3: Project-level overrides ({project}/.cliclaw/prompts/*.md)
		if (projectDir) {
			const projectPromptsDir = join(projectDir, ".cliclaw", "prompts");
			await this.loadFromDir(projectPromptsDir);
		}

		// Seed mtime cache so the first reloadIfChanged() call doesn't always re-read.
		for (const name of Object.keys(PROMPT_FILE_MAP) as PromptName[]) {
			const mtime = this.latestMtime(name);
			if (mtime !== undefined) this.mtimeCache.set(name, mtime);
		}
	}

	/**
	 * Re-read a single prompt from disk if any layered file's mtime changed.
	 * Synchronous so it can be called from getSystemPrompt() on every render.
	 * Layered precedence (project > user > builtin) is preserved.
	 * Failures are swallowed — caller falls back to the cached version.
	 */
	reloadIfChanged(name: PromptName): void {
		const fileName = PROMPT_FILE_MAP[name];
		if (!fileName) return;

		const mtime = this.latestMtime(name);
		if (mtime === undefined) return;
		if (this.mtimeCache.get(name) === mtime) return;

		const dirs = this.layeredDirs();
		const candidates = this.candidateFileNames(fileName);
		let content: string | undefined;
		for (const dir of dirs) {
			for (const candidate of candidates) {
				try {
					content = readFileSync(join(dir, candidate), "utf-8");
					break;
				} catch {
					// File missing in this layer — skip
				}
			}
		}
		if (content !== undefined) {
			this.prompts.set(name, content.trim());
			this.mtimeCache.set(name, mtime);
		}
	}

	private layeredDirs(): string[] {
		const dirs = [this.builtinDir, join(getConfigDir(), "prompts")];
		if (this.projectDir) dirs.push(join(this.projectDir, ".cliclaw", "prompts"));
		return dirs;
	}

	/** Max mtime (ms) across layered files (all locale candidates) for `name`, or undefined if none exist. */
	private latestMtime(name: PromptName): number | undefined {
		const fileName = PROMPT_FILE_MAP[name];
		if (!fileName) return undefined;
		let latest: number | undefined;
		for (const dir of this.layeredDirs()) {
			for (const candidate of this.candidateFileNames(fileName)) {
				try {
					const mtime = statSync(join(dir, candidate)).mtimeMs;
					if (latest === undefined || mtime > latest) latest = mtime;
				} catch {
					// Missing in this layer
				}
			}
		}
		return latest;
	}

	resolve(name: PromptName, context?: Record<string, string>): string {
		const raw = this.prompts.get(name) ?? "";
		const mergedContext = { ...this.globalContext, ...context };
		return this.replaceVars(raw, mergedContext, name);
	}

	setGlobalContext(ctx: Record<string, string>): void {
		this.globalContext = { ...this.globalContext, ...ctx };
	}

	getRaw(name: PromptName): string {
		return this.prompts.get(name) ?? "";
	}

	loadAdapterCapabilities(name: string): string {
		return this.adapterCapabilities.get(name) ?? "";
	}

	private async loadFromDir(dir: string): Promise<void> {
		for (const [name, fileName] of Object.entries(PROMPT_FILE_MAP)) {
			for (const candidate of this.candidateFileNames(fileName)) {
				try {
					const content = await readFile(join(dir, candidate), "utf-8");
					this.prompts.set(name, content.trim());
					break;
				} catch {
					// File doesn't exist — skip silently, try next candidate
				}
			}
		}

		// Scan adapters/ subdirectory
		const adaptersDir = join(dir, "adapters");
		try {
			const entries = await readdir(adaptersDir);
			const entrySet = new Set(entries);
			for (const entry of entries) {
				if (!entry.endsWith(".md")) continue;
				const isCn = entry.endsWith(".cn.md");
				const name = isCn ? basename(entry, ".cn.md") : basename(entry, ".md");
				if (this.locale === "zh-CN") {
					// Skip the plain .md if a .cn.md sibling exists for this name —
					// the .cn.md entry is preferred regardless of readdir order.
					if (!isCn && entrySet.has(`${name}.cn.md`)) continue;
				} else if (isCn) {
					// en-US never uses .cn.md variants
					continue;
				}
				const content = await readFile(join(adaptersDir, entry), "utf-8");
				this.adapterCapabilities.set(name, content.trim());
			}
		} catch {
			// adapters/ directory doesn't exist — skip silently
		}
	}

	private replaceVars(template: string, context: Record<string, string>, promptName?: string): string {
		return template.replace(/\{\{(\w[\w-]*)\}\}/g, (_match, varName) => {
			if (!(varName in context)) {
				logger.warn(
					"prompt-loader",
					`Unknown template variable {{${varName}}} in prompt "${promptName ?? "unknown"}" — replaced with empty string`,
				);
			}
			return context[varName] ?? "";
		});
	}
}
