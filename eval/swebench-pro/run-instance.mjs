#!/usr/bin/env node
// Run ONE SWE-bench Pro instance through cliclaw in local (host) mode and append
// its prediction patch to a predictions JSON file.
//
// Repo preparation is a separate concern: --repo-dir must already point at a git
// checkout of the instance's repo at its base_commit. For the faithful path use
// the Docker mode (see docker/), which uses the official per-instance image that
// ships the repo + deps. This local mode is for development / small smokes.
//
// Usage:
//   node eval/swebench-pro/run-instance.mjs \
//     --instances dataset/swe_bench_pro.jsonl \
//     --id <instance_id> \
//     --repo-dir /path/to/checked-out/repo \
//     --out runs/predictions.json \
//     --prefix run1 [--timeout-min 30] [--max-nudges 3] [--agent claude-code] [--keep-mcp]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { httpGetJson } from "./lib/api.mjs";
import { fetchAuthCookie, runTask } from "./lib/driver.mjs";
import { extractPatch } from "./lib/patch.mjs";
import { buildTaskPrompt } from "./lib/prompt.mjs";
import { startIsolatedCliclaw } from "./lib/server.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const distMain = join(repoRoot, "dist", "main.js");

const { values } = parseArgs({
	options: {
		instances: { type: "string" },
		id: { type: "string" },
		"repo-dir": { type: "string" },
		out: { type: "string", default: "eval/swebench-pro/runs/predictions.json" },
		prefix: { type: "string", default: "cliclaw" },
		"timeout-min": { type: "string", default: "30" },
		"max-nudges": { type: "string", default: "3" },
		agent: { type: "string", default: "claude-code" },
		"keep-mcp": { type: "boolean", default: false },
	},
});

function die(msg) {
	console.error(`error: ${msg}`);
	process.exit(1);
}

if (!values.instances) die("--instances <jsonl> is required");
if (!values.id) die("--id <instance_id> is required");
if (!values["repo-dir"]) die("--repo-dir <dir> is required");
if (!existsSync(distMain)) die(`cliclaw not built: ${distMain} missing (run npm run build)`);

const repoDir = resolve(values["repo-dir"]);
if (!existsSync(join(repoDir, ".git"))) die(`--repo-dir is not a git repo: ${repoDir}`);

function loadInstance(file, id) {
	const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
	for (const line of lines) {
		const row = JSON.parse(line);
		if (row.instance_id === id) return row;
	}
	die(`instance_id ${id} not found in ${file}`);
}

function appendPrediction(outPath, entry) {
	mkdirSync(dirname(outPath), { recursive: true });
	let arr = [];
	if (existsSync(outPath)) {
		try {
			arr = JSON.parse(readFileSync(outPath, "utf8"));
		} catch {
			arr = [];
		}
	}
	// Replace any existing entry for the same (instance_id, prefix).
	arr = arr.filter((e) => !(e.instance_id === entry.instance_id && e.prefix === entry.prefix));
	arr.push(entry);
	writeFileSync(outPath, JSON.stringify(arr, null, 2));
}

(async () => {
	const inst = loadInstance(values.instances, values.id);
	const baseCommit = inst.base_commit;
	const task = buildTaskPrompt(inst);
	const timeoutMs = Number(values["timeout-min"]) * 60 * 1000;
	const outPath = resolve(values.out);
	const logDir = join(repoRoot, "eval", "swebench-pro", "runs", "logs");
	mkdirSync(logDir, { recursive: true });
	const serverLog = join(logDir, `${values.id}.server.log`);
	const serverLogChunks = [];

	console.log(`[${values.id}] starting isolated cliclaw (agent=${values.agent}) cwd=${repoDir}`);
	const srv = await startIsolatedCliclaw({
		repoDir,
		distMain,
		agent: values.agent,
		keepMcp: values["keep-mcp"],
		onLog: (l) => serverLogChunks.push(l),
	});

	let sessionNames = [];
	let res;
	try {
		console.log(`[${values.id}] ${srv.baseUrl} up — sending task (${task.length} chars), timeout ${values["timeout-min"]}min`);
		res = await runTask({
			baseUrl: srv.baseUrl,
			task,
			timeoutMs,
			maxNudges: Number(values["max-nudges"]),
			onEvent: (e) => {
				if (e.kind === "state") console.log(`[${values.id}]   state=${e.state}`);
				else if (e.kind === "nudge") console.log(`[${values.id}]   nudge #${e.n}`);
				else if (e.kind === "agent_update") console.log(`[${values.id}]   agent: ${(e.summary ?? "").slice(0, 80)}`);
			},
		});

		// Record which sub-agents ran (for the log). Their tmux sessions live on
		// this instance's ISOLATED tmux server and are torn down by srv.stop().
		try {
			const cookie = await fetchAuthCookie(srv.baseUrl);
			const agents = await httpGetJson(srv.baseUrl, cookie, "/api/agents/terminals");
			sessionNames = (agents ?? []).map((a) => a.agentName).filter(Boolean);
		} catch {}
	} finally {
		await srv.stop();
		writeFileSync(serverLog, serverLogChunks.join(""));
	}

	const { patch, touchedTestFiles } = extractPatch(repoDir, baseCommit);
	if (touchedTestFiles.length) {
		console.warn(`[${values.id}] WARNING: agent edited test files (will be ignored by grader): ${touchedTestFiles.join(", ")}`);
	}

	const realConfig = JSON.parse(readFileSync(join(process.env.HOME ?? "", ".cliclaw", "config.json"), "utf8"));
	appendPrediction(outPath, {
		instance_id: values.id,
		patch,
		prefix: values.prefix,
		// metadata (ignored by the official harness, useful for our reproducibility)
		_meta: {
			status: res.status,
			nudges: res.nudges,
			orchestrator_model: realConfig?.llm?.model,
			orchestrator_provider: realConfig?.llm?.provider,
			agent: values.agent,
			patch_bytes: patch.length,
			touched_test_files: touchedTestFiles,
		},
	});

	const resultLog = join(logDir, `${values.id}.result.json`);
	writeFileSync(resultLog, JSON.stringify({ id: values.id, status: res.status, nudges: res.nudges, finalText: res.finalText, transcript: res.transcript }, null, 2));

	console.log(`[${values.id}] DONE status=${res.status} nudges=${res.nudges} patch=${patch.length}B -> ${outPath}`);
	process.exit(res.status === "done" ? 0 : 2);
})().catch((err) => {
	console.error("run-instance crashed:", err);
	process.exit(1);
});
