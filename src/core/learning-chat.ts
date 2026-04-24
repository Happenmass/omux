import type { LLMClient } from "../llm/client.js";
import type { PromptLoader } from "../llm/prompt-loader.js";
import type { LLMMessage } from "../llm/types.js";
import type { ChatBroadcaster } from "../server/chat-broadcaster.js";
import type { LearningStore } from "./learning-store.js";

export interface LearningChatDeps {
	store: LearningStore;
	broadcaster: ChatBroadcaster;
	llm: LLMClient;
	promptLoader: PromptLoader;
}

interface ActiveState {
	controller: AbortController;
	partial: string;
}

export class LearningChat {
	private active = new Map<string, ActiveState>();

	constructor(private deps: LearningChatDeps) {}

	async handleMessage(entryId: string, content: string): Promise<void> {
		if (this.active.has(entryId)) throw new Error(`already streaming for ${entryId}`);

		// Acquire lock synchronously before any await so concurrent calls are rejected immediately
		const controller = new AbortController();
		const state: ActiveState = { controller, partial: "" };
		this.active.set(entryId, state);

		try {
			const entry = await this.deps.store.loadEntry(entryId);
			if (!entry) throw new Error(`entry not found: ${entryId}`);
			if (entry.status === "archived") throw new Error(`entry is archived: ${entryId}`);

			const history = await this.deps.store.loadMessages(entryId);
			const system = this.deps.promptLoader.resolve("learning-chat", {
				title: entry.summaryJson.title,
				what_changed: entry.summaryJson.what_changed,
				why: entry.summaryJson.why,
				key_files: entry.summaryJson.key_files.map((k) => `- ${k.path} — ${k.role}`).join("\n"),
				design_points: entry.summaryJson.design_points.map((p) => `- ${p}`).join("\n"),
				diff_stats: `${entry.diffStats.filesChanged} files, +${entry.diffStats.additions} −${entry.diffStats.deletions}`,
			});

			await this.deps.store.appendMessage(entryId, "user", content);
			const messages: LLMMessage[] = [
				...history.map((m): LLMMessage => ({ role: m.role, content: m.content })),
				{ role: "user", content },
			];

			for await (const evt of this.deps.llm.stream(messages, {
				systemPrompt: system,
				signal: controller.signal,
			})) {
				if (controller.signal.aborted) {
					const e = new Error("aborted");
					(e as any).name = "AbortError";
					throw e;
				}
				if (evt.type === "text_delta") {
					state.partial += evt.delta;
					this.deps.broadcaster.broadcast({
						type: "learning_delta",
						entryId,
						delta: evt.delta,
					});
				}
			}
			await this.deps.store.appendMessage(entryId, "assistant", state.partial);
		} catch (err) {
			// For validation errors (not found, archived), re-throw without persisting
			const msg = (err as Error).message;
			if (msg.includes("not found") || msg.includes("archived")) {
				throw err;
			}
			const tail = (err as any)?.name === "AbortError" ? " [interrupted]" : ` [error: ${(err as Error).message}]`;
			await this.deps.store.appendMessage(entryId, "assistant", state.partial + tail);
		} finally {
			this.active.delete(entryId);
			this.deps.broadcaster.broadcast({ type: "learning_done", entryId });
		}
	}

	stop(entryId: string): void {
		const s = this.active.get(entryId);
		if (!s) return;
		s.controller.abort();
	}
}
