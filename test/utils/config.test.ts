import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	getLegacyProjectStorageDir,
	getGlobalStorageDir,
	GLOBAL_PROJECT_ID,
} from "../../src/utils/config.js";

describe("getGlobalStorageDir", () => {
	it("returns ~/.cliclaw/", () => {
		const dir = getGlobalStorageDir();
		expect(dir).toBe(join(homedir(), ".cliclaw"));
	});
});

describe("GLOBAL_PROJECT_ID", () => {
	it('is "global"', () => {
		expect(GLOBAL_PROJECT_ID).toBe("global");
	});
});

describe("getLegacyProjectStorageDir (for migration)", () => {
	it("returns path under ~/.cliclaw/projects/ with basename-hash format", () => {
		const dir = getLegacyProjectStorageDir("/Users/test/code/myapp");
		const configDir = join(homedir(), ".cliclaw");
		expect(dir.startsWith(join(configDir, "projects"))).toBe(true);
		expect(dir).toMatch(/myapp-[a-f0-9]{6}$/);
	});

	it("produces stable output for same input", () => {
		const a = getLegacyProjectStorageDir("/Users/test/code/myapp");
		const b = getLegacyProjectStorageDir("/Users/test/code/myapp");
		expect(a).toBe(b);
	});

	it("produces different ids for same-name projects in different paths", () => {
		const a = getLegacyProjectStorageDir("/Users/test/work/api");
		const b = getLegacyProjectStorageDir("/Users/test/personal/api");
		expect(a).not.toBe(b);
		expect(basename(a)).toMatch(/^api-/);
		expect(basename(b)).toMatch(/^api-/);
	});

	it("generates correct hash from absolute path", () => {
		const projectDir = "/Users/test/code/myapp";
		const absPath = resolve(projectDir);
		const expectedHash = createHash("sha256").update(absPath).digest("hex").slice(0, 6);
		const dir = getLegacyProjectStorageDir(projectDir);
		expect(basename(dir)).toBe(`myapp-${expectedHash}`);
	});
});
