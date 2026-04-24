import type { PromptLoader } from "../llm/prompt-loader.js";
import type { MemoryStore } from "../memory/store.js";
import type { ChatBroadcaster } from "../server/chat-broadcaster.js";
import type { ChangeTracker } from "./change-tracker.js";
import type { LearningStore } from "./learning-store.js";
import type { LearningSummarizer } from "./learning-summarizer.js";
import type { DiffResult, DiffStats, LearningEntry, LearningEntrySummary, SourceAgentRef } from "./learning-types.js";

export interface LearningPipelineDeps {
	store: LearningStore;
	tracker: ChangeTracker;
	summarizer: LearningSummarizer;
	memoryStore: MemoryStore;
	broadcaster: ChatBroadcaster;
	promptLoader: PromptLoader;
}

export interface IngestAgentKillCtx {
	sessionId: string;
	sessionName: string;
	cwd: string;
	agentPrompts: string[];
}

function toSummary(entry: LearningEntry): LearningEntrySummary {
	const { summaryJson, agentPrompts, diffBlobPath, ...rest } = entry;
	return rest;
}

export class LearningPipeline {
	constructor(private deps: LearningPipelineDeps) {}

	async ingestAgentKill(ctx: IngestAgentKillCtx): Promise<LearningEntry | null> {
		try {
			const diff = await this.deps.tracker.computeDiff(ctx.sessionId);
			if (!diff || diff.filesChanged === 0) return null;
			const baseline = this.deps.tracker.getBaseline(ctx.sessionId);
			const endRef = (await this.deps.tracker.resolveHeadSha(ctx.cwd)) ?? "HEAD";
			const summary = await this.deps.summarizer.generate({
				agentPrompts: ctx.agentPrompts,
				diffForLLM: diff.rawDiff,
				filesList: diff.filesList,
				mode: "agent",
			});
			const sourceAgents: SourceAgentRef[] = [
				{
					sessionId: ctx.sessionId,
					sessionName: ctx.sessionName,
					baseRef: baseline?.baseRef ?? "",
					endRef,
					cwd: ctx.cwd,
				},
			];
			const entry = await this.deps.store.create({
				title: summary.title,
				sourceType: "agent",
				sourceAgents,
				agentPrompts: ctx.agentPrompts,
				summaryJson: summary,
				diffStats: this.toDiffStats(diff),
				rawDiff: diff.rawDiff,
			});
			this.deps.broadcaster.broadcast({
				type: "learning_entry_created",
				entry: toSummary(entry),
			});
			return entry;
		} catch (err) {
			// Never let learning block kill path. Log and return null.
			console.warn("[learning-pipeline] ingestAgentKill failed:", (err as Error).message);
			return null;
		}
	}

	async merge(ids: string[], titleOverride?: string): Promise<LearningEntry> {
		if (ids.length < 2) throw new Error("merge needs at least 2 entries");
		const entries: LearningEntry[] = [];
		for (const id of ids) {
			const e = await this.deps.store.loadEntry(id);
			if (!e) throw new Error(`entry not found: ${id}`);
			if (e.status !== "active") throw new Error(`cannot merge archived entry: ${id}`);
			entries.push(e);
		}
		entries.sort((a, b) => a.updatedAt - b.updatedAt);
		const diffChunks = await Promise.all(entries.map((e) => this.deps.store.readDiffBlob(e.id)));
		const mergedDiff = diffChunks.join("\n");
		const mergedPrompts = entries.flatMap((e) => e.agentPrompts);
		const mergedStats = this.mergeStats(entries.map((e) => e.diffStats));
		const summary = await this.deps.summarizer.generate({
			agentPrompts: mergedPrompts,
			diffForLLM: mergedDiff,
			filesList: mergedStats.filesList,
			mode: "merged",
		});
		if (titleOverride) summary.title = titleOverride;
		const created = await this.deps.store.create({
			title: summary.title,
			sourceType: "merged",
			sourceAgents: entries.flatMap((e) => e.sourceAgents),
			agentPrompts: mergedPrompts,
			summaryJson: summary,
			diffStats: mergedStats,
			rawDiff: mergedDiff,
		});
		for (const e of entries) {
			await this.deps.store.setStatus(e.id, "archived");
			const updated = (await this.deps.store.loadEntry(e.id))!;
			this.deps.broadcaster.broadcast({
				type: "learning_entry_updated",
				entry: toSummary(updated),
			});
		}
		this.deps.broadcaster.broadcast({
			type: "learning_entry_created",
			entry: toSummary(created),
		});
		return created;
	}

	async regenerate(id: string): Promise<LearningEntry> {
		const entry = await this.deps.store.loadEntry(id);
		if (!entry) throw new Error(`entry not found: ${id}`);
		const rawDiff = await this.deps.store.readDiffBlob(id);
		const summary = await this.deps.summarizer.generate({
			agentPrompts: entry.agentPrompts,
			diffForLLM: rawDiff,
			filesList: entry.diffStats.filesList,
			mode: entry.sourceType,
		});
		await this.deps.store.replaceSummary(id, summary);
		const updated = (await this.deps.store.loadEntry(id))!;
		this.deps.broadcaster.broadcast({
			type: "learning_entry_updated",
			entry: toSummary(updated),
		});
		return updated;
	}

	async flushToMemory(id: string): Promise<LearningEntry> {
		const entry = await this.deps.store.loadEntry(id);
		if (!entry) throw new Error(`entry not found: ${id}`);
		const md = this.deps.promptLoader.resolve("learning-memory", {
			title: entry.summaryJson.title,
			what_changed: entry.summaryJson.what_changed,
			why: entry.summaryJson.why,
			design_points_list: entry.summaryJson.design_points.map((p) => `- ${p}`).join("\n"),
			key_files_list: entry.summaryJson.key_files.map((k) => `- \`${k.path}\` — ${k.role}`).join("\n"),
		});
		await this.deps.memoryStore.edit({
			mode: "overwrite",
			path: `memory/learning/${entry.id}.md`,
			content: md,
		});
		await this.deps.store.markMemoryFlushed(id, Date.now());
		const updated = (await this.deps.store.loadEntry(id))!;
		this.deps.broadcaster.broadcast({
			type: "learning_entry_updated",
			entry: toSummary(updated),
		});
		return updated;
	}

	private toDiffStats(diff: DiffResult): DiffStats {
		return {
			filesChanged: diff.filesChanged,
			additions: diff.additions,
			deletions: diff.deletions,
			filesList: diff.filesList,
		};
	}

	private mergeStats(stats: DiffStats[]): DiffStats {
		const byPath = new Map<string, DiffStats["filesList"][number]>();
		let additions = 0;
		let deletions = 0;
		for (const s of stats) {
			additions += s.additions;
			deletions += s.deletions;
			for (const f of s.filesList) byPath.set(f.path, f); // last write wins
		}
		const filesList = Array.from(byPath.values());
		return { filesChanged: filesList.length, additions, deletions, filesList };
	}
}
