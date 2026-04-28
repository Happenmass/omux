// ─── Cliclaw Chat UI ──────────────────────────────
// Note: Learning Sessions panel is hidden in this UI (deprecated).
// Backend learning REST/WS endpoints still exist; they're simply not surfaced.
import { initI18n } from "./i18n.js";

let messagesEl;
let contentEl;
let executionPanelEl;
let executionResizeHandleEl;
let executionReopenBtn;
let inputEl;
let inputAreaEl;
let sendBtn;
let statusDot;
let statusText;
let queuePillEl;
let inputMetaModelEl;
let dropdownEl;
let agentTabsEl;
let terminalContentEl;
let terminalEmptyEl;
let terminalStatusbarEl;
let terminalCardEl;
let terminalImeInputEl;
let imeComposing = false;
let mobileDragHandleEl;
let mobilePeekRowEl;
let mobilePeekDotEl;
let mobilePeekNameEl;
let mobilePeekMetaEl;
let mobilePeekTailEl;
let sheetState = "peek"; // "peek" | "full"
let terminalStatusbarStateEl;
let terminalStatusbarCwdEl;
let takeoverBtnEl;
let takeoverBtnLabelEl;
let abortBtnEl;
let themeToggleEl;
let themeIconSunEl;
let themeIconMoonEl;

let ws = null;
let currentAssistantEl = null;
let reconnectTimer = null;
let agentState = "idle";
let thinkingEl = null;
let thinkingTimer = null;
let thinkingStartedAt = 0;
let queueSize = 0;
let commands = [];
let activeIndex = -1;
let isDropdownOpen = false;
let isExecutionPanelResizing = false;
let executionPanelHidden = false;
let lastExecutionPanelWidth = 480;
const agentTerminals = new Map();
let activeAgentTab = null;
let terminalMoreLoading = false;
let lastRenderedTerminalContent = "";
let lastTakeoverAutoFocused = false;
const EXECUTION_PANEL_DEFAULT_WIDTH = 480;
const EXECUTION_PANEL_MIN_WIDTH = 360;
const EXECUTION_PANEL_HIDE_THRESHOLD = 200;

const THEME_KEY = "cliclaw.theme";

const ANSI_STYLES = {
	30: "color:#3a2f23",
	31: "color:#b54426",
	32: "color:#658c4a",
	33: "color:#c8911f",
	34: "color:#3878b8",
	35: "color:#9558b5",
	36: "color:#3aa6a0",
	37: "color:#e8dfce",
	90: "color:#9a8a72",
	91: "color:#d4654a",
	92: "color:#a8c98c",
	93: "color:#e2b75a",
	94: "color:#7aa9da",
	95: "color:#c08bd0",
	96: "color:#7ec5be",
	97: "color:#f5f0e2",
	40: "background-color:#3a2f23",
	41: "background-color:#7c2c18",
	42: "background-color:#3d5a26",
	43: "background-color:#a06614",
	44: "background-color:#1f4877",
	45: "background-color:#552e6b",
	46: "background-color:#1a4f4b",
	47: "background-color:#d6cfbe",
};

export function escapeHtml(text) {
	return String(text)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

export function renderMarkdown(text) {
	let html = escapeHtml(text);
	html = html.replace(/```(\w*)\n([\s\S]*?)```/g, function (_match, _lang, code) {
		return "<pre><code>" + code.trim() + "</code></pre>";
	});
	html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
	html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
	html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");
	return html;
}

function styleStateToString(state) {
	return Object.values(state).filter(Boolean).join(";");
}

function applyAnsiCodes(codes, state) {
	for (const rawCode of codes) {
		const code = Number.parseInt(rawCode || "0", 10);
		if (code === 0) {
			state.color = "";
			state.background = "";
			state.weight = "";
			continue;
		}
		if (code === 1) {
			state.weight = "font-weight:700";
			continue;
		}
		if (ANSI_STYLES[code]) {
			if (code >= 40 && code <= 47) {
				state.background = ANSI_STYLES[code];
			} else {
				state.color = ANSI_STYLES[code];
			}
		}
	}
}

export function renderAnsiToHtml(text) {
	const ansiPattern = /\[([0-9;]*)m/g;
	const state = { color: "", background: "", weight: "" };

	let html = "";
	let cursor = 0;
	let match;

	while ((match = ansiPattern.exec(text)) !== null) {
		const chunk = text.slice(cursor, match.index);
		if (chunk) {
			const style = styleStateToString(state);
			const escaped = escapeHtml(chunk).replace(/\n/g, "<br>");
			html += style ? `<span style="${style}">${escaped}</span>` : escaped;
		}
		applyAnsiCodes(match[1].split(";"), state);
		cursor = ansiPattern.lastIndex;
	}

	const tail = text.slice(cursor);
	if (tail) {
		const style = styleStateToString(state);
		const escaped = escapeHtml(tail).replace(/\n/g, "<br>");
		html += style ? `<span style="${style}">${escaped}</span>` : escaped;
	}

	return html;
}

function extractText(content) {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter(function (b) { return b.type === "text"; })
			.map(function (b) { return b.text; })
			.join("");
	}
	return "";
}

export function clampExecutionPanelWidth(width, minWidth, maxWidth) {
	return Math.max(minWidth, Math.min(maxWidth, width));
}

export function getExecutionPanelWidthBounds(containerWidth, minWidth = EXECUTION_PANEL_MIN_WIDTH) {
	const maxWidth = Math.max(minWidth, Math.floor(containerWidth * 0.6));
	return { minWidth, maxWidth };
}

export function shouldHideExecutionPanel(rawWidth, hideThreshold = EXECUTION_PANEL_HIDE_THRESHOLD) {
	return rawWidth <= hideThreshold;
}

function supportsFloatingExecutionPanel() {
	return window.matchMedia("(min-width: 981px)").matches;
}

function syncSheetForViewport() {
	if (!executionPanelEl) return;
	if (isMobileViewport()) {
		// Reset desktop-only inline width
		executionPanelEl.style.removeProperty("--exec-panel-width");
		// Default to peek on mobile
		if (!executionPanelEl.classList.contains("peek") && !executionPanelEl.classList.contains("full")) {
			setSheetState("peek");
		}
	} else {
		// Strip mobile sheet classes on desktop
		executionPanelEl.classList.remove("peek");
		executionPanelEl.classList.remove("full");
	}
}

function updateExecutionPanelVisibilityControls() {
	if (!executionPanelEl) return;
	const hiddenInFloating = executionPanelHidden && supportsFloatingExecutionPanel();
	executionPanelEl.classList.toggle("execution-hidden", hiddenInFloating);
	if (executionReopenBtn) {
		executionReopenBtn.classList.toggle("visible", hiddenInFloating);
	}
}

function hideExecutionPanel() {
	if (!executionPanelEl || executionPanelHidden) return;
	if (supportsFloatingExecutionPanel()) {
		const measuredWidth = executionPanelEl.getBoundingClientRect().width;
		lastExecutionPanelWidth = clampExecutionPanelWidth(
			measuredWidth || EXECUTION_PANEL_DEFAULT_WIDTH,
			EXECUTION_PANEL_MIN_WIDTH,
			Math.max(EXECUTION_PANEL_MIN_WIDTH, contentEl ? contentEl.getBoundingClientRect().width * 0.6 : EXECUTION_PANEL_DEFAULT_WIDTH),
		);
	}
	executionPanelHidden = true;
	updateExecutionPanelVisibilityControls();
}

function showExecutionPanel() {
	if (!executionPanelEl) return;
	executionPanelHidden = false;
	updateExecutionPanelVisibilityControls();
	applyExecutionPanelWidth(lastExecutionPanelWidth);
}

function applyExecutionPanelWidth(nextWidth) {
	if (!contentEl || !executionPanelEl || !supportsFloatingExecutionPanel()) return;
	const bounds = getExecutionPanelWidthBounds(contentEl.getBoundingClientRect().width);
	const width = clampExecutionPanelWidth(nextWidth, bounds.minWidth, bounds.maxWidth);
	lastExecutionPanelWidth = width;
	executionPanelEl.style.setProperty("--exec-panel-width", `${width}px`);
}

function syncExecutionPanelWidth() {
	if (!executionPanelEl) return;
	if (!supportsFloatingExecutionPanel()) {
		executionPanelHidden = false;
		executionPanelEl.style.removeProperty("--exec-panel-width");
		updateExecutionPanelVisibilityControls();
		return;
	}
	updateExecutionPanelVisibilityControls();
	if (executionPanelHidden) return;
	applyExecutionPanelWidth(lastExecutionPanelWidth);
}

function updateExecutionPanelWidthFromPointer(clientX) {
	if (!contentEl) return;
	const bounds = contentEl.getBoundingClientRect();
	const width = bounds.right - clientX;
	if (shouldHideExecutionPanel(width)) {
		hideExecutionPanel();
		stopExecutionPanelResize();
		return;
	}
	applyExecutionPanelWidth(width);
}

function stopExecutionPanelResize() {
	if (!isExecutionPanelResizing) return;
	isExecutionPanelResizing = false;
	document.body.classList.remove("resizing-execution-panel");
}

function handleExecutionPanelResizeMove(event) {
	if (!isExecutionPanelResizing) return;
	event.preventDefault();
	updateExecutionPanelWidthFromPointer(event.clientX);
}

function startExecutionPanelResize(event) {
	if (!supportsFloatingExecutionPanel() || executionPanelHidden) return;
	event.preventDefault();
	isExecutionPanelResizing = true;
	document.body.classList.add("resizing-execution-panel");
	updateExecutionPanelWidthFromPointer(event.clientX);
}

function reopenExecutionPanel() {
	if (!supportsFloatingExecutionPanel()) return;
	showExecutionPanel();
}

// ─── Theme ─────────────────────────────────────────
function getStoredTheme() {
	try { return localStorage.getItem(THEME_KEY); } catch { return null; }
}

function setStoredTheme(value) {
	try {
		if (value) localStorage.setItem(THEME_KEY, value);
		else localStorage.removeItem(THEME_KEY);
	} catch {}
}

function effectiveTheme() {
	const stored = getStoredTheme();
	if (stored === "light" || stored === "dark") return stored;
	return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme, persist) {
	if (theme === "light" || theme === "dark") {
		document.documentElement.setAttribute("data-theme", theme);
	} else {
		document.documentElement.removeAttribute("data-theme");
	}
	if (persist !== undefined) {
		setStoredTheme(persist ? theme : null);
	}
	updateThemeIcon();
}

function updateThemeIcon() {
	const cur = effectiveTheme();
	if (themeIconSunEl) themeIconSunEl.style.display = cur === "dark" ? "" : "none";
	if (themeIconMoonEl) themeIconMoonEl.style.display = cur === "dark" ? "none" : "";
}

function toggleTheme() {
	const next = effectiveTheme() === "dark" ? "light" : "dark";
	applyTheme(next, true);
}

// ─── Status bar ────────────────────────────────────
function fetchInitStatus() {
	fetch("/api/status")
		.then(function (res) { return res.json(); })
		.then(function (data) {
			initI18n(data.locale);
			if (inputMetaModelEl) {
				const parts = [];
				if (data.model) parts.push(data.model);
				if (data.provider) parts.push(data.provider);
				inputMetaModelEl.textContent = parts.join(" · ");
			}
		})
		.catch(function () {
			initI18n();
		});
}

function connect() {
	const protocol = location.protocol === "https:" ? "wss:" : "ws:";
	ws = new WebSocket(`${protocol}//${location.host}/ws`);

	ws.onopen = function () {
		setConnectionStatus("connected");
		loadHistory();
		loadAgentTerminals();
		fetchCommands();
		fetchInitStatus();
	};

	ws.onmessage = function (event) {
		let data;
		try { data = JSON.parse(event.data); } catch { return; }
		handleServerMessage(data);
	};

	ws.onclose = function () {
		setConnectionStatus("disconnected");
		scheduleReconnect();
	};

	ws.onerror = function () {};
}

function scheduleReconnect() {
	if (reconnectTimer) return;
	reconnectTimer = setTimeout(function () {
		reconnectTimer = null;
		connect();
	}, 3000);
}

function setConnectionStatus(status) {
	if (!statusDot) return;
	statusDot.className = "";
	if (status === "connected") {
		statusDot.classList.add(agentState);
		statusText.textContent = agentState;
	} else {
		statusDot.classList.add("disconnected");
		statusText.textContent = "disconnected";
	}
	updateQueuePill();
	updateSendButtonMode();
}

const SEND_BTN_ICON_SEND =
	'<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">' +
	'<path d="M7 11.5V2.5M3 6.5L7 2.5l4 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>' +
	"</svg>";
const SEND_BTN_ICON_STOP =
	'<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">' +
	'<rect x="3.5" y="3.5" width="7" height="7" rx="1.2" fill="currentColor"/>' +
	"</svg>";

function updateSendButtonMode() {
	if (!sendBtn) return;
	const stopMode = agentState === "executing";
	sendBtn.classList.toggle("is-stop", stopMode);
	if (stopMode) {
		sendBtn.innerHTML = SEND_BTN_ICON_STOP + "Stop";
		sendBtn.title = "停止当前任务";
	} else {
		sendBtn.innerHTML = SEND_BTN_ICON_SEND + "Send";
		sendBtn.title = "发送";
	}
}

function sendStopCommand() {
	if (!ws || ws.readyState !== WebSocket.OPEN) return;
	ws.send(JSON.stringify({ type: "command", name: "stop" }));
}

function updateQueuePill() {
	if (!queuePillEl) return;
	queuePillEl.classList.toggle("visible", queueSize > 0);
}

function loadHistory() {
	Promise.all([
		fetch("/api/history").then(function (res) { return res.json(); }),
		fetch("/api/ui-events")
			.then(function (res) { return res.json(); })
			.catch(function () { return []; }),
	])
		.then(function ([messages, uiEvents]) {
			messagesEl.innerHTML = "";
			currentAssistantEl = null;
			const entries = [];

			for (let i = 0; i < messages.length; i++) {
				const msg = messages[i];
				const createdAt = Number.parseInt(String(msg.createdAt ?? i), 10);
				entries.push({
					kind: "chat",
					createdAt: Number.isFinite(createdAt) ? createdAt : i,
					index: i,
					payload: msg,
				});
			}

			for (let i = 0; i < uiEvents.length; i++) {
				const event = uiEvents[i];
				const createdAt = Number.parseInt(String(event.createdAt ?? messages.length + i), 10);
				entries.push({
					kind: "ui",
					createdAt: Number.isFinite(createdAt) ? createdAt : messages.length + i,
					index: i,
					payload: event,
				});
			}

			entries.sort(function (a, b) {
				if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
				if (a.kind !== b.kind) return a.kind === "chat" ? -1 : 1;
				return a.index - b.index;
			});

			for (const entry of entries) {
				const ts = entry.createdAt;
				if (entry.kind === "chat") {
					const msg = entry.payload;
					if (msg.role === "user") {
						const content = typeof msg.content === "string" ? msg.content : "[complex content]";
						if (content.startsWith("[HUMAN]") || content.startsWith("[RESUME]")) continue;
						addMessageBubble("user", content, ts);
					} else if (msg.role === "assistant") {
						const text = extractText(msg.content);
						if (text) addMessageBubble("assistant", text, ts);
					}
					continue;
				}

				if (entry.payload.type === "agent_update") {
					addMessageBubble("agent-update", entry.payload.summary, ts);
				} else if (entry.payload.type === "tool_activity") {
					addMessageBubble("tool-activity", entry.payload.summary, ts);
				}
			}
			scrollToBottom();
		})
		.catch(function () {});
}

function handleServerMessage(data) {
	// Learning panel is hidden in this UI; ignore learning_* events.
	if (data.type && data.type.startsWith("learning_")) return;

	switch (data.type) {
		case "assistant_delta":
			hideThinkingIndicator();
			if (!currentAssistantEl) {
				currentAssistantEl = addMessageBubble("assistant", "", Date.now());
			}
			currentAssistantEl.textContent += data.delta;
			scrollToBottom();
			break;

		case "assistant_done":
			if (currentAssistantEl) {
				currentAssistantEl.innerHTML = renderMarkdown(currentAssistantEl.textContent);
				currentAssistantEl = null;
			}
			if (agentState === "executing") {
				showThinkingIndicator();
			}
			break;

		case "agent_update":
			addMessageBubble("agent-update", data.summary, Date.now());
			moveThinkingIndicatorToEnd();
			scrollToBottom();
			break;

		case "tool_activity":
			addMessageBubble("tool-activity", data.summary, Date.now());
			moveThinkingIndicatorToEnd();
			scrollToBottom();
			break;

		case "state": {
			const prevState = agentState;
			agentState = data.state;
			if (typeof data.queueSize === "number") {
				queueSize = data.queueSize;
			}
			setConnectionStatus("connected");
			if (data.state === "executing" && !currentAssistantEl) {
				showThinkingIndicator();
			} else if (data.state === "idle") {
				hideThinkingIndicator();
			}
			if (prevState === "executing" && data.state === "idle") {
				notifyTaskComplete();
			}
			break;
		}

		case "system":
			addMessageBubble("system", data.message, Date.now());
			moveThinkingIndicatorToEnd();
			scrollToBottom();
			break;

		case "agent_terminals":
			handleAgentTerminals(data.agents);
			break;

		case "clear":
			hideThinkingIndicator();
			messagesEl.innerHTML = "";
			currentAssistantEl = null;
			addMessageBubble("system", "对话已清空", Date.now());
			break;
	}
}

function formatTimestamp(ts) {
	if (!Number.isFinite(ts)) return "";
	const d = new Date(ts);
	if (Number.isNaN(d.getTime())) return "";
	const hh = String(d.getHours()).padStart(2, "0");
	const mm = String(d.getMinutes()).padStart(2, "0");
	return `${hh}:${mm}`;
}

function addMessageBubble(type, text, ts) {
	const row = document.createElement("div");
	row.className = "msg-row " + type + "-row";

	const time = document.createElement("div");
	time.className = "msg-time";
	time.textContent = formatTimestamp(ts);
	row.appendChild(time);

	const body = document.createElement("div");
	body.className = "msg-body";

	const el = document.createElement("div");
	el.className = "msg " + type;
	if (type === "assistant" && text) {
		el.innerHTML = renderMarkdown(text);
	} else {
		el.textContent = text;
	}
	body.appendChild(el);
	row.appendChild(body);

	const tail = document.createElement("div");
	row.appendChild(tail);

	messagesEl.appendChild(row);
	return el;
}

function scrollToBottom() {
	requestAnimationFrame(function () {
		messagesEl.scrollTop = messagesEl.scrollHeight;
	});
}

function showThinkingIndicator() {
	if (!messagesEl) return;
	if (thinkingEl) {
		messagesEl.appendChild(thinkingEl);
		return;
	}
	const row = document.createElement("div");
	row.className = "msg-row thinking-row";

	const startedAt = Date.now();
	const time = document.createElement("div");
	time.className = "msg-time";
	time.textContent = formatTimestamp(startedAt);
	row.appendChild(time);

	const body = document.createElement("div");
	body.className = "msg-body";

	const ind = document.createElement("div");
	ind.className = "thinking-indicator";
	ind.setAttribute("role", "status");
	ind.setAttribute("aria-live", "polite");
	ind.innerHTML =
		'<svg class="thinking-blob" viewBox="0 0 22 22" width="16" height="16" aria-hidden="true">' +
		'<path d="M11 2.5c-1.5 2.4-1.5 4.5 0 8.5-3-1-5.5-1-7.5 0 2.4 1.5 4.5 1.5 8.5 0-1 3-1 5.5 0 7.5 1.5-2.4 1.5-4.5 0-8.5 3 1 5.5 1 7.5 0-2.4-1.5-4.5-1.5-8.5 0 1-3 1-5.5 0-7.5z" fill="currentColor"/>' +
		"</svg>" +
		'<span class="thinking-label">正在思考</span>' +
		'<span class="thinking-timer">· 0s</span>';
	body.appendChild(ind);
	row.appendChild(body);
	row.appendChild(document.createElement("div"));

	messagesEl.appendChild(row);
	thinkingEl = row;
	thinkingStartedAt = startedAt;
	const timerEl = ind.querySelector(".thinking-timer");
	thinkingTimer = setInterval(function () {
		const sec = Math.floor((Date.now() - thinkingStartedAt) / 1000);
		timerEl.textContent = "· " + sec + "s";
	}, 1000);
	scrollToBottom();
}

function hideThinkingIndicator() {
	if (thinkingTimer) {
		clearInterval(thinkingTimer);
		thinkingTimer = null;
	}
	if (thinkingEl && thinkingEl.parentNode) {
		thinkingEl.parentNode.removeChild(thinkingEl);
	}
	thinkingEl = null;
}

function moveThinkingIndicatorToEnd() {
	if (thinkingEl && messagesEl && thinkingEl.parentNode === messagesEl) {
		messagesEl.appendChild(thinkingEl);
	}
}

function notifyTaskComplete() {
	if (document.hasFocus()) return;
	if (!("Notification" in window)) return;

	if (Notification.permission === "granted") {
		new Notification("Cliclaw", { body: "任务执行完成", icon: "/favicon.ico" });
	} else if (Notification.permission !== "denied") {
		Notification.requestPermission().then(function (perm) {
			if (perm === "granted") {
				new Notification("Cliclaw", { body: "任务执行完成", icon: "/favicon.ico" });
			}
		});
	}
}

function fetchCommands() {
	fetch("/api/commands")
		.then(function (res) { return res.json(); })
		.then(function (data) { commands = data; })
		.catch(function () { commands = []; });
}

function getFilteredCommands() {
	const text = inputEl.value;
	if (!text.startsWith("/")) return [];
	const query = text.slice(1).toLowerCase();
	return commands
		.filter(function (c) {
			return c.name.toLowerCase().startsWith(query) || c.name.toLowerCase().includes(query);
		})
		.sort(function (a, b) {
			const aStarts = a.name.toLowerCase().startsWith(query) ? 0 : 1;
			const bStarts = b.name.toLowerCase().startsWith(query) ? 0 : 1;
			if (aStarts !== bStarts) return aStarts - bStarts;
			if (a.category !== b.category) return a.category === "builtin" ? -1 : 1;
			return a.name.localeCompare(b.name);
		});
}

function renderDropdown(filtered) {
	if (filtered.length === 0) {
		closeDropdown();
		return;
	}

	dropdownEl.innerHTML = "";
	for (let i = 0; i < filtered.length; i++) {
		const cmd = filtered[i];
		const item = document.createElement("div");
		item.className = "command-item" + (i === activeIndex ? " active" : "");
		item.dataset.index = String(i);
		item.dataset.name = cmd.name;

		const nameSpan = document.createElement("span");
		nameSpan.className = "command-name";
		nameSpan.textContent = "/" + cmd.name;

		const descSpan = document.createElement("span");
		descSpan.className = "command-desc";
		descSpan.textContent = cmd.description;

		const catSpan = document.createElement("span");
		catSpan.className = "command-category";
		catSpan.textContent = cmd.category;

		item.appendChild(nameSpan);
		item.appendChild(descSpan);
		item.appendChild(catSpan);
		item.addEventListener("click", function () {
			selectCommand(this.dataset.name);
		});

		dropdownEl.appendChild(item);
	}

	dropdownEl.classList.remove("hidden");
	isDropdownOpen = true;
}

function closeDropdown() {
	dropdownEl.classList.add("hidden");
	dropdownEl.innerHTML = "";
	isDropdownOpen = false;
	activeIndex = -1;
}

function selectCommand(name) {
	inputEl.value = "/" + name;
	closeDropdown();
	inputEl.focus();
	const cmd = commands.find(function (c) { return c.name === name; });
	if (cmd && cmd.category === "builtin") {
		sendMessage();
	}
}

function updateActiveItem(items) {
	for (let i = 0; i < items.length; i++) {
		items[i].classList.toggle("active", i === activeIndex);
	}
	if (activeIndex >= 0 && items[activeIndex]) {
		items[activeIndex].scrollIntoView({ block: "nearest" });
	}
}

function sendMessage() {
	const text = inputEl.value.trim();
	if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;

	closeDropdown();

	if (text.startsWith("/")) {
		const name = text.slice(1).split(/\s+/)[0];
		ws.send(JSON.stringify({ type: "command", name }));
	} else {
		ws.send(JSON.stringify({ type: "message", content: text }));
		addMessageBubble("user", text, Date.now());
		scrollToBottom();
	}

	inputEl.value = "";
	inputEl.style.height = "auto";
}

function initDomReferences() {
	messagesEl = document.getElementById("messages");
	contentEl = document.getElementById("content");
	executionPanelEl = document.getElementById("execution-panel");
	executionResizeHandleEl = document.getElementById("execution-resize-handle");
	executionReopenBtn = document.getElementById("execution-reopen-btn");
	inputEl = document.getElementById("input");
	inputAreaEl = document.getElementById("input-area");
	sendBtn = document.getElementById("send-btn");
	statusDot = document.getElementById("status-dot");
	statusText = document.getElementById("status-text");
	queuePillEl = document.getElementById("queue-pill");
	inputMetaModelEl = document.getElementById("input-meta-model");
	dropdownEl = document.getElementById("command-dropdown");
	agentTabsEl = document.getElementById("agent-tabs");
	terminalContentEl = document.getElementById("terminal-content");
	terminalEmptyEl = document.getElementById("terminal-empty");
	terminalCardEl = document.querySelector(".terminal-card");
	terminalImeInputEl = document.getElementById("terminal-ime-input");
	terminalStatusbarEl = document.getElementById("terminal-statusbar");
	terminalStatusbarStateEl = document.getElementById("terminal-statusbar-state");
	terminalStatusbarCwdEl = document.getElementById("terminal-statusbar-cwd");
	takeoverBtnEl = document.getElementById("takeover-btn");
	takeoverBtnLabelEl = document.getElementById("takeover-btn-label");
	abortBtnEl = document.getElementById("abort-btn");
	themeToggleEl = document.getElementById("theme-toggle");
	themeIconSunEl = document.getElementById("theme-icon-sun");
	themeIconMoonEl = document.getElementById("theme-icon-moon");
	mobileDragHandleEl = document.getElementById("mobile-drag-handle");
	mobilePeekRowEl = document.getElementById("mobile-peek-row");
	mobilePeekDotEl = document.getElementById("mobile-peek-dot");
	mobilePeekNameEl = document.getElementById("mobile-peek-name");
	mobilePeekMetaEl = document.getElementById("mobile-peek-meta");
	mobilePeekTailEl = document.getElementById("mobile-peek-tail");
}

function isMobileViewport() {
	return window.matchMedia("(max-width: 768px)").matches;
}

function setSheetState(next) {
	if (next !== "peek" && next !== "full") return;
	sheetState = next;
	if (executionPanelEl) {
		executionPanelEl.classList.toggle("peek", next === "peek");
		executionPanelEl.classList.toggle("full", next === "full");
	}
	// When opening to full on mobile, ensure terminal content scrolls to bottom
	if (next === "full" && terminalContentEl && isMobileViewport()) {
		requestAnimationFrame(function () {
			terminalContentEl.scrollTop = terminalContentEl.scrollHeight;
		});
	}
}

function toggleSheet() {
	setSheetState(sheetState === "peek" ? "full" : "peek");
}

const PEEK_HEIGHT = 96;
function getFullHeight() {
	return Math.max(220, window.innerHeight - 240);
}

let sheetDrag = null;

function clearSheetInlineHeight() {
	if (!executionPanelEl) return;
	executionPanelEl.style.height = "";
	executionPanelEl.style.transition = "";
}

function onSheetPointerDown(e) {
	if (!executionPanelEl || !isMobileViewport()) return;
	if (e.pointerType === "mouse" && e.button !== 0) return;
	sheetDrag = {
		pointerId: e.pointerId,
		startY: e.clientY,
		startHeight: executionPanelEl.getBoundingClientRect().height,
		moved: false,
		target: e.currentTarget,
	};
	try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
	executionPanelEl.style.transition = "none";
	e.preventDefault();
}

function onSheetPointerMove(e) {
	if (!sheetDrag || e.pointerId !== sheetDrag.pointerId) return;
	const dy = e.clientY - sheetDrag.startY;
	if (Math.abs(dy) > 4) sheetDrag.moved = true;
	const next = Math.min(getFullHeight(), Math.max(PEEK_HEIGHT, sheetDrag.startHeight - dy));
	executionPanelEl.style.height = `${next}px`;
}

function onSheetPointerUp(e) {
	if (!sheetDrag || e.pointerId !== sheetDrag.pointerId) return;
	const drag = sheetDrag;
	sheetDrag = null;
	try { drag.target.releasePointerCapture(e.pointerId); } catch {}

	if (!drag.moved) {
		clearSheetInlineHeight();
		toggleSheet();
		return;
	}

	const currentHeight = executionPanelEl.getBoundingClientRect().height;
	const fullH = getFullHeight();
	const midpoint = PEEK_HEIGHT + (fullH - PEEK_HEIGHT) / 2;
	const target = currentHeight >= midpoint ? "full" : "peek";
	clearSheetInlineHeight();
	setSheetState(target);
}

function onSheetPointerCancel(e) {
	if (!sheetDrag || e.pointerId !== sheetDrag.pointerId) return;
	sheetDrag = null;
	clearSheetInlineHeight();
}

function lastNonEmptyLine(text) {
	if (!text) return "";
	const lines = text.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const stripped = lines[i].replace(/\x1b\[[0-9;]*m/g, "").trim();
		if (stripped) return stripped;
	}
	return "";
}

function updateMobilePeek() {
	if (!mobilePeekRowEl) return;
	if (!activeAgentTab || !agentTerminals.has(activeAgentTab)) {
		if (mobilePeekDotEl) mobilePeekDotEl.className = "agent-tab-dot status-idle";
		if (mobilePeekNameEl) mobilePeekNameEl.textContent = "—";
		if (mobilePeekMetaEl) mobilePeekMetaEl.textContent = "";
		if (mobilePeekTailEl) mobilePeekTailEl.textContent = "暂无活跃的 Agent 会话";
		return;
	}
	const data = agentTerminals.get(activeAgentTab);
	if (mobilePeekDotEl) {
		mobilePeekDotEl.className = "agent-tab-dot status-" + (data.takenOver ? "taken_over" : data.status);
	}
	if (mobilePeekNameEl) {
		const displayName = data.name.startsWith("cliclaw-") ? data.name.slice(8) : data.name;
		mobilePeekNameEl.textContent = displayName;
	}
	if (mobilePeekMetaEl) {
		const count = agentTerminals.size;
		mobilePeekMetaEl.textContent = count > 1 ? "· " + count + " tmux" : "";
	}
	if (mobilePeekTailEl) {
		const tail = lastNonEmptyLine(data.paneContent);
		mobilePeekTailEl.textContent = tail || "(no output)";
	}
}

function loadAgentTerminals() {
	fetch("/api/agents/terminals")
		.then(function (res) { return res.json(); })
		.then(function (sessions) { handleAgentTerminals(sessions); })
		.catch(function () {});
}

function handleAgentTerminals(sessions) {
	const previousIds = new Set(agentTerminals.keys());
	const incomingIds = new Set();

	for (const s of sessions) {
		incomingIds.add(s.agentId);
		agentTerminals.set(s.agentId, {
			name: s.agentName,
			status: s.status,
			paneContent: s.paneContent,
			takenOver: s.takenOver || false,
			workingDir: s.workingDir || "",
		});
	}

	for (const id of previousIds) {
		if (!incomingIds.has(id)) {
			agentTerminals.delete(id);
		}
	}

	let newAgentId = null;
	for (const id of incomingIds) {
		if (!previousIds.has(id)) newAgentId = id;
	}
	if (newAgentId) activeAgentTab = newAgentId;

	if (activeAgentTab && !agentTerminals.has(activeAgentTab)) {
		const first = agentTerminals.keys().next().value;
		activeAgentTab = first || null;
	}

	if (!activeAgentTab && agentTerminals.size > 0) {
		activeAgentTab = agentTerminals.keys().next().value;
	}

	renderAgentTabs();
	renderTerminalContent();
	updateMobilePeek();
}

function renderAgentTabs() {
	if (!agentTabsEl) return;
	if (agentTerminals.size === 0) {
		agentTabsEl.innerHTML = "";
		if (terminalContentEl) terminalContentEl.style.display = "none";
		if (terminalEmptyEl) terminalEmptyEl.classList.add("visible");
		if (terminalStatusbarEl) terminalStatusbarEl.style.display = "none";
		if (takeoverBtnEl) takeoverBtnEl.style.display = "none";
		if (abortBtnEl) abortBtnEl.style.display = "none";
		return;
	}

	if (terminalContentEl) terminalContentEl.style.display = "";
	if (terminalEmptyEl) terminalEmptyEl.classList.remove("visible");

	agentTabsEl.innerHTML = "";
	agentTabsEl.style.display = "flex";
	for (const [id, data] of agentTerminals) {
		const btn = document.createElement("button");
		btn.className = "agent-tab" + (id === activeAgentTab ? " active" : "") + (data.takenOver ? " taken-over" : "");
		btn.dataset.agentId = id;
		btn.type = "button";

		const dot = document.createElement("span");
		dot.className = "agent-tab-dot status-" + (data.takenOver ? "taken_over" : data.status);

		const label = document.createElement("span");
		label.className = "agent-tab-label";
		const displayName = data.name.startsWith("cliclaw-") ? data.name.slice(8) : data.name;
		label.textContent = displayName;

		btn.appendChild(dot);
		btn.appendChild(label);

		if (data.takenOver) {
			const marker = document.createElement("span");
			marker.className = "takeover-marker";
			marker.title = "已被人工接管";
			marker.textContent = "●";
			btn.appendChild(marker);
		}

		btn.addEventListener("click", function () {
			activeAgentTab = this.dataset.agentId;
			lastRenderedTerminalContent = "";
			renderAgentTabs();
			renderTerminalContent();
		});
		agentTabsEl.appendChild(btn);
	}

	updateTakeoverButton();
}

function updateTakeoverButton() {
	if (!takeoverBtnEl || !takeoverBtnLabelEl) return;
	if (!activeAgentTab || !agentTerminals.has(activeAgentTab)) {
		takeoverBtnEl.style.display = "none";
		if (abortBtnEl) abortBtnEl.style.display = "none";
		return;
	}
	const data = agentTerminals.get(activeAgentTab);
	takeoverBtnEl.style.display = "inline-flex";
	if (data.takenOver) {
		takeoverBtnEl.classList.add("release");
		takeoverBtnLabelEl.textContent = "释放";
	} else {
		takeoverBtnEl.classList.remove("release");
		takeoverBtnLabelEl.textContent = "接管";
	}
	if (abortBtnEl) abortBtnEl.style.display = data.takenOver ? "inline-flex" : "none";
}

function sendAbortToActiveAgent() {
	if (!ws || ws.readyState !== WebSocket.OPEN || !activeAgentTab) return;
	ws.send(JSON.stringify({ type: "agent_abort", agentId: activeAgentTab }));
}

function renderTerminalContent() {
	if (!terminalContentEl) return;

	if (!activeAgentTab || !agentTerminals.has(activeAgentTab)) {
		terminalContentEl.innerHTML = "";
		terminalContentEl.classList.remove("takeover-active");
		if (terminalStatusbarEl) terminalStatusbarEl.style.display = "none";
		return;
	}

	const data = agentTerminals.get(activeAgentTab);
	const el = terminalContentEl;
	const isTakenOver = data.takenOver || false;

	// When first entering takeover mode, auto-focus the hidden IME input
	// so the user can immediately type (and IME-compose) without an extra click.
	// Only focus on the *transition* into takeover — not on every render —
	// so the user can click back to the main input without focus being stolen.
	if (isTakenOver && !lastTakeoverAutoFocused && terminalImeInputEl) {
		terminalImeInputEl.focus({ preventScroll: true });
	}
	lastTakeoverAutoFocused = isTakenOver;

	// Status bar
	if (terminalStatusbarEl) {
		terminalStatusbarEl.style.display = "flex";
		if (terminalStatusbarStateEl) {
			const stateLabel = isTakenOver
				? "user · taking over"
				: data.status === "active"
					? "agent · running"
					: data.status === "waiting_input"
						? "agent · awaiting input"
						: "agent · idle";
			terminalStatusbarStateEl.textContent = stateLabel;
		}
		if (terminalStatusbarCwdEl) {
			terminalStatusbarCwdEl.textContent = data.workingDir || "";
		}
	}

	if (data.paneContent === lastRenderedTerminalContent) {
		el.classList.toggle("takeover-active", isTakenOver);
		return;
	}
	lastRenderedTerminalContent = data.paneContent;

	const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
	const prevScrollHeight = el.scrollHeight;
	const prevScrollTop = el.scrollTop;

	el.innerHTML = renderAnsiToHtml(data.paneContent);
	el.classList.toggle("takeover-active", isTakenOver);

	if (isAtBottom) {
		el.scrollTop = el.scrollHeight;
	} else {
		const delta = el.scrollHeight - prevScrollHeight;
		if (delta > 0) el.scrollTop = prevScrollTop + delta;
	}

	if (terminalMoreLoading) terminalMoreLoading = false;
}

function sendTakeoverToggle() {
	if (!activeAgentTab || !ws || ws.readyState !== WebSocket.OPEN) return;
	const data = agentTerminals.get(activeAgentTab);
	if (!data) return;
	ws.send(JSON.stringify({ type: data.takenOver ? "release" : "takeover", agentId: activeAgentTab }));
}

function sendTerminalInput(inputType, data) {
	if (!ws || ws.readyState !== WebSocket.OPEN || !activeAgentTab) return;
	ws.send(JSON.stringify({ type: "terminal_input", agentId: activeAgentTab, inputType, data: data || "" }));
}

function activeTabIsTakenOver() {
	if (!activeAgentTab) return false;
	const data = agentTerminals.get(activeAgentTab);
	return !!(data && data.takenOver);
}

// On PC, the vertical mouse wheel does not scroll horizontally by default, and
// without touch we also cannot pan #agent-tabs. So when tabs overflow the bar,
// the only visible tab is the one currently in view. Enable two affordances:
//   1. Vertical wheel → horizontal scroll (when tabs overflow).
//   2. Click-and-drag panning for mouse users (touch already pans natively).
// Click on a tab still selects it; drag is detected by a 4 px threshold and
// suppresses the trailing click event so a drag-release does not switch tabs.
function setupAgentTabsScroll() {
	if (!agentTabsEl) return;

	agentTabsEl.addEventListener(
		"wheel",
		function (e) {
			if (agentTabsEl.scrollWidth <= agentTabsEl.clientWidth) return;
			// Trackpad horizontal scroll already produces deltaX — let it through.
			if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
			if (e.deltaY === 0) return;
			e.preventDefault();
			agentTabsEl.scrollLeft += e.deltaY;
		},
		{ passive: false },
	);

	let drag = null;
	agentTabsEl.addEventListener("pointerdown", function (e) {
		if (e.pointerType !== "mouse") return;
		if (e.button !== 0) return;
		drag = {
			pointerId: e.pointerId,
			startX: e.clientX,
			startScrollLeft: agentTabsEl.scrollLeft,
			moved: false,
		};
	});
	agentTabsEl.addEventListener("pointermove", function (e) {
		if (!drag || e.pointerId !== drag.pointerId) return;
		const dx = e.clientX - drag.startX;
		if (!drag.moved && Math.abs(dx) > 4) {
			drag.moved = true;
			try {
				agentTabsEl.setPointerCapture(drag.pointerId);
			} catch {}
			agentTabsEl.classList.add("dragging");
		}
		if (drag.moved) {
			agentTabsEl.scrollLeft = drag.startScrollLeft - dx;
		}
	});
	function endDrag(e) {
		if (!drag || e.pointerId !== drag.pointerId) return;
		const wasMoving = drag.moved;
		drag = null;
		agentTabsEl.classList.remove("dragging");
		if (wasMoving) {
			// Swallow the click that fires after a drag-release so the user
			// does not accidentally switch tabs at the end of a pan.
			const swallow = function (ev) {
				ev.stopPropagation();
				ev.preventDefault();
				agentTabsEl.removeEventListener("click", swallow, true);
			};
			agentTabsEl.addEventListener("click", swallow, true);
		}
	}
	agentTabsEl.addEventListener("pointerup", endDrag);
	agentTabsEl.addEventListener("pointercancel", endDrag);
}

function initApp() {
	initDomReferences();
	setupAgentTabsScroll();

	const stored = getStoredTheme();
	applyTheme(stored === "light" || stored === "dark" ? stored : null, undefined);
	if (window.matchMedia) {
		try {
			const mq = window.matchMedia("(prefers-color-scheme: dark)");
			mq.addEventListener("change", function () {
				if (!getStoredTheme()) updateThemeIcon();
			});
		} catch {}
	}

	syncExecutionPanelWidth();

	if ("Notification" in window && Notification.permission === "default") {
		Notification.requestPermission();
	}

	if (themeToggleEl) {
		themeToggleEl.addEventListener("click", toggleTheme);
	}

	if (terminalContentEl) {
		terminalContentEl.addEventListener("scroll", function () {
			if (this.scrollTop > 0) return;
			if (!activeAgentTab || terminalMoreLoading) return;
			if (!ws || ws.readyState !== WebSocket.OPEN) return;
			terminalMoreLoading = true;
			ws.send(JSON.stringify({ type: "terminal_more", agentId: activeAgentTab }));
		});

		// Click on terminal in takeover mode → focus the hidden IME input so
		// IME composition (e.g. Chinese pinyin) routes through it correctly.
		terminalContentEl.addEventListener("pointerdown", function () {
			if (!activeTabIsTakenOver()) return;
			// Defer so default focus behavior doesn't steal it back
			setTimeout(function () {
				if (terminalImeInputEl) terminalImeInputEl.focus({ preventScroll: true });
			}, 0);
		});
	}

	if (terminalImeInputEl) {
		terminalImeInputEl.addEventListener("focus", function () {
			if (terminalCardEl) terminalCardEl.classList.add("ime-focused");
		});
		terminalImeInputEl.addEventListener("blur", function () {
			if (terminalCardEl) terminalCardEl.classList.remove("ime-focused");
			imeComposing = false;
		});

		terminalImeInputEl.addEventListener("compositionstart", function () {
			imeComposing = true;
		});
		terminalImeInputEl.addEventListener("compositionend", function (e) {
			imeComposing = false;
			const text = e.data || "";
			if (text && activeTabIsTakenOver()) {
				sendTerminalInput("text", text);
			}
			// Clear the input value to keep it as a transient buffer
			terminalImeInputEl.value = "";
		});

		// Mobile virtual keyboards often fire keydown with keyCode 229 for
		// every key, including Enter — so the keydown handler never reaches
		// the e.key === "Enter" branch.  Catch Enter here via beforeinput
		// (inputType "insertLineBreak") which fires reliably on mobile.
		terminalImeInputEl.addEventListener("beforeinput", function (e) {
			if (e.inputType === "insertLineBreak" && activeTabIsTakenOver()) {
				e.preventDefault();
				sendTerminalInput("enter");
				terminalImeInputEl.value = "";
			}
		});

		// Direct (non-IME) typed characters arrive via input event with
		// inputType "insertText" and isComposing === false.
		terminalImeInputEl.addEventListener("input", function (e) {
			if (e.isComposing || imeComposing) return;
			if (!activeTabIsTakenOver()) {
				terminalImeInputEl.value = "";
				return;
			}
			// Mobile Enter fallback: if beforeinput didn't fire (older browsers),
			// catch insertLineBreak here as a safety net.
			if (e.inputType === "insertLineBreak") {
				terminalImeInputEl.value = "";
				sendTerminalInput("enter");
				return;
			}
			const text = terminalImeInputEl.value;
			terminalImeInputEl.value = "";
			if (!text) return;
			// Only forward if it's a plain text insertion (skip composition leftovers)
			if (e.inputType && e.inputType !== "insertText" && e.inputType !== "insertFromPaste") return;
			sendTerminalInput("text", text);
		});

		terminalImeInputEl.addEventListener("keydown", function (e) {
			if (!activeTabIsTakenOver()) return;
			// During IME composition, let the browser handle everything
			if (e.isComposing || imeComposing || e.keyCode === 229) return;

			// Control keys: intercept and forward to tmux
			if (e.ctrlKey && (e.key === "c" || e.key === "C")) {
				e.preventDefault();
				sendTerminalInput("ctrl-c");
			} else if (e.key === "Enter") {
				e.preventDefault();
				sendTerminalInput("enter");
			} else if (e.key === "Escape") {
				e.preventDefault();
				sendTerminalInput("escape");
			} else if (e.key === "ArrowUp") {
				e.preventDefault();
				sendTerminalInput("keys", "Up");
			} else if (e.key === "ArrowDown") {
				e.preventDefault();
				sendTerminalInput("keys", "Down");
			} else if (e.key === "ArrowLeft") {
				e.preventDefault();
				sendTerminalInput("keys", "Left");
			} else if (e.key === "ArrowRight") {
				e.preventDefault();
				sendTerminalInput("keys", "Right");
			} else if (e.key === "Backspace") {
				e.preventDefault();
				sendTerminalInput("keys", "BSpace");
			} else if (e.key === "Tab") {
				e.preventDefault();
				sendTerminalInput("keys", "Tab");
			}
			// Plain printable characters fall through to the input event handler.
		});
	}

	if (executionResizeHandleEl) {
		executionResizeHandleEl.addEventListener("mousedown", startExecutionPanelResize);
	}
	if (executionReopenBtn) {
		executionReopenBtn.addEventListener("click", reopenExecutionPanel);
	}
	document.addEventListener("mousemove", handleExecutionPanelResizeMove);
	document.addEventListener("mouseup", stopExecutionPanelResize);
	window.addEventListener("resize", function () {
		syncExecutionPanelWidth();
		syncSheetForViewport();
	});
	window.addEventListener("blur", stopExecutionPanelResize);

	function attachSheetDrag(el) {
		if (!el) return;
		el.addEventListener("pointerdown", onSheetPointerDown);
		el.addEventListener("pointermove", onSheetPointerMove);
		el.addEventListener("pointerup", onSheetPointerUp);
		el.addEventListener("pointercancel", onSheetPointerCancel);
	}
	attachSheetDrag(mobileDragHandleEl);
	attachSheetDrag(mobilePeekRowEl);

	syncSheetForViewport();

	if (takeoverBtnEl) {
		takeoverBtnEl.addEventListener("click", sendTakeoverToggle);
	}
	if (abortBtnEl) {
		abortBtnEl.addEventListener("click", sendAbortToActiveAgent);
	}

	document.addEventListener("click", function (e) {
		if (!dropdownEl.contains(e.target) && e.target !== inputEl) closeDropdown();
	});

	inputEl.addEventListener("keydown", function (e) {
		if (isDropdownOpen) {
			const items = dropdownEl.querySelectorAll(".command-item");

			if (e.key === "ArrowDown") {
				e.preventDefault();
				activeIndex = Math.min(activeIndex + 1, items.length - 1);
				updateActiveItem(items);
				return;
			}

			if (e.key === "ArrowUp") {
				e.preventDefault();
				activeIndex = Math.max(activeIndex - 1, 0);
				updateActiveItem(items);
				return;
			}

			if (e.key === "Enter" && !e.shiftKey && activeIndex >= 0) {
				e.preventDefault();
				selectCommand(items[activeIndex].dataset.name);
				return;
			}

			if (e.key === "Escape") {
				e.preventDefault();
				closeDropdown();
				return;
			}

			if (e.key === "Tab" && items.length > 0) {
				e.preventDefault();
				const idx = activeIndex >= 0 ? activeIndex : 0;
				selectCommand(items[idx].dataset.name);
				return;
			}
		}

		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			sendMessage();
		}
	});

	sendBtn.addEventListener("click", function () {
		if (sendBtn.classList.contains("is-stop")) {
			sendStopCommand();
		} else {
			sendMessage();
		}
	});

	updateSendButtonMode();

	inputEl.addEventListener("input", function () {
		this.style.height = "auto";
		this.style.height = Math.min(this.scrollHeight, 140) + "px";

		if (this.value.startsWith("/")) {
			activeIndex = -1;
			renderDropdown(getFilteredCommands());
		} else {
			closeDropdown();
		}
	});

	if (inputAreaEl && typeof ResizeObserver !== "undefined") {
		const ro = new ResizeObserver(function () {
			const h = inputAreaEl.offsetHeight;
			document.documentElement.style.setProperty("--input-area-h", h + "px");
		});
		ro.observe(inputAreaEl);
		document.documentElement.style.setProperty("--input-area-h", inputAreaEl.offsetHeight + "px");
	}

	connect();
}

if (typeof document !== "undefined") {
	initApp();
}

if (typeof renderMarkdown === "function") {
	window.renderMarkdown = renderMarkdown;
}
