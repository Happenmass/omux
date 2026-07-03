import type { ToolDefinition } from "../../llm/types.js";
import {
	createAgent,
	inspectAgent,
	interruptAgent,
	killAgent,
	listAgents,
	respondToAgent,
	sendToAgent,
	waitForAgents,
} from "./agent-tools.js";
import { memoryEdit, memoryGet, memorySearch, memoryWriteAlias, persistentMemory } from "./memory-tools.js";
import { escalateToHuman, execCommand, markFailed, readSkill } from "./misc-tools.js";
import type { ToolHandler } from "./types.js";

export type { ToolContext, ToolHandler } from "./types.js";

/**
 * Built-in tool handlers in wire order. TOOL_DEFINITIONS is derived from this list,
 * so the order the model sees mirrors the order here. `memory_write` is intentionally
 * absent — it's a dispatch-only alias for `memory_edit` (never surfaced to the LLM).
 */
const BUILTIN_HANDLERS: ToolHandler[] = [
	sendToAgent,
	respondToAgent,
	interruptAgent,
	inspectAgent,
	markFailed,
	escalateToHuman,
	memorySearch,
	memoryGet,
	memoryEdit,
	readSkill,
	createAgent,
	listAgents,
	killAgent,
	persistentMemory,
	execCommand,
	waitForAgents,
];

/** Dispatch-only aliases: registered in the handler map but excluded from TOOL_DEFINITIONS. */
const ALIAS_HANDLERS: ToolHandler[] = [memoryWriteAlias];

/** Tool definitions exposed to the LLM, in wire order (excludes dispatch-only aliases). */
export const TOOL_DEFINITIONS: ToolDefinition[] = BUILTIN_HANDLERS.map((h) => h.definition);

/**
 * Build the name → handler dispatch map used by MainAgent.executeTool. Includes the
 * dispatch-only aliases (e.g. memory_write) so the loop can route them, matching the
 * old switch's `case "memory_edit": case "memory_write":` fall-through.
 */
export function buildToolHandlers(): Map<string, ToolHandler> {
	const map = new Map<string, ToolHandler>();
	for (const handler of [...BUILTIN_HANDLERS, ...ALIAS_HANDLERS]) {
		map.set(handler.definition.name, handler);
	}
	return map;
}
