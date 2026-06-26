import type { SkillFrontmatter, SkillToolDef, SkillType, WhenCondition } from "./types.js";

const VALID_TYPES: SkillType[] = ["agent-capability", "main-agent-tool", "prompt-enrichment"];

/**
 * Parse a SKILL.md file content into frontmatter and body.
 * Uses lightweight regex + line parsing — no yaml dependency.
 */
export function parseSkillFile(content: string): { frontmatter: Partial<SkillFrontmatter>; body: string } {
	const normalized = content.replace(/\r\n|\r/g, "\n");

	if (!normalized.startsWith("---")) {
		return { frontmatter: {}, body: normalized.trim() };
	}

	const endIndex = normalized.indexOf("\n---", 3);
	if (endIndex === -1) {
		return { frontmatter: {}, body: normalized.trim() };
	}

	const block = normalized.slice(4, endIndex);
	const body = normalized.slice(endIndex + 4).trim();
	const frontmatter = parseFrontmatterBlock(block);

	return { frontmatter, body };
}

function parseFrontmatterBlock(block: string): Partial<SkillFrontmatter> {
	const result: Partial<SkillFrontmatter> = {};
	const lines = block.split("\n");

	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		const colonIdx = line.indexOf(":");
		if (colonIdx <= 0) {
			i++;
			continue;
		}

		const key = line.slice(0, colonIdx).trim();
		const value = line.slice(colonIdx + 1).trim();

		switch (key) {
			case "name":
				result.name = unquote(value);
				break;

			case "description":
				result.description = unquote(value);
				break;

			case "type": {
				const t = unquote(value) as SkillType;
				if (VALID_TYPES.includes(t)) {
					result.type = t;
				}
				break;
			}

			case "commands": {
				// Inline array: commands: [/commit, /review]
				if (value.startsWith("[")) {
					result.commands = parseInlineArray(value);
				} else if (value === "") {
					// Block list: collect indented lines starting with "- "
					const items: string[] = [];
					i++;
					while (i < lines.length && /^\s+- /.test(lines[i])) {
						items.push(unquote(lines[i].replace(/^\s+- /, "").trim()));
						i++;
					}
					result.commands = items;
					continue; // skip i++ at bottom
				}
				break;
			}

			case "when": {
				if (value === "") {
					// Block: parse nested keys
					const when: WhenCondition = {};
					i++;
					while (i < lines.length && /^\s+\w/.test(lines[i])) {
						const nestedColonIdx = lines[i].indexOf(":");
						if (nestedColonIdx > 0) {
							const nKey = lines[i].slice(0, nestedColonIdx).trim();
							const nVal = lines[i].slice(nestedColonIdx + 1).trim();
							if (nKey === "files" || nKey === "os" || nKey === "env") {
								when[nKey] = parseInlineArray(nVal);
							}
						}
						i++;
					}
					result.when = when;
					continue;
				}
				break;
			}

			case "tool": {
				if (value === "") {
					// Block: collect indented lines as a mini-object
					const toolLines: string[] = [];
					i++;
					while (i < lines.length && /^\s+/.test(lines[i])) {
						toolLines.push(lines[i]);
						i++;
					}
					result.tool = parseToolBlock(toolLines);
					continue;
				}
				break;
			}
		}

		i++;
	}

	return result;
}

/** Parse inline array like `[/commit, /review]` or `["darwin", "linux"]` */
function parseInlineArray(value: string): string[] {
	const inner = value.replace(/^\[/, "").replace(/\]$/, "").trim();
	if (!inner) return [];
	return inner
		.split(",")
		.map((s) => unquote(s.trim()))
		.filter(Boolean);
}

/** Remove surrounding quotes */
function unquote(s: string): string {
	if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
		return s.slice(1, -1);
	}
	return s;
}

/** Parse a tool block from indented lines */
function parseToolBlock(lines: string[]): SkillToolDef | null {
	const map: Record<string, string> = {};
	for (const line of lines) {
		const colonIdx = line.indexOf(":");
		if (colonIdx <= 0) continue;
		const key = line.slice(0, colonIdx).trim();
		const val = line.slice(colonIdx + 1).trim();
		map[key] = val;
	}

	if (!map.name || !map.description) return null;

	let parameters: SkillToolDef["parameters"] = { type: "object", properties: {}, required: [] };
	if (map.parameters) {
		try {
			parameters = JSON.parse(map.parameters);
		} catch {
			// keep default empty parameters
		}
	}

	return {
		name: unquote(map.name),
		description: unquote(map.description),
		parameters,
	};
}
