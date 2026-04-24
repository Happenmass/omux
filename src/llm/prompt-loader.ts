import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type PromptName =
	| "planner"
	| "state-analyzer"
	| "error-analyzer"
	| "session-summarizer"
	| "main-agent"
	| "history-compressor"
	| "memory-flush"
	| "memory-tidy"
	| "learning-summary"
	| "learning-chat"
	| "learning-memory";

const PROMPT_FILE_MAP: Record<PromptName, string> = {
	planner: "planner.md",
	"state-analyzer": "state-analyzer.md",
	"error-analyzer": "error-analyzer.md",
	"session-summarizer": "session-summarizer.md",
	"main-agent": "main-agent.md",
	"history-compressor": "history-compressor.md",
	"memory-flush": "memory-flush.md",
	"memory-tidy": "memory-tidy.md",
	"learning-summary": "learning-summary.md",
	"learning-chat": "learning-chat.md",
	"learning-memory": "learning-memory.md",
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_BUILTIN_DIR = join(__dirname, "..", "..", "prompts");

export class PromptLoader {
	private prompts: Map<string, string> = new Map();
	private adapterCapabilities: Map<string, string> = new Map();
	private globalContext: Record<string, string> = {};
	private builtinDir: string;

	constructor(builtinDir?: string) {
		this.builtinDir = builtinDir ?? DEFAULT_BUILTIN_DIR;
	}

	async load(projectDir?: string): Promise<void> {
		// Layer 1: Built-in defaults from package's prompts/ directory
		await this.loadFromDir(this.builtinDir);

		// Layer 2: User-level overrides (~/.cliclaw/prompts/*.md)
		const userPromptsDir = join(homedir(), ".cliclaw", "prompts");
		await this.loadFromDir(userPromptsDir);

		// Layer 3: Project-level overrides ({project}/.cliclaw/prompts/*.md)
		if (projectDir) {
			const projectPromptsDir = join(projectDir, ".cliclaw", "prompts");
			await this.loadFromDir(projectPromptsDir);
		}
	}

	resolve(name: PromptName, context?: Record<string, string>): string {
		const raw = this.prompts.get(name) ?? "";
		const mergedContext = { ...this.globalContext, ...context };
		return this.replaceVars(raw, mergedContext);
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
			try {
				const content = await readFile(join(dir, fileName), "utf-8");
				this.prompts.set(name, content.trim());
			} catch {
				// File doesn't exist — skip silently
			}
		}

		// Scan adapters/ subdirectory
		const adaptersDir = join(dir, "adapters");
		try {
			const entries = await readdir(adaptersDir);
			for (const entry of entries) {
				if (!entry.endsWith(".md")) continue;
				const name = basename(entry, ".md");
				const content = await readFile(join(adaptersDir, entry), "utf-8");
				this.adapterCapabilities.set(name, content.trim());
			}
		} catch {
			// adapters/ directory doesn't exist — skip silently
		}
	}

	private replaceVars(template: string, context: Record<string, string>): string {
		return template.replace(/\{\{(\w[\w-]*)\}\}/g, (_match, varName) => {
			return context[varName] ?? "";
		});
	}
}
