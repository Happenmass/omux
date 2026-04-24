export class PromptTracker {
	private map = new Map<string, string[]>();

	record(sessionId: string, prompt: string): void {
		const arr = this.map.get(sessionId) ?? [];
		arr.push(prompt);
		this.map.set(sessionId, arr);
	}

	getFor(sessionId: string): string[] {
		return this.map.get(sessionId)?.slice() ?? [];
	}

	release(sessionId: string): void {
		this.map.delete(sessionId);
	}
}
