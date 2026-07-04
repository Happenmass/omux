import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { OmuxConfig } from "../../../src/utils/config.js";

const DEFAULT_CONFIG: OmuxConfig = {
	defaultAgent: "claude-code",
	llm: {
		provider: "anthropic",
		model: "claude-sonnet-4-6",
	},
	stateDetector: {
		pollIntervalMs: 2000,
		stableThresholdMs: 10000,
		captureLines: 50,
	},
	tmux: {
		sessionPrefix: "omux",
	},
};

const loadConfigMock = vi.fn<() => Promise<OmuxConfig>>();

vi.mock("../../../src/utils/config.js", () => ({
	loadConfig: (...args: unknown[]) => loadConfigMock(...(args as [])),
}));

// Don't mock the registry — resolveProvider works fine with its real BUILTIN_PROVIDERS data

import { checkApiKey } from "../../../src/doctor/checks/api-key.js";

describe("checkApiKey", () => {
	const savedEnv: Record<string, string | undefined> = {};

	beforeEach(() => {
		vi.clearAllMocks();
		// Save and clean relevant env vars
		for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "DEEPSEEK_API_KEY"]) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
	});

	afterEach(() => {
		// Restore env vars
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	});

	it("should return pass when API key is in environment variable", async () => {
		loadConfigMock.mockResolvedValue({ ...DEFAULT_CONFIG, llm: { provider: "anthropic", model: "m" } });
		process.env.ANTHROPIC_API_KEY = "sk-test-key";
		const result = await checkApiKey();
		expect(result.status).toBe("pass");
		expect(result.name).toBe("api-key");
		expect(result.message).toContain("anthropic");
		expect(result.message).toContain("ANTHROPIC_API_KEY");
	});

	it("should return pass when API key is in per-provider config", async () => {
		loadConfigMock.mockResolvedValue({
			...DEFAULT_CONFIG,
			llm: { provider: "openai", model: "gpt-4" },
			providers: { openai: { apiKey: "sk-config-key" } },
		});
		const result = await checkApiKey();
		expect(result.status).toBe("pass");
		expect(result.message).toContain("config providers");
	});

	it("should return pass when API key is in global llm.apiKey config", async () => {
		loadConfigMock.mockResolvedValue({
			...DEFAULT_CONFIG,
			llm: { provider: "openai", model: "gpt-4", apiKey: "sk-global-key" },
		});
		const result = await checkApiKey();
		expect(result.status).toBe("pass");
		expect(result.message).toContain("config llm.apiKey");
	});

	it("should prefer per-provider config key over env var", async () => {
		loadConfigMock.mockResolvedValue({
			...DEFAULT_CONFIG,
			llm: { provider: "anthropic", model: "m" },
			providers: { anthropic: { apiKey: "from-config" } },
		});
		process.env.ANTHROPIC_API_KEY = "from-env";
		const result = await checkApiKey();
		expect(result.message).toContain("config providers");
	});

	it("should return fail when no API key is found anywhere", async () => {
		loadConfigMock.mockResolvedValue({ ...DEFAULT_CONFIG, llm: { provider: "anthropic", model: "m" } });
		const result = await checkApiKey();
		expect(result.status).toBe("fail");
		expect(result.message).toContain("Missing API key");
		expect(result.message).toContain("anthropic");
		expect(result.details).toContain("ANTHROPIC_API_KEY");
	});

	it("should return fail when env var is empty string", async () => {
		loadConfigMock.mockResolvedValue({ ...DEFAULT_CONFIG, llm: { provider: "anthropic", model: "m" } });
		process.env.ANTHROPIC_API_KEY = "";
		const result = await checkApiKey();
		expect(result.status).toBe("fail");
	});

	it("should check correct env var for openai provider", async () => {
		loadConfigMock.mockResolvedValue({ ...DEFAULT_CONFIG, llm: { provider: "openai", model: "gpt-4" } });
		process.env.OPENAI_API_KEY = "sk-openai";
		const result = await checkApiKey();
		expect(result.status).toBe("pass");
		expect(result.message).toContain("OPENAI_API_KEY");
	});

	it("should check correct env var for deepseek provider", async () => {
		loadConfigMock.mockResolvedValue({ ...DEFAULT_CONFIG, llm: { provider: "deepseek", model: "deepseek-chat" } });
		process.env.DEEPSEEK_API_KEY = "sk-deepseek";
		const result = await checkApiKey();
		expect(result.status).toBe("pass");
		expect(result.message).toContain("DEEPSEEK_API_KEY");
	});

	it("should handle unknown provider by deriving env var name", async () => {
		loadConfigMock.mockResolvedValue({ ...DEFAULT_CONFIG, llm: { provider: "my-custom", model: "m" } });
		process.env.MY_CUSTOM_API_KEY = "sk-custom";
		savedEnv.MY_CUSTOM_API_KEY = undefined; // mark for cleanup
		const result = await checkApiKey();
		expect(result.status).toBe("pass");
		expect(result.message).toContain("MY_CUSTOM_API_KEY");
		delete process.env.MY_CUSTOM_API_KEY;
	});

	it("should return fail when provider is empty string", async () => {
		loadConfigMock.mockResolvedValue({ ...DEFAULT_CONFIG, llm: { provider: "", model: "m" } });
		const result = await checkApiKey();
		expect(result.status).toBe("fail");
		expect(result.message).toBe("No AI provider configured");
	});

	it("should always set name to api-key", async () => {
		loadConfigMock.mockResolvedValue({ ...DEFAULT_CONFIG });
		const result = await checkApiKey();
		expect(result.name).toBe("api-key");
	});
});
