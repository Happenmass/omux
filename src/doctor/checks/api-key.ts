import { resolveProvider } from "../../llm/providers/registry.js";
import { loadConfig } from "../../utils/config.js";
import type { CheckResult } from "../types.js";

const CHECK_NAME = "api-key";

/**
 * Checks that an API key is available for the configured LLM provider.
 *
 * Looks for a key in three places (matching the resolution order in main.ts):
 *   1. Per-provider config: `config.providers[provider].apiKey`
 *   2. Global config: `config.llm.apiKey`
 *   3. Environment variable (e.g. `ANTHROPIC_API_KEY`)
 */
export async function checkApiKey(): Promise<CheckResult> {
	const config = await loadConfig();
	const provider = config.llm.provider;

	if (!provider) {
		return {
			name: CHECK_NAME,
			status: "fail",
			message: "No AI provider configured",
			details: "Set llm.provider in config or run 'omux config'.",
		};
	}

	const providerConfig = resolveProvider(provider);
	const envVar = providerConfig.apiKeyEnvVar;

	// Check all sources (same order as main.ts)
	const configProviderKey = config.providers?.[provider]?.apiKey;
	const configGlobalKey = config.llm.apiKey;
	const envKey = process.env[envVar];

	if (configProviderKey) {
		return {
			name: CHECK_NAME,
			status: "pass",
			message: `API key configured for '${provider}' (from config providers)`,
		};
	}

	if (configGlobalKey) {
		return {
			name: CHECK_NAME,
			status: "pass",
			message: `API key configured for '${provider}' (from config llm.apiKey)`,
		};
	}

	if (envKey) {
		return {
			name: CHECK_NAME,
			status: "pass",
			message: `API key configured for '${provider}' (from ${envVar})`,
		};
	}

	return {
		name: CHECK_NAME,
		status: "fail",
		message: `Missing API key for provider '${provider}'`,
		details: `Set ${envVar} in your environment, or configure it via 'omux config'.`,
	};
}
