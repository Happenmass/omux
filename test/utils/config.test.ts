import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	getGlobalStorageDir,
} from "../../src/utils/config.js";

describe("getGlobalStorageDir", () => {
	it("returns ~/.cliclaw/", () => {
		const dir = getGlobalStorageDir();
		expect(dir).toBe(join(homedir(), ".cliclaw"));
	});
});
