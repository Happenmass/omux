import type { ProviderConfig } from "../types.js";

/** Built-in provider configurations */
export const BUILTIN_PROVIDERS: ProviderConfig[] = [
	// ─── OpenAI ──────────────────────────────────────────
	{
		name: "openai",
		displayName: "OpenAI",
		protocol: "openai-compatible",
		baseUrl: "https://api.openai.com/v1",
		apiKeyEnvVar: "OPENAI_API_KEY",
		defaultModel: "gpt-5.4",
		models: ["gpt-5.4", "gpt-5.2", "gpt-4.1", "gpt-4.1-mini", "o3", "o3-pro", "o4-mini"],
	},

	// ─── Anthropic ───────────────────────────────────────
	{
		name: "anthropic",
		displayName: "Anthropic",
		protocol: "anthropic",
		baseUrl: "https://api.anthropic.com",
		apiKeyEnvVar: "ANTHROPIC_API_KEY",
		defaultModel: "claude-sonnet-4-6",
		models: ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"],
	},

	// ─── OpenRouter ──────────────────────────────────────
	{
		name: "openrouter",
		displayName: "OpenRouter",
		protocol: "openai-compatible",
		baseUrl: "https://openrouter.ai/api/v1",
		apiKeyEnvVar: "OPENROUTER_API_KEY",
		defaultModel: "openai/gpt-5.4",
		models: [
			"anthropic/claude-opus-4-6",
			"anthropic/claude-sonnet-4-6",
			"openai/gpt-5.4",
			"google/gemini-2.5-flash",
			"deepseek/deepseek-chat",
		],
	},

	// ─── Moonshot (Kimi) ─────────────────────────────────
	{
		name: "moonshot",
		displayName: "Moonshot (Kimi)",
		protocol: "openai-compatible",
		baseUrl: "https://api.moonshot.cn/v1",
		apiKeyEnvVar: "MOONSHOT_API_KEY",
		defaultModel: "kimi-k2.5",
		models: ["kimi-k2.5", "kimi-k2-thinking", "kimi-k2-thinking-turbo", "moonshot-v1-auto"],
	},

	// ─── MiniMax ─────────────────────────────────────────
	{
		name: "minimax",
		displayName: "MiniMax",
		protocol: "openai-compatible",
		baseUrl: "https://api.minimax.chat/v1",
		apiKeyEnvVar: "MINIMAX_API_KEY",
		defaultModel: "MiniMax-M2.5",
		models: ["MiniMax-M2.5", "MiniMax-M2.5-highspeed", "MiniMax-M2.1"],
	},

	// ─── DeepSeek ────────────────────────────────────────
	{
		name: "deepseek",
		displayName: "DeepSeek",
		protocol: "openai-compatible",
		baseUrl: "https://api.deepseek.com/v1",
		apiKeyEnvVar: "DEEPSEEK_API_KEY",
		defaultModel: "deepseek-chat",
		models: ["deepseek-chat", "deepseek-reasoner"],
	},

	// ─── Groq ────────────────────────────────────────────
	{
		name: "groq",
		displayName: "Groq",
		protocol: "openai-compatible",
		baseUrl: "https://api.groq.com/openai/v1",
		apiKeyEnvVar: "GROQ_API_KEY",
		defaultModel: "llama-3.3-70b-versatile",
		models: [
			"llama-3.3-70b-versatile",
			"llama-3.1-8b-instant",
			"meta-llama/llama-4-scout-17b-16e-instruct",
			"qwen/qwen3-32b",
		],
	},

	// ─── Together AI ─────────────────────────────────────
	{
		name: "together",
		displayName: "Together AI",
		protocol: "openai-compatible",
		baseUrl: "https://api.together.xyz/v1",
		apiKeyEnvVar: "TOGETHER_API_KEY",
		defaultModel: "meta-llama/Llama-4-Scout-17B-16E-Instruct",
	},

	// ─── xAI (Grok) ─────────────────────────────────────
	{
		name: "xai",
		displayName: "xAI (Grok)",
		protocol: "openai-compatible",
		baseUrl: "https://api.x.ai/v1",
		apiKeyEnvVar: "XAI_API_KEY",
		defaultModel: "grok-4-1-fast-reasoning",
		models: [
			"grok-4-1-fast-reasoning",
			"grok-4-1-fast-non-reasoning",
			"grok-4-fast-reasoning",
			"grok-3",
			"grok-3-mini",
		],
	},

	// ─── Google Gemini (OpenAI compat) ───────────────────
	{
		name: "gemini",
		displayName: "Google Gemini",
		protocol: "openai-compatible",
		baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
		apiKeyEnvVar: "GEMINI_API_KEY",
		defaultModel: "gemini-2.5-flash",
		models: ["gemini-2.5-flash", "gemini-3-flash-preview", "gemini-3.1-pro-preview", "gemini-3.1-flash-lite-preview"],
	},

	// ─── Mistral ─────────────────────────────────────────
	{
		name: "mistral",
		displayName: "Mistral",
		protocol: "openai-compatible",
		baseUrl: "https://api.mistral.ai/v1",
		apiKeyEnvVar: "MISTRAL_API_KEY",
		defaultModel: "mistral-large-latest",
		models: [
			"mistral-large-latest",
			"mistral-small-latest",
			"codestral-latest",
			"magistral-medium-latest",
			"devstral-2-25-12",
		],
	},

	// ─── Ollama (local) ──────────────────────────────────
	{
		name: "ollama",
		displayName: "Ollama (Local)",
		protocol: "openai-compatible",
		baseUrl: "http://localhost:11434/v1",
		apiKeyEnvVar: "OLLAMA_API_KEY", // Usually "ollama" or empty
		defaultModel: "llama4",
	},
];

const providerMap = new Map<string, ProviderConfig>();

// Initialize with builtins
for (const p of BUILTIN_PROVIDERS) {
	providerMap.set(p.name, p);
}

export function getProvider(name: string): ProviderConfig | undefined {
	return providerMap.get(name);
}

export function getAllProviders(): ProviderConfig[] {
	return Array.from(providerMap.values());
}

export function registerProvider(config: ProviderConfig): void {
	providerMap.set(config.name, config);
}

/**
 * Resolve a provider by name, with optional overrides.
 * Also supports passing a custom baseUrl directly (creates an ad-hoc openai-compatible provider).
 */
export function resolveProvider(name: string, overrides?: { baseUrl?: string; apiKey?: string }): ProviderConfig {
	const config = getProvider(name);

	if (config) {
		return {
			...config,
			...(overrides?.baseUrl ? { baseUrl: overrides.baseUrl } : {}),
		};
	}

	// Unknown provider — treat as custom OpenAI-compatible endpoint
	return {
		name,
		displayName: name,
		protocol: "openai-compatible",
		baseUrl: overrides?.baseUrl || `https://api.${name}.com/v1`,
		apiKeyEnvVar: `${name.toUpperCase().replace(/-/g, "_")}_API_KEY`,
		defaultModel: "default",
	};
}
