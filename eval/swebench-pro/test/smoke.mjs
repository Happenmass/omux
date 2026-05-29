// Free, hermetic smoke test for the driver + patch-extraction chain.
// Spins up the mock cliclaw server against a throwaway git repo and asserts the
// driver detects completion sentinels correctly and that we recover the diff.
// No LLM, no tmux, no Docker, no touching ~/.cliclaw.
//
//   node eval/swebench-pro/test/smoke.mjs
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runTask } from "../lib/driver.mjs";
import { extractPatch } from "../lib/patch.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const mockPath = join(here, "..", "mock", "mock-cliclaw.mjs");

let passed = 0;
let failed = 0;
function check(name, cond, detail = "") {
	if (cond) {
		passed++;
		console.log(`  ✓ ${name}`);
	} else {
		failed++;
		console.log(`  ✗ ${name} ${detail}`);
	}
}

function makeRepo() {
	const dir = mkdtempSync(join(tmpdir(), "swebench-smoke-repo-"));
	const file = "calc.js";
	writeFileSync(join(dir, file), "function add(a, b) {\n\treturn a - b; // BUG\n}\nmodule.exports = { add };\n");
	const g = (args) => execFileSync("git", ["-C", dir, ...args], { stdio: "ignore", env: { ...process.env } });
	g(["init", "-q"]);
	g(["config", "user.email", "smoke@example.com"]);
	g(["config", "user.name", "smoke"]);
	g(["add", "-A"]);
	g(["commit", "-q", "-m", "init"]);
	const base = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"]).toString().trim();
	return { dir, file, base };
}

function startMock(env) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [mockPath], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "inherit"] });
		let buf = "";
		const onData = (d) => {
			buf += d.toString();
			const line = buf.split("\n")[0];
			if (line.includes("ready")) {
				try {
					const info = JSON.parse(line);
					child.stdout.off("data", onData);
					resolve({ child, port: info.port });
				} catch {}
			}
		};
		child.stdout.on("data", onData);
		child.on("error", reject);
		setTimeout(() => reject(new Error("mock did not start")), 5000);
	});
}

async function scenario(name, env, assertFn) {
	const repo = makeRepo();
	const { child, port } = await startMock({
		...env,
		MOCK_REPO: repo.dir,
		MOCK_FILE: repo.file,
		MOCK_FIX_FROM: "return a - b; // BUG",
		MOCK_FIX_TO: "return a + b;",
	});
	try {
		const res = await runTask({
			baseUrl: `http://127.0.0.1:${port}`,
			task: "fix the add() bug",
			timeoutMs: 15000,
			graceMs: 1200,
			pollMs: 400,
			maxNudges: 3,
		});
		const { patch } = extractPatch(repo.dir, repo.base);
		console.log(`[${name}] status=${res.status} nudges=${res.nudges}`);
		assertFn(res, patch);
	} finally {
		child.kill("SIGKILL");
		rmSync(repo.dir, { recursive: true, force: true });
	}
}

(async () => {
	console.log("SWE-bench Pro driver smoke test\n");

	await scenario("done", { MOCK_SCENARIO: "done" }, (res, patch) => {
		check("done: status is done", res.status === "done", `(got ${res.status})`);
		check("done: patch contains the fix", patch.includes("return a + b;"), "(fix missing from diff)");
		check("done: patch removes the bug line", patch.includes("-\treturn a - b; // BUG"));
		check("done: no nudges needed", res.nudges === 0, `(nudges=${res.nudges})`);
	});

	await scenario("nudge", { MOCK_SCENARIO: "nudge" }, (res, patch) => {
		check("nudge: status is done after nudge", res.status === "done", `(got ${res.status})`);
		check("nudge: took >=1 nudge", res.nudges >= 1, `(nudges=${res.nudges})`);
		check("nudge: patch contains the fix", patch.includes("return a + b;"));
	});

	await scenario("fail", { MOCK_SCENARIO: "fail" }, (res, patch) => {
		check("fail: status is failed", res.status === "failed", `(got ${res.status})`);
		check("fail: empty patch", patch.trim() === "", "(expected no diff)");
	});

	console.log(`\n${passed} passed, ${failed} failed`);
	process.exit(failed === 0 ? 0 : 1);
})().catch((err) => {
	console.error("smoke crashed:", err);
	process.exit(1);
});
