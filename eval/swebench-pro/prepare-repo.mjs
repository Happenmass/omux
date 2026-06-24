#!/usr/bin/env node
// Prepare a host-side git checkout of one instance's repo at its base_commit by
// copying it out of the official per-instance Docker image (which already has the
// repo + deps). Used by the hybrid flow (host produces patch, Docker grades).
//
//   node eval/swebench-pro/prepare-repo.mjs \
//     --instances eval/swebench-pro/dataset/swe_bench_pro.jsonl \
//     --id <instance_id> [--out-dir eval/swebench-pro/runs/repos] [--platform linux/amd64]
//
// Prints the repo dir path on the last stdout line.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({
	options: {
		instances: { type: "string" },
		id: { type: "string" },
		"out-dir": { type: "string", default: join(here, "runs", "repos") },
		platform: { type: "string", default: "linux/amd64" },
		force: { type: "boolean", default: false },
	},
});
const die = (m) => {
	console.error(`error: ${m}`);
	process.exit(1);
};
if (!values.instances || !values.id) die("--instances and --id are required");

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });

function loadInstance(file, id) {
	for (const line of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
		const r = JSON.parse(line);
		if (r.instance_id === id) return r;
	}
	die(`instance ${id} not found`);
}

const inst = loadInstance(values.instances, values.id);
const image = `jefzda/sweap-images:${inst.dockerhub_tag}`;
const plat = values.platform;
const repoDir = resolve(values["out-dir"], values.id);

if (existsSync(join(repoDir, ".git")) && !values.force) {
	try {
		const head = sh("git", ["-C", repoDir, "rev-parse", "HEAD"]).trim();
		if (head === inst.base_commit) {
			// Reuse, but guarantee a pristine base (a prior/interrupted run may
			// have left the working tree dirty — that would pollute this run).
			sh("git", ["-C", repoDir, "reset", "--hard", inst.base_commit, "-q"]);
			sh("git", ["-C", repoDir, "clean", "-fdq"]);
			console.error(`[prepare] reuse existing ${repoDir} (reset clean @ base)`);
			console.log(repoDir);
			process.exit(0);
		}
	} catch {}
}

// Pull image if absent.
try {
	sh("docker", ["image", "inspect", image], { stdio: "ignore" });
	console.error(`[prepare] image present: ${image}`);
} catch {
	console.error(`[prepare] pulling ${image} ...`);
	sh("docker", ["pull", "--platform", plat, image], { stdio: "inherit" });
}

// Discover the in-image repo path: prefer Config.WorkingDir, else find a .git.
let repoPath = "";
try {
	repoPath = sh("docker", ["inspect", "--format", "{{.Config.WorkingDir}}", image]).trim();
} catch {}
function verifyHasBase(path) {
	try {
		const out = sh("docker", ["run", "--rm", "--platform", plat, "--entrypoint", "bash", image, "-c", `git -C ${path} rev-parse HEAD 2>/dev/null`]).trim();
		return out === inst.base_commit;
	} catch {
		return false;
	}
}
if (!repoPath || !verifyHasBase(repoPath)) {
	console.error(`[prepare] WorkingDir (${repoPath || "?"}) is not the repo; searching for .git ...`);
	const found = sh("docker", ["run", "--rm", "--platform", plat, "--entrypoint", "bash", image, "-c", "find / -maxdepth 4 -name .git -type d 2>/dev/null | head -5"]).trim().split("\n").filter(Boolean);
	let ok = "";
	for (const g of found) {
		const cand = g.replace(/\/\.git$/, "");
		if (verifyHasBase(cand)) {
			ok = cand;
			break;
		}
	}
	if (!ok) die(`could not locate repo at base_commit ${inst.base_commit} in ${image}`);
	repoPath = ok;
}
console.error(`[prepare] in-image repo path: ${repoPath}`);

// Copy it out.
mkdirSync(dirname(repoDir), { recursive: true });
rmSync(repoDir, { recursive: true, force: true });
const cid = sh("docker", ["create", "--platform", plat, image]).trim();
try {
	sh("docker", ["cp", `${cid}:${repoPath}`, repoDir], { stdio: "inherit" });
} finally {
	sh("docker", ["rm", cid], { stdio: "ignore" });
}

const head = sh("git", ["-C", repoDir, "rev-parse", "HEAD"]).trim();
if (head !== inst.base_commit) die(`HEAD ${head} != base_commit ${inst.base_commit}`);
// Ensure a clean tree at base_commit.
sh("git", ["-C", repoDir, "reset", "--hard", inst.base_commit, "-q"]);
sh("git", ["-C", repoDir, "clean", "-fdq"]);
console.error(`[prepare] ready: ${repoDir} @ ${head}`);
console.log(repoDir);
