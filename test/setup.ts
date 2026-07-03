import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

// Global test isolation: no test may ever read or write the real ~/.cliclaw.
//
// Every path Cliclaw derives from the user's home directory goes through
// getConfigDir() in src/utils/config.ts, which honors the CLICLAW_HOME env
// var. We point it at a throwaway temp dir here. HOME/USERPROFILE are also
// redirected so that any stray os.homedir() call (in src or in a test) lands
// in the sandbox instead of the real home directory.
//
// This file runs once per test file (vitest setupFiles), before the test
// module and any src modules are imported, so even module-level path
// constants resolve inside the sandbox.
const sandboxHome = mkdtempSync(join(tmpdir(), "cliclaw-test-home-"));
process.env.HOME = sandboxHome;
process.env.USERPROFILE = sandboxHome;
process.env.CLICLAW_HOME = join(sandboxHome, ".cliclaw");

// Tripwire: if homedir() doesn't follow the redirected HOME on this platform,
// fail the whole file loudly rather than silently touching the real home.
if (homedir() !== sandboxHome) {
	throw new Error(
		`Test isolation broken: os.homedir() is "${homedir()}" but the sandbox is "${sandboxHome}". ` +
			"Tests must never touch the real home directory.",
	);
}

afterAll(() => {
	rmSync(sandboxHome, { recursive: true, force: true });
});
