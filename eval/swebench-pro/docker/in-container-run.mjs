#!/usr/bin/env node
// Runs INSIDE a cliclaw-eval:<tag> container. The container itself is the
// isolation boundary, so (unlike host mode) we do NOT override HOME — cliclaw
// runs directly with cwd = REPO_PATH (the repo checked out at base_commit in the
// base image). Drives one instance and writes the prediction patch to OUT_PATH.
//
// Required env:
//   REPO_PATH      absolute path to the repo (at base_commit) inside the image
//   INSTANCE_JSON  path to a single-instance JSON file (one dataset row)
//   OUT_PATH       where to write the prediction JSON
// Optional:
//   AGENT (default claude-code), TIMEOUT_MIN (default 30), MAX_NUDGES (default 3)
//
// ⚠️ UNVERIFIED: needs a running Docker daemon + a pulled base image to confirm
//    the in-image repo path and toolchain. See README "Container mode" + TODO.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fetchAuthCookie, runTask } from "../lib/driver.mjs";
import { extractPatch } from "../lib/patch.mjs";
import { buildTaskPrompt } from "../lib/prompt.mjs";
import { getFreePort, waitForPort } from "../lib/util.mjs";

const REPO_PATH = process.env.REPO_PATH;
const INSTANCE_JSON = process.env.INSTANCE_JSON;
const OUT_PATH = process.env.OUT_PATH ?? "/out/prediction.json";
const AGENT = process.env.AGENT ?? "claude-code";
const TIMEOUT_MS = Number(process.env.TIMEOUT_MIN ?? "30") * 60 * 1000;
const MAX_NUDGES = Number(process.env.MAX_NUDGES ?? "3");
const DIST_MAIN = "/opt/cliclaw/dist/main.js";

function die(m) {
	console.error(`error: ${m}`);
	process.exit(1);
}
if (!REPO_PATH || !existsSync(REPO_PATH)) die(`REPO_PATH missing or not found: ${REPO_PATH}`);
if (!INSTANCE_JSON || !existsSync(INSTANCE_JSON)) die(`INSTANCE_JSON missing: ${INSTANCE_JSON}`);

(async () => {
	const inst = JSON.parse(readFileSync(INSTANCE_JSON, "utf8"));
	const task = buildTaskPrompt(inst);
	const port = await getFreePort();

	const child = spawn(
		process.execPath,
		["--max-old-space-size=8192", DIST_MAIN, "serve", "--host", "127.0.0.1", "--port", String(port), "--cwd", REPO_PATH, "--no-mdns", "--agent", AGENT],
		{ cwd: REPO_PATH, env: { ...process.env, CLICLAW_DAEMON: "1" }, stdio: ["ignore", "inherit", "inherit"] },
	);

	if (!(await waitForPort("127.0.0.1", port, 60000))) {
		child.kill("SIGKILL");
		die("cliclaw did not start within 60s");
	}

	const baseUrl = `http://127.0.0.1:${port}`;
	let res;
	try {
		res = await runTask({ baseUrl, task, timeoutMs: TIMEOUT_MS, maxNudges: MAX_NUDGES, onEvent: (e) => e.kind === "state" && console.log(`state=${e.state}`) });
		await fetchAuthCookie(baseUrl).catch(() => {});
	} finally {
		child.kill("SIGTERM");
	}

	const { patch, touchedTestFiles } = extractPatch(REPO_PATH, inst.base_commit);
	mkdirSync(dirname(OUT_PATH), { recursive: true });
	writeFileSync(
		OUT_PATH,
		JSON.stringify({ instance_id: inst.instance_id, patch, prefix: process.env.PREFIX ?? "cliclaw", _meta: { status: res.status, turns: res.turns, agent: AGENT, touched_test_files: touchedTestFiles } }, null, 2),
	);
	console.log(`wrote ${OUT_PATH} status=${res.status} patch=${patch.length}B`);
	process.exit(res.status === "done" ? 0 : 2);
})().catch((e) => {
	console.error("in-container-run crashed:", e);
	process.exit(1);
});
