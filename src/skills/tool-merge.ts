import type { ToolDefinition } from "../llm/types.js";
import { logger } from "../utils/logger.js";
import type { SkillEntry } from "./types.js";

/**
 * Extract ToolDefinitions from main-agent-tool skills and merge with built-in tools.
 * Rejects skill tools that collide with built-in tool names.
 */
export function mergeSkillTools(builtinTools: ToolDefinition[], skills: SkillEntry[]): ToolDefinition[] {
	// Tracks every accepted tool name — built-ins plus already-merged skill tools — so a second
	// skill declaring the same tool name is rejected instead of silently emitting a duplicate
	// ToolDefinition on the wire (some providers 400 on duplicate tool names).
	const seenNames = new Set(builtinTools.map((t) => t.name));
	const merged = [...builtinTools];

	for (const skill of skills) {
		if (skill.type !== "main-agent-tool" || !skill.tool) continue;

		if (seenNames.has(skill.tool.name)) {
			logger.warn(
				"skill-tools",
				`Skill "${skill.name}" tried to register tool "${skill.tool.name}" which collides with an already-registered tool. Skipping.`,
			);
			continue;
		}

		seenNames.add(skill.tool.name);
		merged.push({
			name: skill.tool.name,
			description: skill.tool.description,
			parameters: skill.tool.parameters,
		});
	}

	return merged;
}
