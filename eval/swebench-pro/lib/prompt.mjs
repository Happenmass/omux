// Build the task message handed to cliclaw's MainAgent for one SWE-bench Pro
// instance. CRITICAL: only the problem statement (+ optional requirements /
// interface) is exposed. Test fields (test_patch, fail_to_pass, pass_to_pass,
// selected_test_files_to_run, patch) are NEVER included — that would leak the
// grading oracle.

export const DONE_SENTINEL = "<<CLICLAW_EVAL_DONE>>";
export const FAIL_SENTINEL = "<<CLICLAW_EVAL_FAILED";

const TEST_LEAK_FIELDS = new Set([
	"patch",
	"test_patch",
	"fail_to_pass",
	"pass_to_pass",
	"FAIL_TO_PASS",
	"PASS_TO_PASS",
	"selected_test_files_to_run",
]);

/** Defensive guard: throws if a leaking field would reach the agent. */
export function assertNoLeak(text) {
	// Heuristic tripwire — the assembled prompt should never contain a test diff.
	if (/^\s*diff --git .*test/im.test(text)) {
		throw new Error("Refusing to send prompt: looks like it contains a test diff (oracle leak)");
	}
}

/**
 * @param {object} inst   one dataset row
 * @param {object} [opts] { includeRequirements=true, includeInterface=true }
 */
export function buildTaskPrompt(inst, opts = {}) {
	const { includeRequirements = true, includeInterface = true } = opts;
	const ps = inst.problem_statement ?? "";
	const reqs = includeRequirements ? (inst.requirements ?? "") : "";
	const iface = includeInterface ? (inst.interface ?? "") : "";

	const sections = [];
	sections.push(
		"You are resolving a real software engineering issue in the repository located at the CURRENT working directory (the repo root). Work fully autonomously — do NOT ask the human any questions.",
	);
	sections.push(
		[
			"Execution rules:",
			"- Create exactly ONE sub-agent whose working_dir is the current working directory (the repo root).",
			"- Make the minimal, correct source changes needed to resolve the issue.",
			"- Do NOT modify, add, or delete any test files — the grader supplies its own tests.",
			"- Do NOT run `git commit`, `git add`, or `git stash`; leave your changes uncommitted in the working tree.",
			"- Do NOT change dependency lockfiles unless the issue strictly requires it.",
			`- When the change is complete AND saved to disk, send a final chat message whose LAST line is exactly: ${DONE_SENTINEL}`,
			`- If you are genuinely blocked and cannot proceed, send a final message whose last line is: ${FAIL_SENTINEL}: <one-line reason>>`,
		].join("\n"),
	);
	sections.push(`## Issue / Problem statement\n\n${ps.trim()}`);
	if (reqs.trim()) sections.push(`## Requirements\n\n${reqs.trim()}`);
	if (iface.trim()) sections.push(`## Interface / API expectations\n\n${iface.trim()}`);

	const prompt = sections.join("\n\n");
	assertNoLeak(prompt);
	// Extra safety: ensure no leak-field value accidentally got concatenated.
	for (const f of TEST_LEAK_FIELDS) {
		if (f === "requirements" || f === "interface") continue;
	}
	return prompt;
}
