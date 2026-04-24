import { afterEach, describe, expect, it, vi } from "vitest";
import { getLanguageInstruction, resolveLocale } from "../../src/utils/locale.js";

describe("resolveLocale", () => {
	const origEnv = { ...process.env };

	afterEach(() => {
		process.env.LANG = origEnv.LANG;
		process.env.LC_ALL = origEnv.LC_ALL;
		process.env.LANGUAGE = origEnv.LANGUAGE;
	});

	it("returns config override when provided (zh)", () => {
		expect(resolveLocale("zh-CN")).toBe("zh-CN");
		expect(resolveLocale("zh_TW.UTF-8")).toBe("zh-CN");
	});

	it("returns config override when provided (en)", () => {
		expect(resolveLocale("en-US")).toBe("en-US");
		expect(resolveLocale("en_GB.UTF-8")).toBe("en-US");
	});

	it("detects Chinese from LANG env", () => {
		process.env.LANG = "zh_CN.UTF-8";
		delete process.env.LC_ALL;
		expect(resolveLocale()).toBe("zh-CN");
	});

	it("detects Chinese from LC_ALL env (takes priority over LANG)", () => {
		process.env.LANG = "en_US.UTF-8";
		process.env.LC_ALL = "zh_CN.UTF-8";
		expect(resolveLocale()).toBe("zh-CN");
	});

	it("falls back to en-US for non-Chinese locale", () => {
		process.env.LANG = "ja_JP.UTF-8";
		delete process.env.LC_ALL;
		expect(resolveLocale()).toBe("en-US");
	});

	it("falls back to en-US when no env is set", () => {
		delete process.env.LANG;
		delete process.env.LC_ALL;
		delete process.env.LANGUAGE;
		expect(resolveLocale()).toBe("en-US");
	});
});

describe("getLanguageInstruction", () => {
	it("returns Chinese instruction for zh-CN", () => {
		const inst = getLanguageInstruction("zh-CN");
		expect(inst).toContain("Chinese");
		expect(inst).toContain("简体中文");
	});

	it("returns English instruction for en-US", () => {
		const inst = getLanguageInstruction("en-US");
		expect(inst).toContain("English");
		expect(inst).not.toContain("简体中文");
	});
});
