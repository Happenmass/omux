import chalk from "chalk";
import type { Component } from "./renderer.js";

export interface SelectItem {
	value: string;
	label: string;
	description?: string;
}

export interface SelectListOptions {
	maxVisible?: number;
	onSelect?: (item: SelectItem) => void;
	onCancel?: () => void;
}

export class SelectListComponent implements Component {
	private items: SelectItem[];
	private selectedIndex = 0;
	private scrollOffset = 0;
	private maxVisible: number;
	private onSelect: ((item: SelectItem) => void) | null;
	private onCancel: (() => void) | null;
	private cached: string[] | null = null;

	constructor(items: SelectItem[], options: SelectListOptions = {}) {
		this.items = items;
		this.maxVisible = options.maxVisible ?? 10;
		this.onSelect = options.onSelect ?? null;
		this.onCancel = options.onCancel ?? null;
	}

	setItems(items: SelectItem[], opts?: { keepSelection?: boolean }): void {
		this.items = items;
		if (opts?.keepSelection) {
			// Clamp the existing cursor into the new bounds (used by toggle-in-place menus).
			this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, items.length - 1));
			if (this.selectedIndex < this.scrollOffset) {
				this.scrollOffset = this.selectedIndex;
			} else if (this.selectedIndex >= this.scrollOffset + this.maxVisible) {
				this.scrollOffset = Math.max(0, this.selectedIndex - this.maxVisible + 1);
			}
		} else {
			this.selectedIndex = 0;
			this.scrollOffset = 0;
		}
		this.cached = null;
	}

	getSelectedItem(): SelectItem | undefined {
		return this.items[this.selectedIndex];
	}

	handleInput(data: string): void {
		switch (data) {
			case "\x1b[A": // Up arrow
			case "k":
				if (this.selectedIndex > 0) {
					this.selectedIndex--;
					if (this.selectedIndex < this.scrollOffset) {
						this.scrollOffset = this.selectedIndex;
					}
					this.cached = null;
				}
				break;

			case "\x1b[B": // Down arrow
			case "j":
				if (this.selectedIndex < this.items.length - 1) {
					this.selectedIndex++;
					if (this.selectedIndex >= this.scrollOffset + this.maxVisible) {
						this.scrollOffset = this.selectedIndex - this.maxVisible + 1;
					}
					this.cached = null;
				}
				break;

			case "\r": // Enter
				if (this.items.length > 0) {
					this.onSelect?.(this.items[this.selectedIndex]);
				}
				break;

			case "\x1b": // Esc
				this.onCancel?.();
				break;
		}
	}

	render(width: number): string[] {
		if (this.cached) return this.cached;

		const lines: string[] = [];
		const visibleCount = Math.min(this.maxVisible, this.items.length);
		const end = Math.min(this.scrollOffset + visibleCount, this.items.length);

		for (let i = this.scrollOffset; i < end; i++) {
			const item = this.items[i];
			const isSelected = i === this.selectedIndex;
			const prefix = isSelected ? " \u2192 " : "   ";
			const label = item.label;

			if (isSelected) {
				lines.push(prefix + chalk.bold(label));
			} else {
				lines.push(prefix + chalk.dim(label));
			}
		}

		// Position indicator
		if (this.items.length > this.maxVisible) {
			lines.push("");
			lines.push(chalk.dim(`   (${this.selectedIndex + 1}/${this.items.length})`));
		}

		this.cached = lines;
		return lines;
	}

	invalidate(): void {
		this.cached = null;
	}
}
