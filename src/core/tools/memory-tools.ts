import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildCategoryPathFilter } from "../../memory/category.js";
import { readPersistentMemory, updatePersistentMemory, validateProjectDir } from "../../memory/persistent.js";
import { searchMemory } from "../../memory/search.js";
import type { MemoryCategory } from "../../memory/types.js";
import { logger } from "../../utils/logger.js";
import type { ToolContext, ToolHandler } from "./types.js";

export const memorySearch: ToolHandler = {
	definition: {
		name: "memory_search",
		description:
			"Search project memory for relevant information. Use this before answering questions about prior work, decisions, dates, people, preferences, or todos.",
		parameters: {
			type: "object",
			properties: {
				query: { type: "string", description: "Search query text (natural language)" },
				maxResults: { type: "number", description: "Maximum results to return (default 10)" },
				minScore: { type: "number", description: "Minimum relevance score 0-1 (default 0.1)" },
				category: {
					type: "string",
					description: 'Optional category filter: "core", "preferences", "people", "todos", "daily", "topic"',
				},
			},
			required: ["query"],
		},
	},
	async execute(args: Record<string, any>, ctx: ToolContext) {
		if (!ctx.memoryStore) {
			return { output: "Memory store not available.", terminal: false };
		}
		const query = args.query as string;
		const maxResults = args.maxResults as number | undefined;
		const minScore = args.minScore as number | undefined;
		const category = args.category as MemoryCategory | undefined;

		try {
			let categoryPathFilter: string[] | undefined;
			if (category) {
				const trackedPaths = ctx.memoryStore.getTrackedFilePaths();
				categoryPathFilter = buildCategoryPathFilter(category, trackedPaths);
			}

			const results = await searchMemory(ctx.memoryStore, query, ctx.embeddingProvider, ctx.searchConfig, {
				maxResults,
				minScore,
				categoryPathFilter,
			});

			if (results.length === 0) {
				return { output: "No memory results found for this query.", terminal: false };
			}

			const formatted = results
				.map(
					(r, i) =>
						`[${i + 1}] ${r.path}:${r.startLine}-${r.endLine} (score: ${r.score.toFixed(3)})\n${r.snippet.slice(0, 300)}`,
				)
				.join("\n\n");

			return { output: formatted, terminal: false };
		} catch (err: any) {
			logger.warn("main-agent", `memory_search failed: ${err.message}`);
			return { output: `Memory search error: ${err.message}`, terminal: false };
		}
	},
};

export const memoryGet: ToolHandler = {
	definition: {
		name: "memory_get",
		description:
			"Read a specific memory file. Returns at most 500 lines by default (hard cap 2000). The output starts with a metadata header showing `lines X-Y/total | N bytes`; when truncated, the trailer tells you the exact `from=` to pass next call to continue. Use after memory_search to read full context around a search hit, and page through large files instead of asking for one giant blob.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: 'Relative path (e.g. "memory/core.md")' },
				from: { type: "number", description: "1-indexed start line (default 1)" },
				lines: { type: "number", description: "Number of lines to read (default 500, max 2000)" },
			},
			required: ["path"],
		},
	},
	async execute(args: Record<string, any>, ctx: ToolContext) {
		if (!ctx.memoryStore) {
			return { output: "Memory store not available.", terminal: false };
		}
		const rawPath = args.path as string;
		const fromArg = args.from as number | undefined;
		const lineCountArg = args.lines as number | undefined;
		let storageDir: string;
		let memGetPath: string;
		try {
			({ storageDir, relativePath: memGetPath } = ctx.resolveMemoryGetTarget(rawPath));
		} catch (err: any) {
			return { output: `Memory get error: ${err.message}`, terminal: false };
		}

		const DEFAULT_LIMIT = 500;
		const HARD_LIMIT = 2000;

		try {
			const absPath = join(storageDir, memGetPath);
			const content = await readFile(absPath, "utf-8");
			const allLines = content.split("\n");
			const totalLines = allLines.length;
			const totalBytes = Buffer.byteLength(content, "utf-8");

			const from = Math.max(1, fromArg ?? 1);
			const requested = lineCountArg ?? DEFAULT_LIMIT;
			const limit = Math.min(Math.max(1, requested), HARD_LIMIT);

			const startIdx = from - 1;
			if (startIdx >= totalLines) {
				return {
					output: `[file: ${memGetPath} | ${totalLines} lines / ${totalBytes} bytes]\n[from=${from} is past EOF (file has ${totalLines} lines)]`,
					terminal: false,
				};
			}

			const slice = allLines.slice(startIdx, startIdx + limit);
			const endLine = startIdx + slice.length;
			const header = `[file: ${memGetPath} | lines ${from}-${endLine}/${totalLines} | ${totalBytes} bytes]`;
			const trailer =
				endLine < totalLines
					? `\n\n[Truncated. ${totalLines - endLine} more lines. Call memory_get again with from=${endLine + 1} to continue.]`
					: "";

			return { output: `${header}\n${slice.join("\n")}${trailer}`, terminal: false };
		} catch (err: any) {
			if (err.code === "ENOENT") {
				return { output: `File not found: ${rawPath}`, terminal: false };
			}
			return { output: `Error reading file: ${err.message}`, terminal: false };
		}
	},
};

export const memoryEdit: ToolHandler = {
	definition: {
		name: "memory_edit",
		description:
			"Edit a file in the SEARCHABLE memory store (memory/*.md, indexed for memory_search / memory_get). Supports append (default), overwrite, search-and-replace, and delete. Only memory/*.md files are allowed. This is NOT the always-in-prompt MEMORY.md — to edit the global/project MEMORY.md snapshot, use persistent_memory.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: 'Relative path (e.g. "memory/core.md")' },
				content: { type: "string", description: "Content to write (for append/overwrite/replace)" },
				mode: {
					type: "string",
					enum: ["append", "overwrite", "replace", "delete"],
					description: "Edit mode (default: append)",
				},
				match: {
					type: "string",
					description: "Text to find for replace/delete operations. Must be an exact match in the file.",
				},
			},
			required: ["path"],
		},
	},
	async execute(args: Record<string, any>, ctx: ToolContext) {
		if (!ctx.memoryStore) {
			return { output: "Memory store not available.", terminal: false };
		}
		const editPath = args.path as string;
		const editContent = args.content as string | undefined;
		const editMode = (args.mode as "append" | "overwrite" | "replace" | "delete") ?? "append";
		const editMatch = args.match as string | undefined;

		try {
			const result = await ctx.memoryStore.edit({
				path: editPath,
				content: editContent,
				mode: editMode,
				match: editMatch,
			});
			if (ctx.syncMemory) {
				try {
					await ctx.syncMemory();
				} catch (err: any) {
					return {
						output: `Edited ${result.path} successfully. Warning: memory sync failed: ${err.message}`,
						terminal: false,
					};
				}
			}
			return { output: `Edited ${result.path} successfully (${editMode}).`, terminal: false };
		} catch (err: any) {
			return { output: `Memory edit error: ${err.message}`, terminal: false };
		}
	},
};

/**
 * Backwards-compatible alias: `memory_write` dispatches to the same handler as
 * `memory_edit` (the old switch had `case "memory_edit": case "memory_write":`).
 * The definition carries the alias name so it's registered in the dispatch map,
 * but it is NOT surfaced to the LLM (only memory_edit is in TOOL_DEFINITIONS).
 */
export const memoryWriteAlias: ToolHandler = {
	definition: { ...memoryEdit.definition, name: "memory_write" },
	execute: memoryEdit.execute,
};

export const persistentMemory: ToolHandler = {
	definition: {
		name: "persistent_memory",
		description:
			"Read or update a persistent MEMORY.md file. (This is the ALWAYS-in-system-prompt memory; for the separate searchable memory/*.md store use memory_edit / memory_search.) Global scope (`~/.cliclaw/MEMORY.md`) is loaded into your system prompt under {{memory}} ONCE per session and is intentionally NOT hot-reloaded after writes — this keeps the system prompt byte-stable for prompt-cache hits. The {{memory}} snapshot is refreshed only at /clear, /compact, or /reset. So a successful `update` writes to disk immediately (authoritative), but your in-prompt view stays as it was at session start; rely on this tool's return value (and on `read` calls) to confirm effects, not on the system prompt changing. Project scope (`<project_dir>/.cliclaw/MEMORY.md`) is NEVER in your system prompt — it's surfaced to you only when you `create_agent` against that project, so you can decide what to forward to the sub-agent. Use this when the user asks you to remember/forget something, or when you need to review current memories. When scope is 'project', you MUST pass project_dir (absolute path to the project root) — cliclaw runs as a global service, so the agent owns the choice of which project receives the write.",
		parameters: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: ["read", "update"],
					description: "read: return current MEMORY.md content. update: add/modify/remove entries.",
				},
				scope: {
					type: "string",
					enum: ["project", "global"],
					description: "project: workspace-level (requires project_dir). global: ~/.cliclaw/. Default: project.",
				},
				project_dir: {
					type: "string",
					description:
						"Absolute path to the project root. REQUIRED when scope='project'. Must be an existing directory containing a project marker (.git, package.json, pyproject.toml, .cliclaw, etc.). Use exec_command to verify the path first if unsure. Ignored when scope='global'.",
				},
				section: {
					type: "string",
					enum: ["user_profile", "project_conventions", "key_decisions", "people_and_context", "active_notes"],
					description: "Target section. Required when action is update.",
				},
				operation: {
					type: "string",
					enum: ["append", "remove", "replace"],
					description:
						"append: add entry. remove: delete matching entry. replace: rewrite section. Default: append.",
				},
				content: {
					type: "string",
					description: "The memory content to write/match/replace.",
				},
			},
			required: ["action"],
		},
	},
	async execute(args: Record<string, any>, ctx: ToolContext) {
		const action = args.action as string;
		const scope = (args.scope as string) ?? "project";

		let filePath: string;
		let resolvedProjectDir: string | undefined;

		if (scope === "global") {
			filePath = join(ctx.globalDir, "MEMORY.md");
		} else {
			const projectDir = args.project_dir as string | undefined;
			if (!projectDir) {
				return {
					output:
						"Error: 'project_dir' is required when scope='project'. Pass the absolute path to the project root (the directory containing .git/package.json/pyproject.toml/etc.). Use exec_command to confirm the path before retrying.",
					terminal: false,
				};
			}
			const validation = await validateProjectDir(projectDir);
			if (!validation.ok) {
				const reason =
					validation.reason === "not_absolute"
						? `must be an absolute path, got: ${validation.detail}`
						: validation.reason === "not_found"
							? `directory does not exist: ${validation.detail}`
							: validation.reason === "not_directory"
								? `path exists but is not a directory: ${validation.detail}`
								: `no project marker (.git, package.json, pyproject.toml, .cliclaw, etc.) found in ${validation.detail}`;
				return {
					output: `Error: invalid project_dir — ${reason}. Verify the path with exec_command first.`,
					terminal: false,
				};
			}
			resolvedProjectDir = projectDir;
			filePath = join(projectDir, ".cliclaw", "MEMORY.md");
		}

		try {
			if (action === "read") {
				const content = await readPersistentMemory(filePath);
				if (!content) {
					const where = scope === "global" ? "global scope" : `project ${resolvedProjectDir}`;
					return { output: `No MEMORY.md found at ${where}.`, terminal: false };
				}
				return { output: content, terminal: false };
			}

			// action === "update"
			const section = args.section as string;
			const operation = (args.operation as "append" | "remove" | "replace") ?? "append";
			const content = args.content as string;

			if (!section) {
				return { output: "Error: 'section' is required for update action.", terminal: false };
			}
			if (!content) {
				return { output: "Error: 'content' is required for update action.", terminal: false };
			}

			await updatePersistentMemory({ filePath, section, operation, content });

			// IMPORTANT: do NOT hot-reload {{memory}} into the system prompt here.
			// Rewriting the prompt prefix mid-session invalidates the model's prompt
			// cache and burns tokens. The on-disk MEMORY.md is the source of truth;
			// the in-prompt {{memory}} snapshot is taken once at session start and
			// only refreshed at explicit cache-invalidation breakpoints (/clear,
			// /compact, /reset). Until then, the agent learns the effect of the
			// write from this tool's return value, not from a prompt change.
			let suffix: string;
			if (scope === "global") {
				suffix =
					"Wrote to ~/.cliclaw/MEMORY.md. The system prompt's {{memory}} snapshot is intentionally NOT refreshed this turn (prompt-cache stability); on-disk content is now authoritative and the snapshot will be reloaded on the next /clear, /compact, or /reset.";
			} else {
				suffix = `Wrote to ${resolvedProjectDir}/.cliclaw/MEMORY.md; current session memory not modified (project memory is loaded by create_agent, not the system prompt).`;
			}

			const target = scope === "global" ? "global" : (resolvedProjectDir ?? "project");
			return {
				output: `Persistent memory updated (${target}/${section}/${operation}). ${suffix}`,
				terminal: false,
			};
		} catch (err: any) {
			return { output: `Persistent memory error: ${err.message}`, terminal: false };
		}
	},
};
