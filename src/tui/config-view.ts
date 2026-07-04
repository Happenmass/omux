import chalk from "chalk";
import { getAllProviders, getProvider } from "../llm/providers/registry.js";
import { KNOWN_AGENTS, normalizeAgents, type OmuxConfig } from "../utils/config.js";
import { BoxComponent } from "./components/box.js";
import type { Component } from "./components/renderer.js";
import type { SelectItem } from "./components/select-list.js";
import { SelectListComponent } from "./components/select-list.js";
import { TextComponent } from "./components/text.js";
import { TextInputComponent } from "./components/text-input.js";

type ConfigMode = "list" | "submenu" | "textinput";

/** Human-readable label for an adapter key (e.g. "claude-code" → "Claude Code"). */
function agentDisplayName(name: string): string {
	return name
		.split(/[-_]/)
		.map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
		.join(" ");
}

interface ConfigMenuItem {
	key: string;
	label: string;
	getValue: () => string;
	description: string;
	type: "submenu" | "cycle" | "text";
}

export interface ConfigViewOptions {
	onSave?: (config: OmuxConfig) => void;
	onClose?: () => void;
}

export class ConfigView implements Component {
	private config: OmuxConfig;
	private mode: ConfigMode = "list";
	private selectedIndex = 0;
	private menuItems: ConfigMenuItem[];

	// Sub-components
	private selectList: SelectListComponent | null = null;
	private textInput: TextInputComponent | null = null;

	// Layout components
	private box: BoxComponent;
	private contentText: TextComponent;
	private hintText: TextComponent;

	// Callbacks
	private onSave: ((config: OmuxConfig) => void) | null;
	private onClose: (() => void) | null;

	private cached: string[] | null = null;

	constructor(config: OmuxConfig, options: ConfigViewOptions = {}) {
		this.config = { ...config, llm: { ...config.llm } };
		this.onSave = options.onSave ?? null;
		this.onClose = options.onClose ?? null;

		this.menuItems = this.buildMenuItems();

		this.box = new BoxComponent({
			title: "Omux Configuration",
			borderStyle: "rounded",
			borderStyleFn: chalk.cyan,
			titleStyleFn: chalk.bold.cyan,
		});

		this.contentText = new TextComponent();
		this.hintText = new TextComponent("", chalk.dim);

		this.box.addChild(this.contentText);
		this.box.addChild(this.hintText);
	}

	private buildMenuItems(): ConfigMenuItem[] {
		return [
			{
				key: "provider",
				label: "Default Provider",
				getValue: () => this.config.llm.provider,
				description: "Configure the LLM provider for planning",
				type: "submenu",
			},
			{
				key: "model",
				label: "Model",
				getValue: () => this.config.llm.model,
				description: "Select the model to use",
				type: "submenu",
			},
			{
				key: "apiKey",
				label: "API Key",
				getValue: () => (this.config.llm.apiKey ? "********" : chalk.dim("(not set)")),
				description: "Set the API key for the current provider",
				type: "text",
			},
			{
				key: "thinking",
				label: "Thinking",
				getValue: () => {
					const t = this.config.llm.thinking ?? "off";
					return t === "off" ? chalk.dim("OFF") : chalk.green(t);
				},
				description: "Extended thinking / reasoning effort (off, minimal, low, medium, high)",
				type: "cycle",
			},
			{
				key: "baseUrl",
				label: "Base URL",
				getValue: () => this.config.llm.baseUrl || chalk.dim("(not set)"),
				description: "Custom API endpoint (optional)",
				type: "text",
			},
			{
				key: "proxy",
				label: "Proxy",
				getValue: () => this.config.llm.proxy || chalk.dim("(not set)"),
				description: "HTTP/HTTPS/SOCKS proxy for main-agent LLM calls only (sub-agents unaffected)",
				type: "text",
			},
			{
				key: "debug",
				label: "Debug Mode",
				getValue: () => (this.config.debug ? chalk.green("ON") : chalk.dim("OFF")),
				description: "Log every MainAgent LLM response for debugging",
				type: "cycle",
			},
			{
				key: "learning",
				label: "Learning Sessions",
				getValue: () => (this.config.learning?.enabled ? chalk.green("ON") : chalk.dim("OFF")),
				description: "Track sub-agent changes and generate learning entries",
				type: "cycle",
			},
			{
				key: "activeAgents",
				label: "Active Agents",
				getValue: () => (this.config.enabledAgents ?? [this.config.defaultAgent]).join(", "),
				description:
					"Toggle which coding-agent adapters are active (Enter to open). The first active one is the default.",
				type: "submenu",
			},
		];
	}

	handleInput(data: string): void {
		if (this.mode === "submenu" && this.selectList) {
			this.selectList.handleInput(data);
			this.cached = null;
			this.box.invalidate();
			return;
		}

		if (this.mode === "textinput" && this.textInput) {
			this.textInput.handleInput(data);
			this.cached = null;
			this.box.invalidate();
			return;
		}

		// List mode
		switch (data) {
			case "\x1b[A": // Up
			case "k":
				if (this.selectedIndex > 0) {
					this.selectedIndex--;
					this.cached = null;
					this.box.invalidate();
				}
				break;

			case "\x1b[B": // Down
			case "j":
				if (this.selectedIndex < this.menuItems.length - 1) {
					this.selectedIndex++;
					this.cached = null;
					this.box.invalidate();
				}
				break;

			case "\r": // Enter
				this.activateItem(this.menuItems[this.selectedIndex]);
				break;

			case "\x1b": // Esc
			case "q":
				this.onClose?.();
				break;
		}
	}

	private activateItem(item: ConfigMenuItem): void {
		switch (item.type) {
			case "submenu":
				this.openSubmenu(item.key);
				break;
			case "cycle":
				this.cycleValue(item.key);
				break;
			case "text":
				this.openTextInput(item.key);
				break;
		}
	}

	private openSubmenu(key: string): void {
		if (key === "activeAgents") {
			this.openActiveAgentsSubmenu();
			return;
		}

		let items: SelectItem[];

		if (key === "provider") {
			items = getAllProviders().map((p) => ({
				value: p.name,
				label: p.displayName,
				description: p.baseUrl,
			}));
		} else if (key === "model") {
			const provider = getProvider(this.config.llm.provider);
			const models = provider?.models ?? [];
			items = models.map((m) => ({ value: m, label: m }));
			items.push({ value: "__custom__", label: "Custom..." });
		} else {
			return;
		}

		this.selectList = new SelectListComponent(items, {
			maxVisible: 8,
			onSelect: (selected) => {
				if (key === "provider") {
					this.config.llm.provider = selected.value;
					// Auto-switch to provider's default model
					const prov = getProvider(selected.value);
					if (prov) {
						this.config.llm.model = prov.defaultModel;
					}
				} else if (key === "model") {
					if (selected.value === "__custom__") {
						// Switch to text input for custom model
						this.mode = "list";
						this.selectList = null;
						this.openTextInput("customModel");
						return;
					}
					this.config.llm.model = selected.value;
				}
				this.mode = "list";
				this.selectList = null;
				this.cached = null;
				this.box.invalidate();
				this.onSave?.(this.config);
			},
			onCancel: () => {
				this.mode = "list";
				this.selectList = null;
				this.cached = null;
				this.box.invalidate();
			},
		});

		this.mode = "submenu";
		this.cached = null;
		this.box.invalidate();
	}

	/** Checkbox submenu: Enter toggles an adapter on/off and stays open; Esc returns to the list. */
	private openActiveAgentsSubmenu(): void {
		this.selectList = new SelectListComponent(this.buildActiveAgentItems(), {
			maxVisible: 8,
			onSelect: (selected) => {
				this.toggleActiveAgent(selected.value);
				this.selectList?.setItems(this.buildActiveAgentItems(), { keepSelection: true });
				this.cached = null;
				this.box.invalidate();
				this.onSave?.(this.config);
			},
			onCancel: () => {
				this.mode = "list";
				this.selectList = null;
				this.cached = null;
				this.box.invalidate();
			},
		});

		this.mode = "submenu";
		this.cached = null;
		this.box.invalidate();
	}

	/** One checkbox row per known adapter, marking the active ones and the derived default. */
	private buildActiveAgentItems(): SelectItem[] {
		const enabled = new Set(this.config.enabledAgents ?? [this.config.defaultAgent]);
		return KNOWN_AGENTS.map((name) => {
			const box = enabled.has(name) ? "[x]" : "[ ]";
			const isDefault = name === this.config.defaultAgent;
			return {
				value: name,
				label: `${box} ${agentDisplayName(name)}${isDefault ? chalk.dim(" (default)") : ""}`,
			};
		});
	}

	/** Toggle one adapter's membership in enabledAgents, keeping at least one active. */
	private toggleActiveAgent(name: string): void {
		const enabled = new Set(this.config.enabledAgents ?? [this.config.defaultAgent]);
		if (enabled.has(name)) {
			if (enabled.size <= 1) return; // never leave zero adapters active
			enabled.delete(name);
		} else {
			enabled.add(name);
		}
		// Preserve the canonical known-adapter order.
		this.config.enabledAgents = [...KNOWN_AGENTS].filter((a) => enabled.has(a));
		// Re-derive defaultAgent against the new active set.
		normalizeAgents(this.config, true);
	}

	private cycleValue(key: string): void {
		if (key === "debug") {
			this.config.debug = !this.config.debug;
		} else if (key === "learning") {
			if (!this.config.learning) this.config.learning = { enabled: false };
			this.config.learning.enabled = !this.config.learning.enabled;
		} else if (key === "thinking") {
			const levels = ["off", "minimal", "low", "medium", "high"] as const;
			const current = this.config.llm.thinking ?? "off";
			const idx = levels.indexOf(current);
			this.config.llm.thinking = levels[(idx + 1) % levels.length];
		}
		this.cached = null;
		this.box.invalidate();
		this.onSave?.(this.config);
	}

	private openTextInput(key: string): void {
		let initialValue = "";
		let mask = false;
		let placeholder = "Enter value...";

		if (key === "apiKey") {
			mask = true;
			placeholder = "Enter API key...";
			initialValue = this.config.llm.apiKey ?? "";
		} else if (key === "baseUrl") {
			placeholder = "https://api.example.com/v1";
			initialValue = this.config.llm.baseUrl ?? "";
		} else if (key === "proxy") {
			placeholder = "socks://127.0.0.1:10808";
			initialValue = this.config.llm.proxy ?? "";
		} else if (key === "customModel") {
			placeholder = "Enter model name...";
			initialValue = this.config.llm.model;
		}

		this.textInput = new TextInputComponent({
			initialValue,
			mask,
			placeholder,
			onSubmit: (value) => {
				if (key === "apiKey") {
					this.config.llm.apiKey = value || undefined;
				} else if (key === "baseUrl") {
					this.config.llm.baseUrl = value || undefined;
				} else if (key === "proxy") {
					this.config.llm.proxy = value || undefined;
				} else if (key === "customModel") {
					this.config.llm.model = value;
				}
				this.mode = "list";
				this.textInput = null;
				this.cached = null;
				this.box.invalidate();
				this.onSave?.(this.config);
			},
			onCancel: () => {
				this.mode = "list";
				this.textInput = null;
				this.cached = null;
				this.box.invalidate();
			},
		});

		this.mode = "textinput";
		this.cached = null;
		this.box.invalidate();
	}

	render(width: number): string[] {
		// Build content based on current mode
		const contentLines: string[] = [];

		if (this.mode === "list") {
			contentLines.push("");
			for (let i = 0; i < this.menuItems.length; i++) {
				const item = this.menuItems[i];
				const isSelected = i === this.selectedIndex;
				const prefix = isSelected ? " \u2192 " : "   ";
				const label = item.label.padEnd(20);
				const value = item.getValue();

				if (isSelected) {
					contentLines.push(prefix + chalk.bold(label) + value);
				} else {
					contentLines.push(prefix + label + chalk.dim(value));
				}
			}
			contentLines.push("");

			// Description of selected item
			const desc = this.menuItems[this.selectedIndex].description;
			contentLines.push("  " + chalk.dim(desc));
			contentLines.push("");

			this.hintText.setText("  \u2191\u2193 Navigate  Enter Change  Esc Close");
		} else if (this.mode === "submenu" && this.selectList) {
			contentLines.push("");
			const submenuKey = this.menuItems[this.selectedIndex].key;
			const submenuTitle =
				submenuKey === "provider"
					? "Select Provider:"
					: submenuKey === "activeAgents"
						? "Active Agents:"
						: "Select Model:";
			contentLines.push("  " + chalk.bold(submenuTitle));
			contentLines.push("");
			contentLines.push(...this.selectList.render(width - 4));
			contentLines.push("");

			const submenuHint =
				submenuKey === "activeAgents"
					? "  \u2191\u2193 Navigate  Enter Toggle  Esc Back"
					: "  \u2191\u2193 Navigate  Enter Select  Esc Back";
			this.hintText.setText(submenuHint);
		} else if (this.mode === "textinput" && this.textInput) {
			contentLines.push("");
			const inputLabel = this.menuItems[this.selectedIndex].label;
			contentLines.push("  " + chalk.bold(inputLabel + ":"));
			contentLines.push("");
			contentLines.push(...this.textInput.render(width - 4));
			contentLines.push("");

			this.hintText.setText("  Enter Submit  Esc Cancel");
		}

		this.contentText.setText(contentLines.join("\n"));
		this.box.invalidate();

		return this.box.render(width);
	}

	invalidate(): void {
		this.cached = null;
		this.box.invalidate();
	}
}
