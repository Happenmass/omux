export type LearningEntryStatus = "active" | "archived";
export type LearningSourceType = "agent" | "merged";
export type LearningMessageRole = "user" | "assistant";

export interface SourceAgentRef {
	sessionId: string;
	sessionName: string;
	baseRef: string; // commit or stash-tree SHA
	endRef: string; // commit SHA resolved at kill time
	cwd: string;
}

export interface KeyFileRef {
	path: string;
	role: string;
}

export interface SummaryJson {
	title: string;
	what_changed: string;
	why: string;
	key_files: KeyFileRef[];
	design_points: string[];
	learning_hooks: string[];
}

export interface DiffFileEntry {
	path: string;
	status: "added" | "modified" | "deleted" | "renamed";
}

export interface DiffStats {
	filesChanged: number;
	additions: number;
	deletions: number;
	filesList: DiffFileEntry[];
}

export interface DiffResult extends DiffStats {
	rawDiff: string;
}

export interface LearningEntry {
	id: string;
	title: string;
	status: LearningEntryStatus;
	sourceType: LearningSourceType;
	sourceAgents: SourceAgentRef[];
	agentPrompts: string[];
	summaryJson: SummaryJson;
	diffStats: DiffStats;
	diffBlobPath: string;
	memoryFlushedAt: number | null;
	createdAt: number;
	updatedAt: number;
}

export type LearningEntrySummary = Omit<LearningEntry, "summaryJson" | "agentPrompts" | "diffBlobPath">;

export interface LearningMessage {
	id: number;
	entryId: string;
	role: LearningMessageRole;
	content: string;
	createdAt: number;
}

export interface CreateLearningEntryInput {
	title: string;
	sourceType: LearningSourceType;
	sourceAgents: SourceAgentRef[];
	agentPrompts: string[];
	summaryJson: SummaryJson;
	diffStats: DiffStats;
	rawDiff: string;
}
