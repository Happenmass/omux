import chalk from "chalk";
import { checkApiKey } from "./checks/api-key.js";
import { checkConfig } from "./checks/config.js";
import { checkTmux } from "./checks/tmux.js";
import { formatReport } from "./formatter.js";
import type { CheckResult } from "./types.js";

/**
 * Runs all health checks concurrently and prints a formatted report.
 *
 * Sets `process.exitCode` to 1 if any check fails, but never calls
 * `process.exit()` directly so the event loop can clean up.
 */
export async function runDoctor(): Promise<void> {
	console.log(`\n${chalk.bold("Omux Doctor")}\n`);

	const checks = [checkTmux, checkConfig, checkApiKey];
	const results: CheckResult[] = [];

	try {
		const settled = await Promise.allSettled(checks.map((fn) => fn()));

		for (const outcome of settled) {
			if (outcome.status === "fulfilled") {
				results.push(outcome.value);
			} else {
				results.push({
					name: "unknown",
					status: "fail",
					message: `Check threw: ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`,
				});
			}
		}
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(chalk.red("Unexpected error running health checks:"), msg);
		process.exitCode = 1;
		return;
	}

	console.log(formatReport(results));
	console.log();

	const hasFail = results.some((r) => r.status === "fail");
	process.exitCode = hasFail ? 1 : 0;
}
