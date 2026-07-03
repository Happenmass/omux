import { readdir, stat } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import { logger } from "../utils/logger.js";
import { readSkillDir } from "./reader.js";
import type { SkillEntry } from "./types.js";

const MAX_SKILLS = 50;

export interface DiscoveryOptions {
	adapterSkillsDir?: string;
	workspaceDir?: string;
	/**
	 * Absolute workspace directories whose `.cliclaw/skills/` are trusted to be loaded.
	 * A workspace not in this list has its `.cliclaw/skills/` SKIPPED — those skills would
	 * otherwise steer the orchestrator with system-prompt / tool-result authority. Default [].
	 */
	trustedWorkspaceDirs?: string[];
}

/**
 * Discover skills from adapter-bundled and workspace sources.
 * Workspace skills override adapter-bundled skills with the same name.
 */
export async function discoverSkills(opts: DiscoveryOptions): Promise<SkillEntry[]> {
	const merged = new Map<string, SkillEntry>();

	// Load adapter-bundled skills (low priority)
	if (opts.adapterSkillsDir) {
		const adapterSkills = await scanDirectory(opts.adapterSkillsDir, "adapter");
		for (const skill of adapterSkills) {
			merged.set(skill.name, skill);
		}
	}

	// Load workspace skills (high priority, overrides adapter) — but ONLY from trusted
	// workspaces. Workspace skills execute with orchestrator authority, so a cloned repo's
	// `.cliclaw/skills/` must be explicitly trusted before it can steer the MainAgent.
	if (opts.workspaceDir) {
		const workspaceSkillsDir = join(opts.workspaceDir, ".cliclaw", "skills");
		if (isTrustedWorkspace(opts.workspaceDir, opts.trustedWorkspaceDirs)) {
			const workspaceSkills = await scanDirectory(workspaceSkillsDir, "workspace");
			for (const skill of workspaceSkills) {
				if (merged.has(skill.name)) {
					logger.info("skill-discovery", `Workspace skill "${skill.name}" overrides adapter skill`);
				}
				merged.set(skill.name, skill);
			}
		} else if (await directoryExists(workspaceSkillsDir)) {
			logger.warn(
				"skill-discovery",
				`Skipping untrusted workspace skills at ${workspaceSkillsDir}. Workspace skills run with ` +
					`orchestrator authority; to load them, add "${resolvePath(opts.workspaceDir)}" to ` +
					`skills.trustedWorkspaceDirs in ~/.cliclaw/config.json.`,
			);
		}
	}

	// Enforce max skills limit
	const all = Array.from(merged.values());
	if (all.length > MAX_SKILLS) {
		logger.warn("skill-discovery", `Discovered ${all.length} skills, limiting to ${MAX_SKILLS}`);
		// Prioritize workspace skills, then adapter by alphabetical order
		const workspace = all.filter((s) => s.source === "workspace");
		const adapter = all.filter((s) => s.source === "adapter").sort((a, b) => a.name.localeCompare(b.name));
		const limited = [...workspace, ...adapter].slice(0, MAX_SKILLS);
		return limited;
	}

	return all;
}

async function scanDirectory(dir: string, source: "adapter" | "workspace"): Promise<SkillEntry[]> {
	const entries: SkillEntry[] = [];

	try {
		const dirStat = await stat(dir);
		if (!dirStat.isDirectory()) return entries;
	} catch {
		return entries; // directory doesn't exist
	}

	let items: string[];
	try {
		items = await readdir(dir);
	} catch {
		return entries;
	}

	for (const item of items) {
		const itemPath = join(dir, item);
		try {
			const itemStat = await stat(itemPath);
			if (!itemStat.isDirectory()) continue;
		} catch {
			continue;
		}

		const result = await readSkillDir(itemPath, source);
		if ("entry" in result) {
			entries.push(result.entry);
		} else {
			logger.warn("skill-discovery", `Skipping ${item}: ${result.error}`);
		}
	}

	return entries;
}

async function directoryExists(dir: string): Promise<boolean> {
	try {
		return (await stat(dir)).isDirectory();
	} catch {
		return false;
	}
}

/** Whether a workspace's `.cliclaw/skills/` is trusted to load. Compares resolved absolute paths. */
function isTrustedWorkspace(workspaceDir: string, trusted?: string[]): boolean {
	if (!trusted || trusted.length === 0) return false;
	const target = resolvePath(workspaceDir);
	return trusted.some((t) => resolvePath(t) === target);
}
