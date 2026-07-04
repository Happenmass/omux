import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs/promises", () => ({
	readFile: vi.fn(),
}));

vi.mock("../../../src/utils/config.js", () => ({
	getConfigFilePath: () => "/mock/.omux/config.json",
}));

import { readFile } from "node:fs/promises";
import { checkConfig } from "../../../src/doctor/checks/config.js";

const readFileMock = vi.mocked(readFile);

function mockReadFile(content: string) {
	readFileMock.mockResolvedValue(content as any);
}

function mockReadFileError(code: string, message = "file error") {
	const err = new Error(message) as NodeJS.ErrnoException;
	err.code = code;
	readFileMock.mockRejectedValue(err);
}

describe("checkConfig", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("should return pass for valid config with provider and model", async () => {
		mockReadFile(JSON.stringify({
			llm: { provider: "anthropic", model: "claude-sonnet-4-6" },
		}));
		const result = await checkConfig();
		expect(result.status).toBe("pass");
		expect(result.name).toBe("config-valid");
		expect(result.message).toContain("anthropic");
		expect(result.message).toContain("claude-sonnet-4-6");
	});

	it("should return warning when config file does not exist", async () => {
		mockReadFileError("ENOENT");
		const result = await checkConfig();
		expect(result.status).toBe("warning");
		expect(result.message).toContain("not found");
	});

	it("should return fail for permission denied", async () => {
		mockReadFileError("EACCES");
		const result = await checkConfig();
		expect(result.status).toBe("fail");
		expect(result.message).toBe("Permission denied reading config");
	});

	it("should return fail for other file system errors", async () => {
		mockReadFileError("EIO", "I/O error");
		const result = await checkConfig();
		expect(result.status).toBe("fail");
		expect(result.message).toContain("Failed to read config");
	});

	it("should return fail for invalid JSON", async () => {
		mockReadFile("{not valid json}}}");
		const result = await checkConfig();
		expect(result.status).toBe("fail");
		expect(result.message).toBe("Invalid JSON format");
	});

	it("should return fail when JSON is an array instead of object", async () => {
		mockReadFile("[]");
		const result = await checkConfig();
		expect(result.status).toBe("fail");
		expect(result.message).toBe("Config must be a JSON object");
	});

	it("should return fail when JSON is null", async () => {
		mockReadFile("null");
		const result = await checkConfig();
		expect(result.status).toBe("fail");
		expect(result.message).toBe("Config must be a JSON object");
	});

	it("should return fail when llm section is missing", async () => {
		mockReadFile(JSON.stringify({ defaultAgent: "claude-code" }));
		const result = await checkConfig();
		expect(result.status).toBe("fail");
		expect(result.message).toContain("llm");
	});

	it("should return fail when llm is not an object", async () => {
		mockReadFile(JSON.stringify({ llm: "string" }));
		const result = await checkConfig();
		expect(result.status).toBe("fail");
		expect(result.message).toContain("llm");
	});

	it("should return fail when provider is missing", async () => {
		mockReadFile(JSON.stringify({ llm: { model: "gpt-4" } }));
		const result = await checkConfig();
		expect(result.status).toBe("fail");
		expect(result.message).toContain("provider");
	});

	it("should return fail when model is missing", async () => {
		mockReadFile(JSON.stringify({ llm: { provider: "openai" } }));
		const result = await checkConfig();
		expect(result.status).toBe("fail");
		expect(result.message).toContain("model");
	});

	it("should return fail when provider is empty string", async () => {
		mockReadFile(JSON.stringify({ llm: { provider: "", model: "gpt-4" } }));
		const result = await checkConfig();
		expect(result.status).toBe("fail");
		expect(result.message).toContain("provider");
	});

	it("should return fail when model is empty string", async () => {
		mockReadFile(JSON.stringify({ llm: { provider: "openai", model: "" } }));
		const result = await checkConfig();
		expect(result.status).toBe("fail");
		expect(result.message).toContain("model");
	});

	it("should always set name to config-valid", async () => {
		mockReadFileError("ENOENT");
		const result = await checkConfig();
		expect(result.name).toBe("config-valid");
	});
});
