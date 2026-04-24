// web/i18n.js — Minimal i18n for Cliclaw frontend

const messages = {
	"zh-CN": {
		// Learning panel
		"learning.tab": "学习记录",
		"learning.search": "搜索条目...",
		"learning.active": "活跃",
		"learning.archived": "已归档",
		"learning.merge": "合并所选",
		"learning.empty": "子 Agent 完成工作后，学习记录将显示在此处。",
		"learning.detailEmpty": "选择一个条目查看摘要。",
		"learning.summary": "摘要",
		"learning.chat": "对话",
		"learning.chatPlaceholder": "询问关于此变更的内容...",
		"learning.send": "发送",
		"learning.whatChanged": "变更内容",
		"learning.why": "变更原因",
		"learning.keyFiles": "关键文件",
		"learning.designPoints": "设计要点",
		"learning.hooks": "延伸问题",
		"learning.viewDiff": "查看完整 diff",
		"learning.regenerate": "重新生成",
		"learning.flush": "写入记忆",
		"learning.flushed": "✓ 已写入",
		"learning.archive": "归档",
		"learning.unarchive": "取消归档",
		"learning.delete": "删除",
		"learning.deleteConfirm": "确定删除此学习记录？同时将移除对话记录和 diff 文件。",
		"learning.mergeFailed": "合并失败",
		"learning.chatError": "学习对话出错",
		"learning.chatEmpty": "询问关于此变更的内容。",
		"learning.close": "关闭",
		"learning.merged": "个 agent 合并",
		// Relative time
		"time.justNow": "刚刚",
		"time.minutesAgo": "分钟前",
		"time.hoursAgo": "小时前",
		"time.daysAgo": "天前",
	},
	"en-US": {
		"learning.tab": "Learning",
		"learning.search": "Search entries...",
		"learning.active": "Active",
		"learning.archived": "Archived",
		"learning.merge": "Merge selected",
		"learning.empty": "Learning entries appear here after sub-agents finish their work.",
		"learning.detailEmpty": "Select an entry to view its summary.",
		"learning.summary": "Summary",
		"learning.chat": "Chat",
		"learning.chatPlaceholder": "Ask about this change...",
		"learning.send": "Send",
		"learning.whatChanged": "What changed",
		"learning.why": "Why",
		"learning.keyFiles": "Key files",
		"learning.designPoints": "Design points",
		"learning.hooks": "Learning hooks",
		"learning.viewDiff": "View full diff",
		"learning.regenerate": "Regenerate",
		"learning.flush": "Flush to memory",
		"learning.flushed": "✓ Flushed",
		"learning.archive": "Archive",
		"learning.unarchive": "Unarchive",
		"learning.delete": "Delete",
		"learning.deleteConfirm": "Delete this learning entry? This also removes its chat and diff.",
		"learning.mergeFailed": "Merge failed",
		"learning.chatError": "Learning chat error",
		"learning.chatEmpty": "Ask about what changed and why.",
		"learning.close": "Close",
		"learning.merged": "agents merged",
		"time.justNow": "just now",
		"time.minutesAgo": "m ago",
		"time.hoursAgo": "h ago",
		"time.daysAgo": "d ago",
	},
};

let currentLocale = "en-US";

/**
 * Initialize i18n. Uses server-provided locale, falls back to browser detection.
 * @param {string} [serverLocale] — locale string from /api/status
 */
export function initI18n(serverLocale) {
	if (serverLocale && messages[serverLocale]) {
		currentLocale = serverLocale;
	} else {
		const nav = navigator.language || "";
		currentLocale = /^zh/i.test(nav) ? "zh-CN" : "en-US";
	}
	applyI18nToPage();
}

/** Apply i18n to all elements with data-i18n or data-i18n-placeholder attributes */
function applyI18nToPage() {
	for (const el of document.querySelectorAll("[data-i18n]")) {
		el.textContent = t(el.dataset.i18n);
	}
	for (const el of document.querySelectorAll("[data-i18n-placeholder]")) {
		el.placeholder = t(el.dataset.i18nPlaceholder);
	}
}

/** Get localized string by key */
export function t(key) {
	return (messages[currentLocale] && messages[currentLocale][key]) || messages["en-US"][key] || key;
}

/** Get current resolved locale */
export function getLocale() {
	return currentLocale;
}
