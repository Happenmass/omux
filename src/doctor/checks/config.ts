import { readFile } from "node:fs/promises";
import { getConfigFilePath } from "../../utils/config.js";
import type { CheckResult } from "../types.js";

const CHECK_NAME = "config-valid";

/**
 * Validates the Omux configuration file.
 *
 * Checks that `~/.omux/config.json` exists, contains valid JSON,
 * and includes the required `llm.provider` and `llm.model` fields.
 * A missing config file is treated as a warning (defaults will be used).
 */
export async function checkConfig(): Promise<CheckResult> {
	const configPath = getConfigFilePath();

	let raw: string;
	try {
		raw = await readFile(configPath, "utf-8");
	} catch (err: unknown) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			return {
				name: CHECK_NAME,
				status: "warning",
				message: `Config file not found at ${configPath}`,
				details: "Default configuration will be used. Run 'omux config' to create one.",
			};
		}
		if (code === "EACCES") {
			return {
				name: CHECK_NAME,
				status: "fail",
				message: "Permission denied reading config",
				details: `Check file permissions on ${configPath}`,
			};
		}
		const msg = err instanceof Error ? err.message : String(err);
		return {
			name: CHECK_NAME,
			status: "fail",
			message: `Failed to read config: ${msg}`,
		};
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return {
			name: CHECK_NAME,
			status: "fail",
			message: "Invalid JSON format",
			details: `Fix the syntax in ${configPath}`,
		};
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return {
			name: CHECK_NAME,
			status: "fail",
			message: "Config must be a JSON object",
		};
	}

	const config = parsed as Record<string, unknown>;
	const llm = config.llm;

	if (typeof llm !== "object" || llm === null || Array.isArray(llm)) {
		return {
			name: CHECK_NAME,
			status: "fail",
			message: "Config missing required field: llm",
			details: "The 'llm' section with provider and model is required.",
		};
	}

	const llmObj = llm as Record<string, unknown>;

	for (const field of ["provider", "model"] as const) {
		const value = llmObj[field];
		if (typeof value !== "string" || value === "") {
			return {
				name: CHECK_NAME,
				status: "fail",
				message: `Config missing required field: ${field}`,
				details: `Set llm.${field} in ${configPath}`,
			};
		}
	}

	const provider = llmObj.provider as string;
	const model = llmObj.model as string;

	return {
		name: CHECK_NAME,
		status: "pass",
		message: `Config file valid (provider: ${provider}, model: ${model})`,
	};
}
