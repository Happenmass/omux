// ─── Cliclaw Chat UI ──────────────────────────────

let messagesEl;
let contentEl;
let executionPanelEl;
let executionResizeHandleEl;
let executionReopenBtn;
let inputEl;
let sendBtn;
let statusDot;
let statusText;
let dropdownEl;
let terminalViewEl;
let evidenceViewEl;
let agentTabsEl;
let terminalContentEl;
let terminalEmptyEl;
let terminalInputBarEl;
let terminalInputEl;

let ws = null;
let currentAssistantEl = null;
let reconnectTimer = null;
let agentState = "idle";
let commands = [];
let activeIndex = -1;
let isDropdownOpen = false;
let isExecutionPanelResizing = false;
let executionPanelHidden = false;
let lastExecutionPanelWidth = 420;
let activePanelTab = "terminal";
const agentTerminals = new Map();
let activeAgentTab = null;
let terminalMoreLoading = false;
let lastRenderedTerminalContent = "";
const EXECUTION_PANEL_DEFAULT_WIDTH = 420;
const EXECUTION_PANEL_MIN_WIDTH = 320;
const EXECUTION_PANEL_HIDE_THRESHOLD = 180;

const ANSI_STYLES = {
	30: "color:#1f2430",
	31: "color:#ef5350",
	32: "color:#8bc34a",
	33: "color:#ffca28",
	34: "color:#64b5f6",
	35: "color:#ba68c8",
	36: "color:#4dd0e1",
	37: "color:#f5f5f5",
	90: "color:#90a4ae",
	91: "color:#ff8a80",
	92: "color:#ccff90",
	93: "color:#ffe082",
	94: "color:#82b1ff",
	95: "color:#ea80fc",
	96: "color:#84ffff",
	97: "color:#ffffff",
	40: "background-color:#1f2430",
	41: "background-color:#b71c1c",
	42: "background-color:#33691e",
	43: "background-color:#f57f17",
	44: "background-color:#0d47a1",
	45: "background-color:#4a148c",
	46: "background-color:#006064",
	47: "background-color:#cfd8dc",
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
	const ansiPattern = /\u001b\[([0-9;]*)m/g;
	const state = {
		color: "",
		background: "",
		weight: "",
	};

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

function stripAnsi(text) {
	return text.replace(/\u001b\[[0-9;]*m/g, "");
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
	const maxWidth = Math.max(minWidth, Math.floor(containerWidth / 2));
	return { minWidth, maxWidth };
}

export function shouldHideExecutionPanel(rawWidth, hideThreshold = EXECUTION_PANEL_HIDE_THRESHOLD) {
	return rawWidth <= hideThreshold;
}

function supportsFloatingExecutionPanel() {
	return window.matchMedia("(min-width: 981px)").matches;
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
		const containerWidth = contentEl ? contentEl.getBoundingClientRect().width : window.innerWidth;
		const bounds = getExecutionPanelWidthBounds(containerWidth);
		const inlineWidth = Number.parseFloat(executionPanelEl.style.getPropertyValue("--execution-panel-width"));
		const measuredWidth = Number.isFinite(inlineWidth) ? inlineWidth : executionPanelEl.getBoundingClientRect().width;
		lastExecutionPanelWidth = clampExecutionPanelWidth(
			measuredWidth || EXECUTION_PANEL_DEFAULT_WIDTH,
			bounds.minWidth,
			bounds.maxWidth,
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
	executionPanelEl.style.setProperty("--execution-panel-width", `${width}px`);
}

function syncExecutionPanelWidth() {
	if (!executionPanelEl) return;
	if (!supportsFloatingExecutionPanel()) {
		executionPanelHidden = false;
		executionPanelEl.style.removeProperty("--execution-panel-width");
		updateExecutionPanelVisibilityControls();
		return;
	}
	updateExecutionPanelVisibilityControls();
	if (executionPanelHidden) return;
	const currentWidth =
		Number.parseFloat(executionPanelEl.style.getPropertyValue("--execution-panel-width")) || lastExecutionPanelWidth;
	applyExecutionPanelWidth(currentWidth);
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

function connect() {
	const protocol = location.protocol === "https:" ? "wss:" : "ws:";
	ws = new WebSocket(`${protocol}//${location.host}/ws`);

	ws.onopen = function () {
		setConnectionStatus("connected");
		loadHistory();
		loadAgentTerminals();
		fetchCommands();
	};

	ws.onmessage = function (event) {
		let data;
		try {
			data = JSON.parse(event.data);
		} catch {
			return;
		}
		handleServerMessage(data);
	};

	ws.onclose = function () {
		setConnectionStatus("disconnected");
		scheduleReconnect();
	};

	ws.onerror = function () {
		// onclose will fire after this
	};
}

function scheduleReconnect() {
	if (reconnectTimer) return;
	reconnectTimer = setTimeout(function () {
		reconnectTimer = null;
		connect();
	}, 3000);
}

function setConnectionStatus(status) {
	statusDot.className = "";
	if (status === "connected") {
		statusDot.classList.add(agentState);
		statusText.textContent = agentState === "idle" ? "空闲" : "执行中...";
	} else {
		statusDot.classList.add("disconnected");
		statusText.textContent = "连接断开，正在重连...";
	}
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
				if (entry.kind === "chat") {
					const msg = entry.payload;
					if (msg.role === "user") {
						const content = typeof msg.content === "string" ? msg.content : "[complex content]";
						if (content.startsWith("[HUMAN]") || content.startsWith("[RESUME]")) continue;
						addMessageBubble("user", content);
					} else if (msg.role === "assistant") {
						const text = extractText(msg.content);
						if (text) addMessageBubble("assistant", text);
					}
					continue;
				}

				if (entry.payload.type === "agent_update") {
					addMessageBubble("agent-update", entry.payload.summary);
				} else if (entry.payload.type === "tool_activity") {
					addMessageBubble("tool-activity", entry.payload.summary);
				}
			}
			scrollToBottom();
		})
		.catch(function () {
			// Silently fail — history is optional
		});
}

function handleServerMessage(data) {
	switch (data.type) {
		case "assistant_delta":
			if (!currentAssistantEl) {
				currentAssistantEl = addMessageBubble("assistant", "");
			}
			currentAssistantEl.textContent += data.delta;
			scrollToBottom();
			break;

		case "assistant_done":
			if (currentAssistantEl) {
				currentAssistantEl.innerHTML = renderMarkdown(currentAssistantEl.textContent);
				currentAssistantEl = null;
			}
			break;

		case "agent_update":
			addMessageBubble("agent-update", data.summary);
			scrollToBottom();
			break;

		case "tool_activity":
			addMessageBubble("tool-activity", data.summary);
			scrollToBottom();
			break;

		case "state": {
			const prevState = agentState;
			agentState = data.state;
			setConnectionStatus("connected");
			// Notify when task execution finishes (executing → idle)
			if (prevState === "executing" && data.state === "idle") {
				notifyTaskComplete();
			}
			break;
		}

		case "system":
			addMessageBubble("system", data.message);
			scrollToBottom();
			break;

		case "agent_terminals":
			handleAgentTerminals(data.agents);
			break;

		case "clear":
			messagesEl.innerHTML = "";
			currentAssistantEl = null;
			addMessageBubble("system", "对话已清空");
			break;
	}
}

function addMessageBubble(type, text) {
	const el = document.createElement("div");
	el.className = "msg " + type;

	if (type === "assistant" && text) {
		el.innerHTML = renderMarkdown(text);
	} else {
		el.textContent = text;
	}

	messagesEl.appendChild(el);
	return el;
}

function scrollToBottom() {
	requestAnimationFrame(function () {
		messagesEl.scrollTop = messagesEl.scrollHeight;
	});
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
		addMessageBubble("user", text);
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
	sendBtn = document.getElementById("send-btn");
	statusDot = document.getElementById("status-dot");
	statusText = document.getElementById("status-text");
	dropdownEl = document.getElementById("command-dropdown");
	terminalViewEl = document.getElementById("terminal-view");
	evidenceViewEl = document.getElementById("evidence-view");
	agentTabsEl = document.getElementById("agent-tabs");
	terminalContentEl = document.getElementById("terminal-content");
	terminalEmptyEl = document.getElementById("terminal-empty");
	terminalInputBarEl = document.getElementById("terminal-input-bar");
	terminalInputEl = document.getElementById("terminal-input");
}

function loadAgentTerminals() {
	fetch("/api/agents/terminals")
		.then(function (res) { return res.json(); })
		.then(function (sessions) {
			handleAgentTerminals(sessions);
		})
		.catch(function () {
			// Silently fail — terminals are optional
		});
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
		});
	}

	// Remove agents that disappeared
	for (const id of previousIds) {
		if (!incomingIds.has(id)) {
			agentTerminals.delete(id);
		}
	}

	// Detect new agents — auto-switch to the last new one
	let newAgentId = null;
	for (const id of incomingIds) {
		if (!previousIds.has(id)) {
			newAgentId = id;
		}
	}
	if (newAgentId) {
		activeAgentTab = newAgentId;
	}

	// If active tab gone, switch to first remaining
	if (activeAgentTab && !agentTerminals.has(activeAgentTab)) {
		const first = agentTerminals.keys().next().value;
		activeAgentTab = first || null;
	}

	// If nothing selected but agents exist, pick first
	if (!activeAgentTab && agentTerminals.size > 0) {
		activeAgentTab = agentTerminals.keys().next().value;
	}

	renderAgentTabs();
	renderTerminalContent();
}

function renderAgentTabs() {
	if (!agentTabsEl) return;
	if (agentTerminals.size === 0) {
		agentTabsEl.innerHTML = "";
		agentTabsEl.style.display = "none";
		if (terminalContentEl) terminalContentEl.style.display = "none";
		if (terminalEmptyEl) terminalEmptyEl.classList.add("visible");
		return;
	}

	agentTabsEl.style.display = "flex";
	if (terminalContentEl) terminalContentEl.style.display = "";
	if (terminalEmptyEl) terminalEmptyEl.classList.remove("visible");

	agentTabsEl.innerHTML = "";
	for (const [id, data] of agentTerminals) {
		const btn = document.createElement("button");
		btn.className = "agent-tab" + (id === activeAgentTab ? " active" : "");
		btn.dataset.agentId = id;

		const dot = document.createElement("span");
		dot.className = "agent-tab-dot status-" + (data.takenOver ? "taken_over" : data.status);

		const label = document.createElement("span");
		label.className = "agent-tab-label";
		// Strip cliclaw- prefix for display
		const displayName = data.name.startsWith("cliclaw-") ? data.name.slice(8) : data.name;
		label.textContent = displayName;

		btn.appendChild(dot);
		btn.appendChild(label);

		if (data.takenOver) {
			const badge = document.createElement("span");
			badge.className = "takeover-badge";
			badge.textContent = "已接管";
			btn.appendChild(badge);
		}

		// Takeover/release action button
		const actionBtn = document.createElement("span");
		actionBtn.className = "takeover-btn" + (data.takenOver ? " release" : "");
		actionBtn.textContent = data.takenOver ? "释放" : "接管";
		actionBtn.addEventListener("click", function (e) {
			e.stopPropagation();
			if (ws && ws.readyState === WebSocket.OPEN) {
				ws.send(JSON.stringify({ type: data.takenOver ? "release" : "takeover", agentId: id }));
			}
		});
		btn.appendChild(actionBtn);

		btn.addEventListener("click", function () {
			activeAgentTab = this.dataset.agentId;
			lastRenderedTerminalContent = "";
			renderAgentTabs();
			renderTerminalContent();
		});
		agentTabsEl.appendChild(btn);
	}
}

function renderTerminalContent() {
	if (!terminalContentEl) return;
	if (!activeAgentTab || !agentTerminals.has(activeAgentTab)) {
		terminalContentEl.innerHTML = "";
		terminalContentEl.classList.remove("takeover-active");
		if (terminalInputBarEl) terminalInputBarEl.style.display = "none";
		return;
	}

	const data = agentTerminals.get(activeAgentTab);
	const el = terminalContentEl;

	// Skip DOM update when content is unchanged — avoids breaking text selection / copy
	if (data.paneContent === lastRenderedTerminalContent) {
		// Still update takeover state (lightweight, no innerHTML rewrite)
		const isTakenOver = data.takenOver || false;
		el.classList.toggle("takeover-active", isTakenOver);
		if (terminalInputBarEl) {
			terminalInputBarEl.style.display = isTakenOver ? "flex" : "none";
		}
		return;
	}
	lastRenderedTerminalContent = data.paneContent;

	const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
	const prevScrollHeight = el.scrollHeight;
	const prevScrollTop = el.scrollTop;

	el.innerHTML = renderAnsiToHtml(data.paneContent);

	// Takeover mode: show input bar and highlight terminal
	const isTakenOver = data.takenOver || false;
	el.classList.toggle("takeover-active", isTakenOver);
	if (terminalInputBarEl) {
		terminalInputBarEl.style.display = isTakenOver ? "flex" : "none";
	}

	if (isAtBottom) {
		el.scrollTop = el.scrollHeight;
	} else {
		// Preserve scroll position when content grows at the top (history loaded)
		const delta = el.scrollHeight - prevScrollHeight;
		if (delta > 0) {
			el.scrollTop = prevScrollTop + delta;
		}
	}

	// Clear loading state after content is updated
	if (terminalMoreLoading) {
		terminalMoreLoading = false;
	}
}

function switchPanelTab(tab) {
	activePanelTab = tab;
	const tabs = document.querySelectorAll(".panel-tab");
	for (const t of tabs) {
		t.classList.toggle("active", t.dataset.panel === tab);
	}
	if (terminalViewEl) terminalViewEl.classList.toggle("active", tab === "terminal");
	if (evidenceViewEl) evidenceViewEl.classList.toggle("active", tab === "evidence");
}

function initApp() {
	initDomReferences();
	syncExecutionPanelWidth();

	// Request notification permission early
	if ("Notification" in window && Notification.permission === "default") {
		Notification.requestPermission();
	}

	// Panel tab switching
	const panelTabs = document.querySelectorAll(".panel-tab");
	for (const tab of panelTabs) {
		tab.addEventListener("click", function () {
			switchPanelTab(this.dataset.panel);
		});
	}

	// Terminal scroll-to-top: load more history
	if (terminalContentEl) {
		terminalContentEl.addEventListener("scroll", function () {
			if (this.scrollTop > 0) return;
			if (!activeAgentTab || terminalMoreLoading) return;
			if (!ws || ws.readyState !== WebSocket.OPEN) return;
			terminalMoreLoading = true;
			ws.send(JSON.stringify({ type: "terminal_more", agentId: activeAgentTab }));
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
	window.addEventListener("resize", syncExecutionPanelWidth);
	window.addEventListener("blur", stopExecutionPanelResize);

	document.addEventListener("click", function (e) {
		if (!dropdownEl.contains(e.target) && e.target !== inputEl) {
			closeDropdown();
		}
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

	sendBtn.addEventListener("click", sendMessage);

	inputEl.addEventListener("input", function () {
		this.style.height = "auto";
		this.style.height = Math.min(this.scrollHeight, 120) + "px";

		if (this.value.startsWith("/")) {
			activeIndex = -1;
			renderDropdown(getFilteredCommands());
		} else {
			closeDropdown();
		}
	});

	// ─── Terminal input for takeover mode ──────────────
	function sendTerminalInput(inputType, data) {
		if (!ws || ws.readyState !== WebSocket.OPEN || !activeAgentTab) return;
		ws.send(JSON.stringify({ type: "terminal_input", agentId: activeAgentTab, inputType, data: data || "" }));
	}

	if (terminalInputEl) {
		terminalInputEl.addEventListener("keydown", function (e) {
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				const text = terminalInputEl.value;
				if (text) {
					sendTerminalInput("text", text);
				}
				sendTerminalInput("enter");
				terminalInputEl.value = "";
			}
		});
	}

	const ctrlCBtn = document.getElementById("terminal-ctrl-c-btn");
	if (ctrlCBtn) ctrlCBtn.addEventListener("click", function () { sendTerminalInput("ctrl-c"); });

	const escBtn = document.getElementById("terminal-esc-btn");
	if (escBtn) escBtn.addEventListener("click", function () { sendTerminalInput("escape"); });

	// Keyboard capture on terminal content (when taken over and focused)
	if (terminalContentEl) {
		terminalContentEl.setAttribute("tabindex", "0");
		terminalContentEl.addEventListener("keydown", function (e) {
			if (!activeAgentTab) return;
			const data = agentTerminals.get(activeAgentTab);
			if (!data || !data.takenOver) return;

			e.preventDefault();
			if (e.ctrlKey && e.key === "c") {
				sendTerminalInput("ctrl-c");
			} else if (e.key === "Enter") {
				sendTerminalInput("enter");
			} else if (e.key === "Escape") {
				sendTerminalInput("escape");
			} else if (e.key === "ArrowUp") {
				sendTerminalInput("keys", "Up");
			} else if (e.key === "ArrowDown") {
				sendTerminalInput("keys", "Down");
			} else if (e.key === "ArrowLeft") {
				sendTerminalInput("keys", "Left");
			} else if (e.key === "ArrowRight") {
				sendTerminalInput("keys", "Right");
			} else if (e.key === "Backspace") {
				sendTerminalInput("keys", "BSpace");
			} else if (e.key === "Tab") {
				sendTerminalInput("keys", "Tab");
			} else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
				sendTerminalInput("text", e.key);
			}
		});
	}

	connect();
}

if (typeof document !== "undefined") {
	initApp();
}
