// Minimal stand-in for a cliclaw server that speaks just enough of the real
// protocol to exercise lib/driver.mjs without an LLM, tmux, or Docker:
//   - GET /        -> Set-Cookie: cliclaw_auth=<token>   (matches src/server/auth.ts)
//   - WS /ws       -> {state}, {assistant_delta}, {assistant_done} like MainAgent
// When it "finishes" a turn it optionally applies a real edit to MOCK_REPO so
// the patch-extraction path has something to capture.
import http from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.MOCK_PORT || 0);
const SCENARIO = process.env.MOCK_SCENARIO || "done"; // done | nudge | fail
const REPO = process.env.MOCK_REPO;
const FILE = process.env.MOCK_FILE;
const FROM = process.env.MOCK_FIX_FROM;
const TO = process.env.MOCK_FIX_TO;
const TOKEN = "mock-token-abc123";

function applyFix() {
	if (!REPO || !FILE || FROM == null || TO == null) return;
	const p = join(REPO, FILE);
	const cur = readFileSync(p, "utf8");
	writeFileSync(p, cur.split(FROM).join(TO));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = http.createServer((req, res) => {
	if (req.method === "GET" && req.url?.startsWith("/api/")) {
		// e.g. /api/agents/terminals — the driver polls this. No sub-agents here.
		res.writeHead(200, { "content-type": "application/json" });
		res.end("[]");
		return;
	}
	if (req.method === "GET") {
		res.setHeader("Set-Cookie", `cliclaw_auth=${TOKEN}; Path=/; HttpOnly; SameSite=Strict`);
		res.writeHead(200, { "content-type": "text/plain" });
		res.end("ok");
		return;
	}
	res.writeHead(404);
	res.end();
});

const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (ws) => {
	ws.send(JSON.stringify({ type: "state", state: "idle" }));
	let msgCount = 0;
	ws.on("message", async (raw) => {
		let m;
		try {
			m = JSON.parse(raw.toString());
		} catch {
			return;
		}
		if (m.type !== "message") return;
		msgCount++;
		await runTurn(ws, msgCount);
	});
});

async function runTurn(ws, n) {
	ws.send(JSON.stringify({ type: "state", state: "executing" }));
	await sleep(20);
	ws.send(JSON.stringify({ type: "assistant_delta", delta: "working...\n" }));
	await sleep(20);

	let last;
	if (SCENARIO === "fail") {
		last = "cannot proceed\n<<CLICLAW_EVAL_FAILED: missing info>>";
	} else if (SCENARIO === "nudge" && n === 1) {
		last = "I have dispatched a sub-agent and it is now working."; // no sentinel -> driver nudges
	} else {
		applyFix();
		last = "patch applied to working tree\n<<CLICLAW_EVAL_DONE>>";
	}

	ws.send(JSON.stringify({ type: "assistant_delta", delta: last }));
	ws.send(JSON.stringify({ type: "assistant_done" }));
	ws.send(JSON.stringify({ type: "state", state: "idle" }));
}

server.listen(PORT, "127.0.0.1", () => {
	const addr = server.address();
	// First stdout line is machine-readable for the smoke harness.
	console.log(JSON.stringify({ ready: true, port: addr.port }));
});
