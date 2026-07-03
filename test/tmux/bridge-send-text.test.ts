import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
	execFile: vi.fn(),
}));

vi.mock("node:util", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:util")>();
	return {
		...actual,
		promisify: (fn: (...args: never[]) => unknown) => {
			// Return a wrapper that calls the mocked execFile with a callback-style → promise conversion
			return (...args: unknown[]) =>
				new Promise((resolve, reject) => {
					fn(...args, (err: Error | null, result: unknown) => {
						if (err) reject(err);
						else resolve(result);
					});
				});
		},
	};
});

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		writeFile: vi.fn().mockResolvedValue(undefined),
		unlink: vi.fn().mockResolvedValue(undefined),
	};
});

import { execFile } from "node:child_process";
import { TmuxBridge } from "../../src/tmux/bridge.js";

const execFileMock = vi.mocked(execFile);

function mockExecFileSuccess(stdout = "") {
	execFileMock.mockImplementation((...args: any[]) => {
		const cb = args[args.length - 1];
		if (typeof cb === "function") {
			cb(null, { stdout, stderr: "" });
		}
	});
}

function calledArgs(): string[][] {
	return execFileMock.mock.calls.map((call) => call[1] as string[]);
}

describe("TmuxBridge.sendText branch selection", () => {
	let bridge: TmuxBridge;

	beforeEach(() => {
		execFileMock.mockReset();
		mockExecFileSuccess();
		bridge = new TmuxBridge();
	});

	it("uses send-keys -l for a short single-line string", async () => {
		await bridge.sendText("sess:0.0", "hello world");
		const calls = calledArgs();
		expect(calls).toHaveLength(1);
		expect(calls[0][0]).toBe("send-keys");
		expect(calls[0]).toContain("-l");
	});

	it("uses the paste-buffer path for a short string containing an embedded newline", async () => {
		await bridge.sendText("sess:0.0", "line one\nline two");
		const calls = calledArgs();
		const commands = calls.map((c) => c[0]);
		expect(commands).toContain("load-buffer");
		expect(commands).toContain("paste-buffer");
		expect(commands).not.toContain("send-keys");
	});

	it("uses the paste-buffer path for text longer than 200 chars", async () => {
		const longText = "a".repeat(201);
		await bridge.sendText("sess:0.0", longText);
		const calls = calledArgs();
		const commands = calls.map((c) => c[0]);
		expect(commands).toContain("load-buffer");
		expect(commands).toContain("paste-buffer");
		expect(commands).not.toContain("send-keys");
	});
});
