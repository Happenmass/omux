import chalk from "chalk";
import { AgentPreviewComponent } from "./agent-preview.js";
import { BoxComponent } from "./components/box.js";
import type { Component } from "./components/renderer.js";
import { TextComponent } from "./components/text.js";
import { LogStreamComponent } from "./log-stream.js";

export class Dashboard implements Component {
	// Sub-components
	private headerText: TextComponent;
	private agentPreview: AgentPreviewComponent;
	private logStream: LogStreamComponent;
	private statusBar: TextComponent;

	// Boxes
	private previewBox: BoxComponent;
	private logBox: BoxComponent;

	private goal = "";
	private startTime = Date.now();

	constructor() {
		this.headerText = new TextComponent("", chalk.bold);

		this.agentPreview = new AgentPreviewComponent(6);
		this.previewBox = new BoxComponent({
			title: "Agent Output",
			borderStyleFn: chalk.dim,
			titleStyleFn: chalk.bold,
		});
		this.previewBox.addChild(this.agentPreview);

		this.logStream = new LogStreamComponent({ maxLines: 20 });
		this.logBox = new BoxComponent({
			title: "Timeline",
			borderStyleFn: chalk.dim,
			titleStyleFn: chalk.bold,
		});
		this.logBox.addChild(this.logStream);

		this.statusBar = new TextComponent(
			" [q] Quit  [p] Pause/Resume  [c] Config  [s] Steer  [Tab] View Agent",
			chalk.bgWhite.black,
		);
	}

	setGoal(goal: string): void {
		this.goal = goal;
	}

	setAgentOutput(content: string): void {
		this.agentPreview.setContent(content);
	}

	addLog(message: string, level?: "info" | "warn" | "error"): void {
		this.logStream.addMessage(message, level);
	}

	setStatusText(text: string): void {
		this.statusBar.setText(text);
	}

	render(width: number): string[] {
		// Update header with elapsed time
		const elapsed = formatDuration(Date.now() - this.startTime);
		const header = `  ${chalk.bold("Omux")} ${chalk.dim("|")} ${this.goal} ${chalk.dim("|")} ${chalk.dim("⏱")} ${elapsed}`;
		this.headerText.setText(header);

		const lines: string[] = [];

		// Header
		lines.push("");
		lines.push(...this.headerText.render(width));
		lines.push("");

		// Agent Preview
		lines.push(...this.previewBox.render(width));

		// Log Timeline
		lines.push(...this.logBox.render(width));

		// Status bar (at bottom)
		lines.push(...this.statusBar.render(width));

		return lines;
	}

	invalidate(): void {
		this.headerText.invalidate();
		this.agentPreview.invalidate();
		this.logStream.invalidate();
		this.statusBar.invalidate();
		this.previewBox.invalidate();
		this.logBox.invalidate();
	}
}

function formatDuration(ms: number): string {
	const totalSeconds = Math.floor(ms / 1000);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;

	if (hours > 0) {
		return `${hours}:${pad(minutes)}:${pad(seconds)}`;
	}
	return `${pad(minutes)}:${pad(seconds)}`;
}

function pad(n: number): string {
	return n.toString().padStart(2, "0");
}
