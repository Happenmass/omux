import { describe, expect, it } from "vitest";
import { buildCategoryPathFilter, categoryFromPath, isEvergreenCategory } from "../../src/memory/category.js";

describe("categoryFromPath", () => {
	it("should map core.md to core", () => {
		expect(categoryFromPath("memory/core.md")).toBe("core");
	});

	it("should map preferences.md to preferences", () => {
		expect(categoryFromPath("memory/preferences.md")).toBe("preferences");
	});

	it("should map people.md to people", () => {
		expect(categoryFromPath("memory/people.md")).toBe("people");
	});

	it("should map todos.md to todos", () => {
		expect(categoryFromPath("memory/todos.md")).toBe("todos");
	});

	it("should map date-named files to daily", () => {
		expect(categoryFromPath("memory/2024-01-15.md")).toBe("daily");
		expect(categoryFromPath("memory/2023-12-31.md")).toBe("daily");
	});

	it("should map custom topic files to topic", () => {
		expect(categoryFromPath("memory/deployment-guide.md")).toBe("topic");
		expect(categoryFromPath("memory/architecture.md")).toBe("topic");
	});

	it("should handle subdirectory paths", () => {
		expect(categoryFromPath("memory/nested/deep.md")).toBe("topic");
	});

	it("should map learning-pipeline subdir files to topic", () => {
		// memory/learning/<id>.md is written by the learning pipeline and indexed
		// recursively; it should map deterministically to a reasonable category.
		expect(categoryFromPath("memory/learning/01HXYZ.md")).toBe("topic");
	});

	it("should normalize backslashes", () => {
		expect(categoryFromPath("memory\\core.md")).toBe("core");
	});

	it("should strip leading ./", () => {
		expect(categoryFromPath("./memory/core.md")).toBe("core");
	});
});

describe("isEvergreenCategory", () => {
	it("should return true for core", () => {
		expect(isEvergreenCategory("core")).toBe(true);
	});

	it("should return true for preferences", () => {
		expect(isEvergreenCategory("preferences")).toBe(true);
	});

	it("should return true for people", () => {
		expect(isEvergreenCategory("people")).toBe(true);
	});

	it("should return true for todos", () => {
		expect(isEvergreenCategory("todos")).toBe(true);
	});

	it("should return true for topic", () => {
		expect(isEvergreenCategory("topic")).toBe(true);
	});

	it("should return false for daily", () => {
		expect(isEvergreenCategory("daily")).toBe(false);
	});
});

describe("buildCategoryPathFilter", () => {
	const trackedPaths = [
		"memory/core.md",
		"memory/preferences.md",
		"memory/people.md",
		"memory/todos.md",
		"memory/2024-01-15.md",
		"memory/2024-02-10.md",
		"memory/deployment-guide.md",
		"memory/architecture.md",
	];

	it("should return exact path for core", () => {
		expect(buildCategoryPathFilter("core", trackedPaths)).toEqual(["memory/core.md"]);
	});

	it("should return exact path for preferences", () => {
		expect(buildCategoryPathFilter("preferences", trackedPaths)).toEqual(["memory/preferences.md"]);
	});

	it("should return exact path for people", () => {
		expect(buildCategoryPathFilter("people", trackedPaths)).toEqual(["memory/people.md"]);
	});

	it("should return exact path for todos", () => {
		expect(buildCategoryPathFilter("todos", trackedPaths)).toEqual(["memory/todos.md"]);
	});

	it("should return all date-named paths for daily", () => {
		const result = buildCategoryPathFilter("daily", trackedPaths);
		expect(result).toContain("memory/2024-01-15.md");
		expect(result).toContain("memory/2024-02-10.md");
		expect(result).toHaveLength(2);
	});

	it("should return custom topic paths for topic", () => {
		const result = buildCategoryPathFilter("topic", trackedPaths);
		expect(result).toContain("memory/deployment-guide.md");
		expect(result).toContain("memory/architecture.md");
		expect(result).toHaveLength(2);
		// Should NOT contain known categories or dates
		expect(result).not.toContain("memory/core.md");
		expect(result).not.toContain("memory/2024-01-15.md");
	});
});
