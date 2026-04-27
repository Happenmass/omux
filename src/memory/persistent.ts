import { access, appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

// ─── Constants ──────────────────────────────────────────

export const SECTION_MAP: Record<string, string> = {
	user_profile: "User Profile",
	project_conventions: "Project Conventions",
	key_decisions: "Key Decisions",
	people_and_context: "People & Context",
	active_notes: "Active Notes",
};

const TEMPLATE = `# Memory

## User Profile

## Project Conventions

## Key Decisions

## People & Context

## Active Notes
`;

// ─── Project Root Validation ────────────────────────────

const PROJECT_MARKERS = [
	".git",
	".cliclaw",
	"package.json",
	"pyproject.toml",
	"Cargo.toml",
	"go.mod",
	"pom.xml",
	"build.gradle",
	"build.gradle.kts",
	"composer.json",
	"Gemfile",
	"mix.exs",
	"CMakeLists.txt",
];

export type ProjectRootValidation =
	| { ok: true }
	| { ok: false; reason: "not_absolute" | "not_found" | "not_directory" | "no_marker"; detail: string };

/**
 * Validate that a path is an absolute, existing directory containing a
 * recognizable project marker (`.git`, `package.json`, `.cliclaw`, ...).
 * Used by `persistent_memory` to prevent the agent from writing to the
 * wrong directory when it supplies an explicit `project_dir`.
 */
export async function validateProjectDir(dir: string): Promise<ProjectRootValidation> {
	if (!isAbsolute(dir)) {
		return { ok: false, reason: "not_absolute", detail: dir };
	}
	try {
		await access(dir);
	} catch {
		return { ok: false, reason: "not_found", detail: dir };
	}
	try {
		const st = await stat(dir);
		if (!st.isDirectory()) {
			return { ok: false, reason: "not_directory", detail: dir };
		}
	} catch {
		return { ok: false, reason: "not_found", detail: dir };
	}
	for (const marker of PROJECT_MARKERS) {
		try {
			await access(join(dir, marker));
			return { ok: true };
		} catch {
			// keep looking
		}
	}
	return { ok: false, reason: "no_marker", detail: dir };
}

// ─── Read Operations ────────────────────────────────────

/**
 * Read a single MEMORY.md file. Returns empty string if the file does not exist.
 */
export async function readPersistentMemory(filePath: string): Promise<string> {
	try {
		return await readFile(filePath, "utf-8");
	} catch (err: any) {
		if (err.code === "ENOENT") return "";
		throw err;
	}
}

/**
 * Load and merge global + project-level MEMORY.md files.
 * Returns the merged content for injection into {{memory}}.
 *
 * @param globalDir  ~/.cliclaw/
 * @param workspaceDir  project root (e.g. /path/to/project)
 */
export async function loadPersistentMemory(globalDir: string, workspaceDir: string): Promise<string> {
	const globalPath = join(globalDir, "MEMORY.md");
	const projectPath = join(workspaceDir, ".cliclaw", "MEMORY.md");

	const [globalContent, projectContent] = await Promise.all([
		readPersistentMemory(globalPath),
		readPersistentMemory(projectPath),
	]);

	const hasGlobal = globalContent.trim().length > 0;
	const hasProject = projectContent.trim().length > 0;

	if (hasGlobal && hasProject) {
		return `<!-- global memory -->\n${globalContent.trim()}\n\n---\n\n<!-- project memory -->\n${projectContent.trim()}`;
	}
	if (hasGlobal) return globalContent.trim();
	if (hasProject) return projectContent.trim();
	return "";
}

// ─── Write Operations ───────────────────────────────────

/**
 * Ensure a MEMORY.md file exists at the given path.
 * Creates the directory and file with the default template if missing.
 */
export async function ensurePersistentMemoryFile(filePath: string): Promise<void> {
	try {
		await access(filePath);
	} catch {
		await mkdir(dirname(filePath), { recursive: true });
		await writeFile(filePath, TEMPLATE, "utf-8");
	}
}

/**
 * Update a section of a MEMORY.md file.
 *
 * @returns The full file content after the update (for hot-reload).
 */
export async function updatePersistentMemory(params: {
	filePath: string;
	section: string;
	operation: "append" | "remove" | "replace";
	content: string;
}): Promise<string> {
	const { filePath, section, operation, content } = params;

	const sectionTitle = SECTION_MAP[section];
	if (!sectionTitle) {
		throw new Error(`Unknown section: "${section}". Valid sections: ${Object.keys(SECTION_MAP).join(", ")}`);
	}

	await ensurePersistentMemoryFile(filePath);
	const raw = await readFile(filePath, "utf-8");

	const updated = applySectionUpdate(raw, sectionTitle, operation, content, section);
	await writeFile(filePath, updated, "utf-8");
	return updated;
}

/**
 * Simplified append function for CLI `cliclaw remember`.
 */
export async function appendToPersistentMemory(filePath: string, section: string, content: string): Promise<void> {
	await updatePersistentMemory({ filePath, section, operation: "append", content });
}

// ─── Internal Helpers ───────────────────────────────────

/**
 * Parse a MEMORY.md file into sections.
 * Each section is { title, startLine, endLine, lines }.
 */
interface ParsedSection {
	title: string;
	headerLineIdx: number;
	contentLines: string[];
}

function parseSections(raw: string): { preamble: string[]; sections: ParsedSection[] } {
	const lines = raw.split("\n");
	const sections: ParsedSection[] = [];
	const preamble: string[] = [];
	let currentSection: ParsedSection | null = null;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line.startsWith("## ")) {
			if (currentSection) {
				sections.push(currentSection);
			}
			currentSection = {
				title: line.replace(/^## /, "").trim(),
				headerLineIdx: i,
				contentLines: [],
			};
		} else if (currentSection) {
			currentSection.contentLines.push(line);
		} else {
			preamble.push(line);
		}
	}
	if (currentSection) {
		sections.push(currentSection);
	}

	return { preamble, sections };
}

function rebuildFile(preamble: string[], sections: ParsedSection[]): string {
	const parts: string[] = [];

	if (preamble.length > 0) {
		parts.push(preamble.join("\n"));
	}

	for (const section of sections) {
		parts.push(`## ${section.title}`);
		if (section.contentLines.length > 0) {
			parts.push(section.contentLines.join("\n"));
		}
	}

	let result = parts.join("\n");
	// Ensure trailing newline
	if (!result.endsWith("\n")) {
		result += "\n";
	}
	return result;
}

function applySectionUpdate(
	raw: string,
	sectionTitle: string,
	operation: "append" | "remove" | "replace",
	content: string,
	sectionKey: string,
): string {
	const { preamble, sections } = parseSections(raw);
	const target = sections.find((s) => s.title === sectionTitle);

	if (!target) {
		throw new Error(`Section "## ${sectionTitle}" not found in MEMORY.md`);
	}

	switch (operation) {
		case "append": {
			let entry = `- ${content}`;
			if (sectionKey === "key_decisions") {
				const today = new Date().toISOString().slice(0, 10);
				entry = `- [${today}] ${content}`;
			}

			// Find last non-empty line to insert after
			const trimmedEnd = trimTrailingEmpty(target.contentLines);
			trimmedEnd.push(entry);
			trimmedEnd.push(""); // blank line after entry
			target.contentLines = trimmedEnd;
			break;
		}
		case "remove": {
			const beforeLen = target.contentLines.length;
			target.contentLines = target.contentLines.filter((line) => !(line.startsWith("- ") && line.includes(content)));
			if (target.contentLines.length === beforeLen) {
				throw new Error(`No entry matching "${content}" found in ## ${sectionTitle}`);
			}
			break;
		}
		case "replace": {
			target.contentLines = [content, ""];
			break;
		}
	}

	return rebuildFile(preamble, sections);
}

/**
 * Remove trailing empty lines from an array, return a new array.
 */
function trimTrailingEmpty(lines: string[]): string[] {
	const result = [...lines];
	while (result.length > 0 && result[result.length - 1].trim() === "") {
		result.pop();
	}
	return result;
}
