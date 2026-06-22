// Extract a unified git diff (the "prediction patch") from a working tree
// the sub-agent edited in place. Mirrors how SWE-bench collects model patches.
//
// Agents often create throwaway artifacts in the repo to self-verify (virtualenvs,
// __pycache__, node_modules). Those must NOT pollute the patch, so we exclude
// common junk plus any directory that looks like a virtualenv (has pyvenv.cfg).
import { execFileSync } from "node:child_process";

function git(repoDir, args, opts = {}) {
	return execFileSync("git", ["-C", repoDir, ...args], {
		maxBuffer: 256 * 1024 * 1024,
		...opts,
	});
}

const JUNK = [
	".verify-venv",
	"venv",
	".venv",
	"node_modules",
	"__pycache__",
	".pytest_cache",
	".mypy_cache",
	".ruff_cache",
	".tox",
	".eggs",
];

function buildExcludes(repoDir) {
	const ex = [];
	for (const j of JUNK) {
		ex.push(`:(exclude,glob)**/${j}/**`);
		ex.push(`:(exclude)${j}`);
	}
	ex.push(":(exclude,glob)**/*.pyc");
	ex.push(":(exclude,glob)**/*.egg-info/**");
	// Discover virtualenvs (any dir containing pyvenv.cfg) among untracked files.
	try {
		const untracked = git(repoDir, ["status", "--porcelain", "--untracked-files=all"])
			.toString()
			.split("\n")
			.map((l) => l.slice(3))
			.filter(Boolean);
		for (const f of untracked) {
			if (f.endsWith("pyvenv.cfg")) {
				const dir = f.replace(/pyvenv\.cfg$/, "").replace(/\/$/, "");
				if (dir) ex.push(`:(exclude)${dir}`);
			}
		}
	} catch {}
	return ex;
}

/**
 * Diff of the working tree (incl. new files) vs `baseCommit` (or HEAD),
 * excluding agent-created build/venv junk. The index is reset afterwards.
 *
 * @returns {{ patch: string, touchedTestFiles: string[], files: string[] }}
 */
export function extractPatch(repoDir, baseCommit, testGlobs = []) {
	const ref = baseCommit && baseCommit.length ? baseCommit : "HEAD";
	const ex = buildExcludes(repoDir);

	// Plain `git add -A` (no pathspecs): it silently skips .gitignore'd paths.
	// Passing explicit :(exclude) pathspecs here makes git error ("paths are
	// ignored ... use -f") when `.` matches an ignored dir like node_modules.
	// So we stage everything non-ignored, then filter junk at DIFF time instead.
	git(repoDir, ["add", "-A"], { stdio: "ignore" });
	const patch = git(repoDir, ["diff", "--cached", "--no-color", ref, "--", ".", ...ex]).toString();
	const files = git(repoDir, ["diff", "--cached", "--name-only", ref, "--", ".", ...ex])
		.toString()
		.split("\n")
		.map((s) => s.trim())
		.filter(Boolean);

	git(repoDir, ["reset", "-q"], { stdio: "ignore" });

	const isTest = (f) =>
		/(^|\/)(tests?|__tests__|spec|specs)(\/|$)/i.test(f) ||
		/(\.test\.|\.spec\.|_test\.|test_)/i.test(f) ||
		testGlobs.some((g) => g && f.includes(g));

	return { patch, touchedTestFiles: files.filter(isTest), files };
}
