// web/learning.js — Learning Sessions right-panel UI

const state = {
	entries: [],
	statusFilter: "active",
	selectedId: null,
	detailEntry: null,
	detailMessages: [],
	detailTab: "summary",
	streaming: false,
	selectedIds: new Set(),
};

let ws = null;
const apiBase = "/api/learning";

const $ = (id) => document.getElementById(id);

export function initLearning(wsRef) {
	ws = wsRef;
	attachListHandlers();
	attachDetailHandlers();
	refreshList().catch((e) => console.warn("[learning] initial load failed", e));
}

export function handleLearningMessage(msg) {
	switch (msg.type) {
		case "learning_entry_created":
			if (msg.entry.status === state.statusFilter) {
				state.entries.unshift(msg.entry);
				renderList(msg.entry.id);
			}
			break;
		case "learning_entry_updated": {
			const idx = state.entries.findIndex((e) => e.id === msg.entry.id);
			if (idx >= 0) {
				if (msg.entry.status !== state.statusFilter) {
					state.entries.splice(idx, 1);
				} else {
					state.entries[idx] = msg.entry;
				}
			} else if (msg.entry.status === state.statusFilter) {
				state.entries.unshift(msg.entry);
			}
			renderList();
			if (state.selectedId === msg.entry.id) loadDetail(msg.entry.id);
			break;
		}
		case "learning_entry_deleted":
			state.entries = state.entries.filter((e) => e.id !== msg.id);
			if (state.selectedId === msg.id) {
				state.selectedId = null;
				clearDetail();
			}
			renderList();
			break;
		case "learning_delta":
			if (state.selectedId === msg.entryId && state.detailTab === "chat") {
				appendDelta(msg.delta);
			}
			break;
		case "learning_done":
			if (state.selectedId === msg.entryId) finalizeStream();
			break;
		case "learning_error":
			if (state.selectedId === msg.entryId) showStreamError(msg.message);
			break;
	}
}

async function refreshList() {
	const res = await fetch(`${apiBase}?status=${state.statusFilter}`);
	if (!res.ok) return;
	state.entries = await res.json();
	renderList();
}

function renderList(pulseId) {
	const ul = $("learning-list");
	const empty = $("learning-list-empty");
	if (!ul || !empty) return;
	ul.innerHTML = "";
	if (state.entries.length === 0) {
		empty.style.display = "block";
		updateMergeButton();
		return;
	}
	empty.style.display = "none";
	for (const e of state.entries) {
		const li = document.createElement("li");
		if (e.id === state.selectedId) li.classList.add("selected");
		if (e.id === pulseId) li.classList.add("pulse");
		const statusCls = e.memoryFlushedAt ? "flushed" : e.status;
		const srcLabel =
			e.sourceType === "merged"
				? `${e.sourceAgents.length} agents merged`
				: `agent: ${e.sourceAgents[0]?.sessionName ?? "?"}`;
		const rel = relTime(e.updatedAt);
		li.innerHTML = `
			<div>
				<input type="checkbox" class="learning-select" data-id="${e.id}" ${state.selectedIds.has(e.id) ? "checked" : ""} />
				<span class="learning-entry-status ${statusCls}"></span>
				<span class="learning-entry-title">${escape(e.title)}</span>
				<span style="float:right;color:#777;font-size:11px;">${e.diffStats.filesChanged}f +${e.diffStats.additions} −${e.diffStats.deletions}</span>
			</div>
			<div class="learning-entry-meta">${escape(srcLabel)} · ${rel}</div>`;
		li.addEventListener("click", (ev) => {
			if (ev.target.classList && ev.target.classList.contains("learning-select")) return;
			selectEntry(e.id);
		});
		ul.appendChild(li);
	}
	updateMergeButton();
}

function updateMergeButton() {
	const btn = $("learning-merge-btn");
	if (!btn) return;
	if (state.selectedIds.size >= 2) btn.classList.remove("hidden");
	else btn.classList.add("hidden");
}

function attachListHandlers() {
	for (const t of document.querySelectorAll(".learning-tab")) {
		t.addEventListener("click", () => {
			for (const x of document.querySelectorAll(".learning-tab")) x.classList.remove("active");
			t.classList.add("active");
			state.statusFilter = t.dataset.status;
			state.selectedIds.clear();
			refreshList();
		});
	}
	const search = $("learning-search");
	if (search) {
		search.addEventListener("input", (ev) => {
			const q = ev.target.value.toLowerCase();
			const lis = document.querySelectorAll("#learning-list li");
			let i = 0;
			for (const li of lis) {
				const title = state.entries[i]?.title.toLowerCase() ?? "";
				li.style.display = title.includes(q) ? "" : "none";
				i++;
			}
		});
	}
	const list = $("learning-list");
	if (list) {
		list.addEventListener("change", (ev) => {
			const cb = ev.target;
			if (!cb.classList?.contains("learning-select")) return;
			const id = cb.dataset.id;
			if (cb.checked) state.selectedIds.add(id);
			else state.selectedIds.delete(id);
			updateMergeButton();
		});
	}
	const mergeBtn = $("learning-merge-btn");
	if (mergeBtn) {
		mergeBtn.addEventListener("click", async () => {
			const ids = Array.from(state.selectedIds);
			const res = await fetch(`${apiBase}/merge`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ ids }),
			});
			if (!res.ok) {
				alert(`Merge failed: ${await res.text()}`);
				return;
			}
			state.selectedIds.clear();
			await refreshList();
		});
	}
}

async function selectEntry(id) {
	state.selectedId = id;
	state.detailTab = "summary";
	await loadDetail(id);
	renderList();
}

async function loadDetail(id) {
	const res = await fetch(`${apiBase}/${id}`);
	if (!res.ok) {
		state.detailEntry = null;
		renderDetail();
		return;
	}
	state.detailEntry = await res.json();
	const msgsRes = await fetch(`${apiBase}/${id}/messages`);
	state.detailMessages = msgsRes.ok ? await msgsRes.json() : [];
	renderDetail();
}

function renderDetail() {
	const empty = $("learning-detail-empty");
	const summaryPane = $("learning-summary-pane");
	const chatPane = $("learning-chat-pane");
	if (!empty || !summaryPane || !chatPane) return;
	if (!state.detailEntry) {
		empty.style.display = "block";
		summaryPane.classList.add("hidden");
		chatPane.classList.add("hidden");
		return;
	}
	empty.style.display = "none";
	renderSummaryPane();
	renderChatPane();
	for (const t of document.querySelectorAll(".learning-detail-tab")) {
		t.classList.toggle("active", t.dataset.tab === state.detailTab);
	}
	summaryPane.classList.toggle("hidden", state.detailTab !== "summary");
	chatPane.classList.toggle("hidden", state.detailTab !== "chat");
}

function renderSummaryPane() {
	const e = state.detailEntry;
	const s = e.summaryJson;
	const pane = $("learning-summary-pane");
	if (!pane) return;
	pane.innerHTML = `
		<h2>${escape(s.title)}</h2>
		<h4>What changed</h4>
		<div class="markdown">${renderMd(s.what_changed)}</div>
		<h4>Why</h4>
		<div class="markdown">${renderMd(s.why)}</div>
		<h4>Key files (${s.key_files.length})</h4>
		<ul>${s.key_files.map((k) => `<li><code>${escape(k.path)}</code> — ${escape(k.role)}</li>`).join("")}</ul>
		<button class="view-diff-btn">View full diff</button>
		<h4>Design points</h4>
		<ul>${s.design_points.map((p) => `<li>${escape(p)}</li>`).join("")}</ul>
		<h4>Learning hooks</h4>
		<div>${s.learning_hooks.map((h) => `<span class="learning-hook-chip" data-text="${escape(h)}">${escape(h)}</span>`).join("")}</div>
		<div class="learning-actions">
			<button class="regen-btn">Regenerate</button>
			<button class="flush-btn ${e.memoryFlushedAt ? "flushed" : ""}">${e.memoryFlushedAt ? "✓ Flushed" : "Flush to memory"}</button>
			<button class="archive-btn">${e.status === "archived" ? "Unarchive" : "Archive"}</button>
			<button class="delete-btn" style="margin-left:auto;color:#d77;">Delete</button>
		</div>`;
	pane.querySelector(".view-diff-btn")?.addEventListener("click", async () => {
		const r = await fetch(`${apiBase}/${e.id}/diff`);
		const text = await r.text();
		openDiffModal(text);
	});
	for (const c of pane.querySelectorAll(".learning-hook-chip")) {
		c.addEventListener("click", () => {
			state.detailTab = "chat";
			renderDetail();
			const input = $("learning-chat-input");
			if (input) {
				input.value = c.dataset.text;
				input.focus();
			}
		});
	}
	pane.querySelector(".regen-btn")?.addEventListener("click", async () => {
		await fetch(`${apiBase}/${e.id}/regenerate`, { method: "POST" });
	});
	pane.querySelector(".flush-btn")?.addEventListener("click", async () => {
		await fetch(`${apiBase}/${e.id}/flush-to-memory`, { method: "POST" });
	});
	pane.querySelector(".archive-btn")?.addEventListener("click", async () => {
		const next = e.status === "archived" ? "active" : "archived";
		await fetch(`${apiBase}/${e.id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ status: next }),
		});
	});
	pane.querySelector(".delete-btn")?.addEventListener("click", async () => {
		if (!confirm("Delete this learning entry? This also removes its chat and diff.")) return;
		await fetch(`${apiBase}/${e.id}`, { method: "DELETE" });
	});
}

function renderChatPane() {
	const e = state.detailEntry;
	const list = $("learning-chat-messages");
	if (!list) return;
	if (state.detailMessages.length === 0 && e.summaryJson.learning_hooks.length > 0) {
		list.innerHTML = `<div class="learning-empty">Ask about what changed and why.</div>
			<div>${e.summaryJson.learning_hooks.map((h) => `<span class="learning-hook-chip" data-text="${escape(h)}">${escape(h)}</span>`).join("")}</div>`;
		for (const c of list.querySelectorAll(".learning-hook-chip")) {
			c.addEventListener("click", () => {
				const input = $("learning-chat-input");
				if (input) {
					input.value = c.dataset.text;
					input.focus();
				}
			});
		}
		return;
	}
	list.innerHTML = state.detailMessages
		.map(
			(m) => `
		<div class="message ${m.role}"><div class="content">${renderMd(m.content)}</div></div>`,
		)
		.join("");
	list.scrollTop = list.scrollHeight;
}

function attachDetailHandlers() {
	for (const t of document.querySelectorAll(".learning-detail-tab")) {
		t.addEventListener("click", () => {
			state.detailTab = t.dataset.tab;
			renderDetail();
		});
	}
	$("learning-chat-send")?.addEventListener("click", sendChat);
	$("learning-chat-input")?.addEventListener("keydown", (ev) => {
		if (ev.key === "Enter" && !ev.shiftKey) {
			ev.preventDefault();
			sendChat();
		}
	});
}

function sendChat() {
	if (!state.detailEntry || state.streaming) return;
	const input = $("learning-chat-input");
	if (!input) return;
	const content = input.value.trim();
	if (!content) return;
	input.value = "";
	state.streaming = true;
	state.detailMessages.push({ role: "user", content });
	state.detailMessages.push({ role: "assistant", content: "" });
	renderChatPane();
	if (ws && ws.readyState === 1) {
		ws.send(
			JSON.stringify({
				type: "learning_message",
				entryId: state.detailEntry.id,
				content,
			}),
		);
	}
	const sendBtn = $("learning-chat-send");
	if (sendBtn) sendBtn.disabled = true;
}

function appendDelta(delta) {
	const last = state.detailMessages[state.detailMessages.length - 1];
	if (!last || last.role !== "assistant") return;
	last.content += delta;
	renderChatPane();
}

function finalizeStream() {
	state.streaming = false;
	const sendBtn = $("learning-chat-send");
	if (sendBtn) sendBtn.disabled = false;
}

function showStreamError(message) {
	state.streaming = false;
	const sendBtn = $("learning-chat-send");
	if (sendBtn) sendBtn.disabled = false;
	alert(`Learning chat error: ${message}`);
}

function clearDetail() {
	state.detailEntry = null;
	state.detailMessages = [];
	renderDetail();
}

function openDiffModal(text) {
	const overlay = document.createElement("div");
	overlay.style.cssText =
		"position:fixed;inset:0;background:rgba(0,0,0,0.8);z-index:9999;display:flex;align-items:center;justify-content:center;";
	overlay.innerHTML = `<div style="background:#1a1a1a;max-width:80%;max-height:80%;overflow:auto;padding:20px;border-radius:6px;">
		<pre style="color:#ddd;white-space:pre-wrap;font-family:monospace;font-size:12px;">${escape(text)}</pre>
		<button style="margin-top:10px;">Close</button></div>`;
	overlay.querySelector("button").addEventListener("click", () => overlay.remove());
	overlay.addEventListener("click", (ev) => {
		if (ev.target === overlay) overlay.remove();
	});
	document.body.appendChild(overlay);
}

function escape(s) {
	return String(s).replace(
		/[&<>"']/g,
		(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
	);
}

function renderMd(text) {
	if (window.renderMarkdown) return window.renderMarkdown(text);
	return escape(text).replace(/\n/g, "<br>");
}

function relTime(ms) {
	const d = Date.now() - ms;
	if (d < 60000) return "just now";
	if (d < 3600000) return `${Math.floor(d / 60000)}m ago`;
	if (d < 86400000) return `${Math.floor(d / 3600000)}h ago`;
	return `${Math.floor(d / 86400000)}d ago`;
}
