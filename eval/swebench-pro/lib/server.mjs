// Launch an ISOLATED cliclaw server for one eval instance.
//
// Why isolation matters: the user's real ~/.cliclaw/memory.sqlite holds their
// live conversation + memory. We must never read, pollute, or clear it. So each
// instance runs under a throwaway $HOME containing a slimmed eval config. The
// real Claude Code credentials (~/.claude.json) are copied in so the sub-agent
// stays authenticated under the overridden HOME.
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { getFreePort, sleep, waitForPort } from "./util.mjs";

/** Build a slimmed config.json for eval from the user's real one. */
function buildEvalConfig(realConfigPath, { keepMcp = false } = {}) {
	const real = JSON.parse(readFileSync(realConfigPath, "utf8"));
	return {
		defaultAgent: real.defaultAgent ?? "claude-code",
		debug: false,
		llm: real.llm, // provider/model/apiKey/baseUrl — the orchestrator brain
		providers: real.providers, // in case keys live here
		context: real.context ?? { contextWindowLimit: 258000, compressionThreshold: 0.9 },
		stateDetector: real.stateDetector,
		tmux: real.tmux ?? { sessionPrefix: "cliclaw" },
		// embeddings off: no per-instance memory recall is needed and it avoids
		// loading the local embedder; memory falls back to FTS-only.
		memory: { ...(real.memory ?? {}), embeddingProvider: "none" },
		skills: { disabled: [] },
		learning: { enabled: false },
		mdns: { enabled: false, name: "cliclaw-eval" },
		mcpServers: keepMcp ? (real.mcpServers ?? {}) : {},
	};
}

/**
 * @param {object} o
 * @param {string} o.repoDir     working dir = repo root at base_commit
 * @param {string} o.distMain    absolute path to cliclaw dist/main.js
 * @param {number} [o.port]
 * @param {string} [o.agent]     "claude-code" | "codex"
 * @param {boolean} [o.keepMcp]
 * @param {(line:string)=>void} [o.onLog]
 * @returns {Promise<{baseUrl:string, port:number, home:string, stop:()=>Promise<void>}>}
 */
export async function startIsolatedCliclaw(o) {
	const { repoDir, distMain, agent = "claude-code", keepMcp = false, onLog } = o;
	const port = o.port ?? (await getFreePort());

	const home = mkdtempSync(join(tmpdir(), "cliclaw-eval-home-"));
	mkdirSync(join(home, ".cliclaw"), { recursive: true });

	// Seed the isolated config from the real one.
	const realConfig = join(homedir(), ".cliclaw", "config.json");
	if (!existsSync(realConfig)) throw new Error(`Real cliclaw config not found at ${realConfig}`);
	writeFileSync(join(home, ".cliclaw", "config.json"), JSON.stringify(buildEvalConfig(realConfig, { keepMcp }), null, 2));

	// Carry Claude Code auth across the HOME override.
	const realClaudeJson = join(homedir(), ".claude.json");
	if (existsSync(realClaudeJson)) cpSync(realClaudeJson, join(home, ".claude.json"));
	mkdirSync(join(home, ".claude"), { recursive: true });
	// Copy credential material if present (macOS may instead use the Keychain,
	// which is unaffected by HOME, so a missing file here is not fatal).
	for (const f of [".credentials.json", "settings.json"]) {
		const src = join(homedir(), ".claude", f);
		if (existsSync(src)) cpSync(src, join(home, ".claude", f));
	}

	// Give this instance its OWN tmux server via an isolated TMUX_TMPDIR. tmux
	// keys its default socket off $TMUX_TMPDIR, so this fully isolates us from
	// the user's running cliclaw — whose sub-agent sessions would otherwise be
	// adopted at startup (listCliclawAgents() hardcodes the "cliclaw-" prefix).
	const tmuxTmp = join(home, "tmux");
	mkdirSync(tmuxTmp, { recursive: true });

	// Auth split: Claude Code's subscription token lives in the macOS login
	// Keychain and is only found under the user's REAL home (verified: a copied
	// or symlinked ~/.claude under a temp HOME still reports "Not logged in").
	// tmux panes inherit HOME from the SERVER's global environment, not the
	// client's. So we pre-start this instance's tmux server with the real HOME
	// (-> sub-agent panes authenticate), while the cliclaw PROCESS runs with
	// HOME=temp (-> isolated ~/.cliclaw, the user's memory.sqlite is untouched).
	const realHome = o.realHome ?? process.env.HOME ?? homedir();
	try {
		execFileSync("tmux", ["new-session", "-d", "-s", "__evalboot__", "-c", repoDir], {
			env: { ...process.env, HOME: realHome, TMUX_TMPDIR: tmuxTmp },
			stdio: "ignore",
		});
		execFileSync("tmux", ["set-environment", "-g", "HOME", realHome], {
			env: { ...process.env, TMUX_TMPDIR: tmuxTmp },
			stdio: "ignore",
		});
	} catch (err) {
		onLog?.(`[server] tmux bootstrap failed (sub-agent auth may break): ${err.message}\n`);
	}

	const args = [
		"--max-old-space-size=4096",
		distMain,
		"serve",
		"--host",
		"127.0.0.1",
		"--port",
		String(port),
		"--cwd",
		repoDir,
		"--no-mdns",
		"--agent",
		agent,
	];

	const child = spawn(process.execPath, args, {
		cwd: repoDir,
		env: { ...process.env, HOME: home, TMUX_TMPDIR: tmuxTmp, CLICLAW_DAEMON: "1" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	child.stdout.on("data", (d) => onLog?.(d.toString()));
	child.stderr.on("data", (d) => onLog?.(d.toString()));

	const up = await waitForPort("127.0.0.1", port, 60000);
	if (!up) {
		child.kill("SIGKILL");
		rmSync(home, { recursive: true, force: true });
		throw new Error(`cliclaw did not come up on port ${port} within 60s`);
	}

	const stop = async () => {
		try {
			child.kill("SIGTERM");
			const deadline = Date.now() + 8000;
			while (Date.now() < deadline && child.exitCode === null) await sleep(200);
			if (child.exitCode === null) child.kill("SIGKILL");
			// Tear down this instance's isolated tmux server (and its sub-agent panes).
			try {
				execFileSync("tmux", ["kill-server"], { env: { ...process.env, TMUX_TMPDIR: tmuxTmp }, stdio: "ignore" });
			} catch {}
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	};

	return { baseUrl: `http://127.0.0.1:${port}`, port, home, tmuxTmp, stop };
}
