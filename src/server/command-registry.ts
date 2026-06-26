/**
 * Central registry for slash command metadata.
 * Holds descriptors for both built-in commands and skill-declared commands.
 * Used by REST API (/api/commands) to expose the command list to any client.
 */

export interface CommandDescriptor {
	/** Command name without leading `/`, e.g. "stop", "commit" */
	name: string;
	/** Short human-readable description */
	description: string;
	/** "builtin" for hardcoded commands, "skill" for skill-declared commands */
	category: "builtin" | "skill";
	/** Source skill name (only when category is "skill") */
	skillName?: string;
}

export class CommandRegistry {
	private commands = new Map<string, CommandDescriptor>();

	register(descriptor: CommandDescriptor): void {
		this.commands.set(descriptor.name, descriptor);
	}

	registerMany(descriptors: CommandDescriptor[]): void {
		for (const d of descriptors) {
			this.register(d);
		}
	}

	get(name: string): CommandDescriptor | undefined {
		return this.commands.get(name);
	}

	has(name: string): boolean {
		return this.commands.has(name);
	}

	getAll(): CommandDescriptor[] {
		return Array.from(this.commands.values());
	}

	/** Filter commands by name or description substring match */
	search(query?: string): CommandDescriptor[] {
		const all = this.getAll();
		if (!query) return all;
		const q = query.toLowerCase();
		return all.filter((c) => c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q));
	}

	/** Remove all skill-declared commands, keeping builtin commands intact. */
	clearSkillCommands(): void {
		for (const [name, desc] of this.commands) {
			if (desc.category === "skill") {
				this.commands.delete(name);
			}
		}
	}

	get size(): number {
		return this.commands.size;
	}
}
