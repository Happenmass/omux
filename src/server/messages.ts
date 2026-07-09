import type { SupportedLocale } from "../utils/locale.js";

/**
 * Backend string table for user-facing, server-generated messages broadcast to the chat UI.
 *
 * The documented locale system (zh-CN / en-US) previously only reached prompts and the
 * frontend; server-originated system messages in ws-handler.ts / command-router.ts were
 * hardcoded in Chinese, so en-US users saw Chinese. Route every such string through `t()`.
 *
 * Keys are short and flat. Values are either a plain string or a formatter taking the
 * interpolation params. Do NOT touch the web/ frontend i18n — this is backend-only.
 */

type MessageValue = string | ((p: Record<string, string | number>) => string);

const EN: Record<string, MessageValue> = {
	// ws-handler.ts
	msg_handle_error: (p) => `Error handling message: ${p.error}`,
	command_error: (p) => `Command failed: ${p.error}`,
	agent_taken_over: (p) => `Session ${p.agentId} has been taken over by a human`,
	agent_released: (p) => `Session ${p.agentId} has been returned to MainAgent control`,
	agent_active_after_release: (p) =>
		`Session ${p.agentId} is still working after release — resuming monitoring, MainAgent will report when it settles`,

	// main-agent.ts
	agent_release_task_summary: "Task the human started while the session was taken over (detected active on release)",
	execution_error: (p) => `Execution failed: ${p.error} — the current turn was aborted, please retry`,
	context_compacted_divider: "— context compacted · earlier turns summarized —",
	message_queued: "Message queued; it will be handled after the current operation completes",
	execution_stopped: "Execution stopped",
	autocontinue_cap_reached: "Auto-continue cap reached, handing control back",
	autocontinue_progress: (p) => `🔄 Auto-continue (${p.count}/${p.max}): ${p.reason}`,

	// main.ts
	mdns_rebroadcast: (p) => `Network changed; mDNS re-advertised at ${p.url}`,
	restored_messages: (p) => `Restored ${p.count} message(s) from the previous session`,

	// core/tools — misc-tools.ts
	task_failed: (p) => `Task failed: ${p.reason}`,
	human_intervention_needed: (p) => `Human intervention needed: ${p.reason}`,

	// core/tools — agent-tools.ts
	agent_interrupted: (p) => `Interrupting agent: ${p.summary}`,
	parked_waiting: (p) => `⏸ Parked, waiting for ${p.count} sub-agent callback(s)`,

	// command-router.ts — broadcasts
	unknown_command: (p) => `Unknown command: /${p.name}`,
	not_executing: "No task is currently executing",
	autocontinue_on: (p) => `auto-continue enabled · cap ${p.max}`,
	autocontinue_off: "auto-continue disabled",
	clearing_conversation: "Clearing conversation and extracting memory...",
	compact_empty: "No conversation to compress",
	compact_extracting: "Extracting key memory...",
	compact_compressing: "Compressing conversation history...",
	compact_done: "Conversation history compressed and injected into the system prompt",
	resetting: "Resetting: reloading prompts and skills, clearing conversation...",
	reset_done: "System reset: conversation cleared, prompts and skills reloaded",
	context_title: "📊 Context usage",
	context_tokens: (p) => `Token estimate: ${p.estimate} / ${p.limit} (${p.usage}%)`,
	context_messages: (p) => `Conversation messages: ${p.count}`,
	tidy_unavailable: "Memory tidy unavailable: missing LLM or memory store configuration",
	tidy_running: "Tidying memory files...",
	tidy_file_summary: (p) => `${p.path}: ${p.summary}`,
	tidy_file_failed: (p) => `${p.path}: failed - ${p.error}`,
	tidy_archived_file: (p) => `Archive file: ${p.path}`,
	tidy_done: (p) => `Memory tidy complete:\n${p.summaries}`,
	tidy_empty: "Memory files are empty, nothing to tidy",

	// command-router.ts — BUILTIN_COMMANDS descriptions
	cmd_stop: "Stop the currently executing task",
	cmd_clear: "Clear conversation history",
	cmd_reset: "Reset conversation and reload prompts and skills",
	cmd_compact: "Compress conversation history and inject into the system prompt",
	cmd_context: "View context usage",
	cmd_tidy: "Tidy memory files, archiving outdated entries",
	cmd_autocontinue: "Toggle auto-continue mode",
};

const ZH: Record<string, MessageValue> = {
	// ws-handler.ts
	msg_handle_error: (p) => `处理消息时出错: ${p.error}`,
	command_error: (p) => `指令执行出错: ${p.error}`,
	agent_taken_over: (p) => `会话 ${p.agentId} 已被人工接管`,
	agent_released: (p) => `会话 ${p.agentId} 已恢复 MainAgent 控制`,
	agent_active_after_release: (p) => `会话 ${p.agentId} 释放后仍在运行 — 已恢复监控，任务结束时 MainAgent 会收到回调`,

	// main-agent.ts
	agent_release_task_summary: "人工接管期间发起的任务（释放时检测到仍在运行）",
	execution_error: (p) => `执行出错: ${p.error} — 本轮已中止，请重试`,
	context_compacted_divider: "— 上下文已压缩 · 较早的对话已被摘要 —",
	message_queued: "消息已排队，将在当前操作完成后处理",
	execution_stopped: "执行已停止",
	autocontinue_cap_reached: "已达自动继续上限，交还控制权",
	autocontinue_progress: (p) => `🔄 自动继续 (${p.count}/${p.max}): ${p.reason}`,

	// main.ts
	mdns_rebroadcast: (p) => `网络已变化，mDNS 已重新广播：${p.url}`,
	restored_messages: (p) => `已从上次会话恢复 ${p.count} 条消息`,

	// core/tools — misc-tools.ts
	task_failed: (p) => `任务失败: ${p.reason}`,
	human_intervention_needed: (p) => `需要人工介入: ${p.reason}`,

	// core/tools — agent-tools.ts
	agent_interrupted: (p) => `中断 agent: ${p.summary}`,
	parked_waiting: (p) => `⏸ 已挂起，等待 ${p.count} 个子代理回调`,

	// command-router.ts — broadcasts
	unknown_command: (p) => `未知指令: /${p.name}`,
	not_executing: "当前未在执行任务",
	autocontinue_on: (p) => `auto-continue 已开启 · 上限 ${p.max} 次`,
	autocontinue_off: "auto-continue 已关闭",
	clearing_conversation: "正在清理对话并提取记忆...",
	compact_empty: "当前没有对话内容，无需压缩",
	compact_extracting: "正在提取关键记忆...",
	compact_compressing: "正在压缩对话历史...",
	compact_done: "对话历史已压缩并注入系统提示词",
	resetting: "正在重置：重新加载提示词与技能，并清理对话...",
	reset_done: "系统已重置：对话已清空，提示词和技能已重新加载",
	context_title: "📊 上下文用量",
	context_tokens: (p) => `Token 估算: ${p.estimate} / ${p.limit} (${p.usage}%)`,
	context_messages: (p) => `对话消息数: ${p.count}`,
	tidy_unavailable: "记忆整理不可用：缺少 LLM 或记忆存储配置",
	tidy_running: "正在整理记忆文件...",
	tidy_file_summary: (p) => `${p.path}: ${p.summary}`,
	tidy_file_failed: (p) => `${p.path}: 处理失败 - ${p.error}`,
	tidy_archived_file: (p) => `归档文件: ${p.path}`,
	tidy_done: (p) => `记忆整理完成：\n${p.summaries}`,
	tidy_empty: "记忆文件为空，无需整理",

	// command-router.ts — BUILTIN_COMMANDS descriptions
	cmd_stop: "停止当前执行任务",
	cmd_clear: "清空对话历史",
	cmd_reset: "重置对话并重新加载提示词和技能",
	cmd_compact: "压缩对话历史并注入系统提示词",
	cmd_context: "查看上下文用量",
	cmd_tidy: "整理记忆文件，归档过时条目",
	cmd_autocontinue: "切换 auto-continue 自动续跑模式",
};

const TABLES: Record<SupportedLocale, Record<string, MessageValue>> = {
	"en-US": EN,
	"zh-CN": ZH,
};

/**
 * Look up a backend message by key for the given locale, interpolating `params`.
 * Falls back to en-US if the locale is missing the key, then to the raw key.
 */
export function t(
	key: string,
	locale: SupportedLocale = "en-US",
	params: Record<string, string | number> = {},
): string {
	const table = TABLES[locale] ?? EN;
	const value = table[key] ?? EN[key];
	if (value === undefined) return key;
	return typeof value === "function" ? value(params) : value;
}
