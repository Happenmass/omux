// WebSocket driver for cliclaw. Authenticates via the Set-Cookie handed out on
// any non-/api GET, opens /ws, sends one task message, and waits for the
// MainAgent (and the sub-agent it dispatches) to complete the task.
//
// Completion model — IMPORTANT (see src/core/main-agent.ts):
//   - `assistant_done` is broadcast after EVERY LLM round (incl. mid tool-loop),
//     so it is NOT a turn boundary. Only `state: idle` is reliable.
//   - But cliclaw's orchestration goes: dispatch sub-agent -> MainAgent returns
//     to `idle` and WAITS for an agent_event -> wakes to `executing` again when
//     the sub-agent finishes. So a bare `idle` does NOT mean the task is done.
//   - Therefore: finish only on a completion SENTINEL in the assistant text.
//     While idle, keep waiting as long as a sub-agent is `active` (polled via
//     /api/agents/terminals). Only nudge if MainAgent stays idle with NO active
//     sub-agent for `graceMs`. Give up after `maxNudges`, or on `timeoutMs`.
import http from "node:http";
import { WebSocket } from "ws";
import { httpGetJson } from "./api.mjs";
import { DONE_SENTINEL, FAIL_SENTINEL } from "./prompt.mjs";

/** GET baseUrl/ and return the `cliclaw_auth=...` cookie pair. */
export function fetchAuthCookie(baseUrl) {
	return new Promise((resolve, reject) => {
		const req = http.get(`${baseUrl}/`, (res) => {
			res.resume();
			const setCookies = res.headers["set-cookie"] ?? [];
			const pair = setCookies
				.map((c) => c.split(";")[0].trim())
				.find((c) => c.startsWith("cliclaw_auth="));
			if (pair) resolve(pair);
			else reject(new Error(`No cliclaw_auth cookie from ${baseUrl} (status ${res.statusCode})`));
		});
		req.on("error", reject);
		req.setTimeout(5000, () => req.destroy(new Error("auth cookie fetch timeout")));
	});
}

const NUDGE_TEXT =
	"Are you finished? If the task is complete and saved to the working tree, reply with a final " +
	`message whose last line is exactly ${DONE_SENTINEL}. If you are blocked, reply ${FAIL_SENTINEL}: <reason>>. ` +
	"Otherwise keep working.";

/**
 * @param {object} o
 * @param {string} o.baseUrl
 * @param {string} o.task
 * @param {number} [o.timeoutMs]   overall wall-clock budget (default 30min)
 * @param {number} [o.graceMs]     idle + no active sub-agent before nudging (default 120s)
 * @param {number} [o.pollMs]      agent-status poll cadence (default 8s)
 * @param {number} [o.maxNudges]
 * @param {(e:object)=>void} [o.onEvent]
 * @returns {Promise<{status:"done"|"failed"|"timeout"|"stalled", finalText:string, nudges:number, transcript:object[]}>}
 */
export async function runTask(o) {
	const { baseUrl, task, timeoutMs = 30 * 60 * 1000, graceMs = 120 * 1000, pollMs = 8000, maxNudges = 3, onEvent } = o;
	const cookie = await fetchAuthCookie(baseUrl);
	const ws = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/ws`, { headers: { Cookie: cookie } });

	const transcript = [];
	let text = ""; // accumulated assistant text since the last (re)send
	let mainIdle = false;
	let lastActivityAt = Date.now();
	let nudges = 0;
	let settled = false;

	const hasSentinel = () => text.includes(DONE_SENTINEL) || text.includes(FAIL_SENTINEL);

	return await new Promise((resolve, reject) => {
		const finish = (status) => {
			if (settled) return;
			settled = true;
			clearTimeout(hardTimer);
			clearInterval(poll);
			try {
				ws.close();
			} catch {}
			resolve({ status, finalText: text, nudges, transcript });
		};

		const checkSentinel = () => {
			if (text.includes(DONE_SENTINEL)) return finish("done"), true;
			if (text.includes(FAIL_SENTINEL)) return finish("failed"), true;
			return false;
		};

		const hardTimer = setTimeout(() => finish("timeout"), timeoutMs);

		const send = (content) => {
			text = "";
			mainIdle = false;
			lastActivityAt = Date.now();
			ws.send(JSON.stringify({ type: "message", content }));
		};

		// Periodic supervisor: nudge only when genuinely stuck.
		const poll = setInterval(async () => {
			if (settled) return;
			if (checkSentinel()) return;
			let active = false;
			try {
				const agents = await httpGetJson(baseUrl, cookie, "/api/agents/terminals");
				active = (agents ?? []).some((a) => a.status === "active");
				if (active) lastActivityAt = Date.now(); // sub-agent is working — stay patient
			} catch {}
			if (!mainIdle) return; // MainAgent itself is busy
			if (active) return;
			if (Date.now() - lastActivityAt < graceMs) return; // within grace window
			// Idle, no active sub-agent, grace elapsed -> stuck.
			if (nudges >= maxNudges) return finish("stalled");
			nudges++;
			onEvent?.({ kind: "nudge", n: nudges });
			send(NUDGE_TEXT);
		}, pollMs);

		ws.on("open", () => {
			onEvent?.({ kind: "open" });
			onEvent?.({ kind: "send_task" });
			send(task);
		});

		ws.on("message", (raw) => {
			let msg;
			try {
				msg = JSON.parse(raw.toString());
			} catch {
				return;
			}
			switch (msg.type) {
				case "state":
					onEvent?.({ kind: "state", state: msg.state });
					if (msg.state === "executing") {
						mainIdle = false;
						lastActivityAt = Date.now();
					} else if (msg.state === "idle") {
						mainIdle = true;
						checkSentinel(); // a finished task ends with the sentinel
					}
					break;
				case "assistant_delta":
					text += msg.delta ?? "";
					lastActivityAt = Date.now();
					break;
				case "agent_update":
					transcript.push({ role: "agent_update", text: msg.summary ?? "" });
					lastActivityAt = Date.now();
					onEvent?.({ kind: "agent_update", summary: msg.summary });
					break;
				case "tool_activity":
					lastActivityAt = Date.now();
					break;
				case "system":
					transcript.push({ role: "system", text: msg.message ?? "" });
					break;
				default:
					break;
			}
		});

		ws.on("error", (err) => {
			if (settled) return;
			settled = true;
			clearTimeout(hardTimer);
			clearInterval(poll);
			reject(err);
		});
		ws.on("close", () => {
			if (!settled) finish(hasSentinel() ? (text.includes(DONE_SENTINEL) ? "done" : "failed") : "stalled");
		});
	});
}
