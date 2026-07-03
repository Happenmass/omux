import { describe, expect, it } from "vitest";
import { t } from "../../src/server/messages.js";

describe("backend messages table (t)", () => {
	it("returns English by default", () => {
		expect(t("not_executing")).toBe("No task is currently executing");
		expect(t("autocontinue_off")).toBe("auto-continue disabled");
	});

	it("returns the zh-CN variant when requested", () => {
		expect(t("not_executing", "zh-CN")).toBe("当前未在执行任务");
		expect(t("autocontinue_off", "zh-CN")).toBe("auto-continue 已关闭");
	});

	it("interpolates params in both locales", () => {
		expect(t("unknown_command", "en-US", { name: "foo" })).toBe("Unknown command: /foo");
		expect(t("unknown_command", "zh-CN", { name: "foo" })).toBe("未知指令: /foo");
		expect(t("autocontinue_on", "en-US", { max: 5 })).toContain("cap 5");
		expect(t("autocontinue_on", "zh-CN", { max: 5 })).toContain("上限 5");
	});

	it("falls back to the raw key for an unknown key", () => {
		expect(t("does_not_exist" as any)).toBe("does_not_exist");
	});
});
