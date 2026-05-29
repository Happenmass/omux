#!/usr/bin/env node
// Hybrid batch driver: for each selected instance, prepare the repo (docker cp)
// then generate a patch in host mode (sequential — host mode shares one machine).
// Grading is a single official command afterwards over the predictions file.
//
//   node eval/swebench-pro/run-batch.mjs --instances <jsonl> --sample 10 [--lang go,python]
//   node eval/swebench-pro/run-batch.mjs --instances <jsonl> --ids id1,id2
//   node eval/swebench-pro/run-batch.mjs --instances <jsonl> --ids-file ids.txt
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({
	options: {
		instances: { type: "string" },
		ids: { type: "string" },
		"ids-file": { type: "string" },
		sample: { type: "string" },
		lang: { type: "string" }, // comma list: go,python,js,ts
		out: { type: "string", default: join(here, "runs", "predictions.json") },
		prefix: { type: "string", default: "cliclaw" },
		"timeout-min": { type: "string", default: "30" },
		"max-nudges": { type: "string", default: "3" },
		agent: { type: "string", default: "claude-code" },
	},
});
const die = (m) => {
	console.error(`error: ${m}`);
	process.exit(1);
};
if (!values.instances) die("--instances <jsonl> is required");

const rows = readFileSync(values.instances, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const byId = new Map(rows.map((r) => [r.instance_id, r]));

function stratified(pool, n) {
	// Round-robin across repos for diversity, deterministic order.
	const groups = new Map();
	for (const r of pool) {
		if (!groups.has(r.repo)) groups.set(r.repo, []);
		groups.get(r.repo).push(r);
	}
	const order = [...groups.values()];
	const out = [];
	let i = 0;
	while (out.length < n && order.some((g) => g.length)) {
		const g = order[i % order.length];
		if (g.length) out.push(g.shift());
		i++;
	}
	return out;
}

let ids = [];
if (values.ids) ids = values.ids.split(",").map((s) => s.trim()).filter(Boolean);
else if (values["ids-file"]) ids = readFileSync(values["ids-file"], "utf8").split("\n").map((s) => s.trim()).filter(Boolean);
else if (values.sample) {
	let pool = rows;
	if (values.lang) {
		const langs = new Set(values.lang.split(",").map((s) => s.trim()));
		pool = pool.filter((r) => langs.has(r.repo_language));
	}
	ids = stratified(pool, Number(values.sample)).map((r) => r.instance_id);
} else die("provide --ids, --ids-file, or --sample N");

for (const id of ids) if (!byId.has(id)) die(`unknown instance_id: ${id}`);
console.log(`Batch: ${ids.length} instance(s)\n`);

const results = [];
for (const [n, id] of ids.entries()) {
	const r = byId.get(id);
	console.log(`\n===== [${n + 1}/${ids.length}] ${id} (${r.repo}, ${r.repo_language}) =====`);
	let repoDir;
	try {
		const out = execFileSync("node", [join(here, "prepare-repo.mjs"), "--instances", values.instances, "--id", id], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "inherit"],
			maxBuffer: 16 * 1024 * 1024,
		});
		repoDir = out.trim().split("\n").pop();
	} catch (e) {
		console.error(`[batch] prepare-repo failed for ${id}: ${e.message}`);
		results.push({ id, status: "prepare_failed" });
		continue;
	}
	const run = spawnSync(
		"node",
		[
			join(here, "run-instance.mjs"),
			"--instances", values.instances,
			"--id", id,
			"--repo-dir", repoDir,
			"--out", resolve(values.out),
			"--prefix", values.prefix,
			"--timeout-min", values["timeout-min"],
			"--max-nudges", values["max-nudges"],
			"--agent", values.agent,
		],
		{ stdio: "inherit" },
	);
	results.push({ id, status: run.status === 0 ? "done" : `exit_${run.status}` });
}

console.log("\n===== batch summary =====");
for (const r of results) console.log(`  ${r.status.padEnd(16)} ${r.id}`);
console.log(`\nPredictions: ${resolve(values.out)}`);
console.log("Next — grade (from the SWE-bench_Pro-os checkout):");
console.log(
	`  python swe_bench_pro_eval.py --raw_sample_path ${resolve(values.instances)} \\\n` +
		`    --patch_path ${resolve(values.out)} --output_dir <out> --scripts_dir run_scripts \\\n` +
		`    --num_workers 4 --dockerhub_username jefzda --use_local_docker --docker_platform linux/amd64`,
);
