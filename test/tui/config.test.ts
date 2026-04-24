import { describe, it, expect } from "vitest";
import { SelectListComponent } from "../../src/tui/components/select-list.js";
import type { SelectItem } from "../../src/tui/components/select-list.js";
import { TextInputComponent } from "../../src/tui/components/text-input.js";
import { ConfigView } from "../../src/tui/config-view.js";
import type { CliclawConfig } from "../../src/utils/config.js";

describe("SelectListComponent", () => {
	const items: SelectItem[] = [
		{ value: "a", label: "Alpha" },
		{ value: "b", label: "Beta" },
		{ value: "c", label: "Gamma" },
	];

	it("should render items with cursor on first item", () => {
		const list = new SelectListComponent(items);
		const lines = list.render(40);

		// First item should have arrow prefix
		expect(lines[0]).toContain("\u2192");
		expect(lines[0]).toContain("Alpha");
		expect(lines[1]).toContain("Beta");
		expect(lines[2]).toContain("Gamma");
	});

	it("should move cursor down with arrow key", () => {
		const list = new SelectListComponent(items);
		list.handleInput("\x1b[B"); // Down arrow
		const lines = list.render(40);

		expect(lines[0]).not.toContain("\u2192");
		expect(lines[1]).toContain("\u2192");
		expect(lines[1]).toContain("Beta");
	});

	it("should move cursor down with j key", () => {
		const list = new SelectListComponent(items);
		list.handleInput("j");
		const selected = list.getSelectedItem();
		expect(selected?.value).toBe("b");
	});

	it("should move cursor up with arrow key", () => {
		const list = new SelectListComponent(items);
		list.handleInput("\x1b[B"); // Down
		list.handleInput("\x1b[A"); // Up
		const selected = list.getSelectedItem();
		expect(selected?.value).toBe("a");
	});

	it("should move cursor up with k key", () => {
		const list = new SelectListComponent(items);
		list.handleInput("j"); // Down
		list.handleInput("k"); // Up
		const selected = list.getSelectedItem();
		expect(selected?.value).toBe("a");
	});

	it("should not move above first item", () => {
		const list = new SelectListComponent(items);
		list.handleInput("\x1b[A"); // Up at top
		const selected = list.getSelectedItem();
		expect(selected?.value).toBe("a");
	});

	it("should not move below last item", () => {
		const list = new SelectListComponent(items);
		list.handleInput("\x1b[B"); // Down
		list.handleInput("\x1b[B"); // Down
		list.handleInput("\x1b[B"); // Down (past end)
		const selected = list.getSelectedItem();
		expect(selected?.value).toBe("c");
	});

	it("should call onSelect on Enter", () => {
		let selected: SelectItem | null = null;
		const list = new SelectListComponent(items, {
			onSelect: (item) => { selected = item; },
		});
		list.handleInput("j"); // Move to Beta
		list.handleInput("\r"); // Enter
		expect(selected?.value).toBe("b");
	});

	it("should call onCancel on Esc", () => {
		let cancelled = false;
		const list = new SelectListComponent(items, {
			onCancel: () => { cancelled = true; },
		});
		list.handleInput("\x1b"); // Esc
		expect(cancelled).toBe(true);
	});

	it("should show scroll indicator when items exceed maxVisible", () => {
		const manyItems: SelectItem[] = Array.from({ length: 15 }, (_, i) => ({
			value: `item-${i}`,
			label: `Item ${i}`,
		}));
		const list = new SelectListComponent(manyItems, { maxVisible: 5 });
		const lines = list.render(40);

		// Should show position indicator
		const posLine = lines.find((l) => l.includes("/15"));
		expect(posLine).toBeDefined();
	});

	it("should scroll when navigating past maxVisible", () => {
		const manyItems: SelectItem[] = Array.from({ length: 10 }, (_, i) => ({
			value: `item-${i}`,
			label: `Item ${i}`,
		}));
		const list = new SelectListComponent(manyItems, { maxVisible: 3 });

		// Move to 4th item (index 3)
		list.handleInput("j");
		list.handleInput("j");
		list.handleInput("j");

		const lines = list.render(40);
		// Should show items around index 3
		const joinedLines = lines.join("\n");
		expect(joinedLines).toContain("Item 3");
	});
});

describe("TextInputComponent", () => {
	it("should render with placeholder when empty", () => {
		const input = new TextInputComponent({ placeholder: "Type here..." });
		const lines = input.render(40);
		expect(lines[0]).toContain("Type here...");
	});

	it("should accept character input", () => {
		const input = new TextInputComponent();
		input.handleInput("h");
		input.handleInput("e");
		input.handleInput("l");
		input.handleInput("l");
		input.handleInput("o");
		expect(input.getValue()).toBe("hello");
	});

	it("should handle backspace", () => {
		const input = new TextInputComponent({ initialValue: "test" });
		input.handleInput("\x7f"); // Backspace
		expect(input.getValue()).toBe("tes");
	});

	it("should handle backspace on empty value", () => {
		const input = new TextInputComponent();
		input.handleInput("\x7f"); // Backspace on empty
		expect(input.getValue()).toBe("");
	});

	it("should render masked value", () => {
		const input = new TextInputComponent({
			mask: true,
			initialValue: "secret",
		});
		const lines = input.render(40);
		expect(lines[0]).toContain("******");
		expect(lines[0]).not.toContain("secret");
	});

	it("should call onSubmit on Enter", () => {
		let submitted = "";
		const input = new TextInputComponent({
			onSubmit: (value) => { submitted = value; },
		});
		input.handleInput("a");
		input.handleInput("b");
		input.handleInput("c");
		input.handleInput("\r"); // Enter
		expect(submitted).toBe("abc");
	});

	it("should call onCancel on Esc", () => {
		let cancelled = false;
		const input = new TextInputComponent({
			onCancel: () => { cancelled = true; },
		});
		input.handleInput("\x1b"); // Esc
		expect(cancelled).toBe(true);
	});

	it("should render initial value", () => {
		const input = new TextInputComponent({ initialValue: "hello" });
		const lines = input.render(40);
		expect(lines[0]).toContain("hello");
	});

	it("should accept pasted multi-character input", () => {
		const input = new TextInputComponent();
		input.handleInput("sk-ant-api03-abcdef123456");
		expect(input.getValue()).toBe("sk-ant-api03-abcdef123456");
	});

	it("should ignore arrow key escape sequences", () => {
		const input = new TextInputComponent({ initialValue: "test" });
		input.handleInput("\x1b[A"); // Up arrow
		input.handleInput("\x1b[B"); // Down arrow
		expect(input.getValue()).toBe("test");
	});
});

describe("ConfigView", () => {
	const testConfig: CliclawConfig = {
		defaultAgent: "claude-code",
		debug: false,
		llm: {
			provider: "anthropic",
			model: "claude-sonnet-4-6",
		},
		context: {
			contextWindowLimit: 500000,
			compressionThreshold: 0.7,
		},
		stateDetector: {
			pollIntervalMs: 2000,
			stableThresholdMs: 10000,
			captureLines: 50,
		},
		tmux: {
			sessionPrefix: "cliclaw",
		},
		memory: {
			embeddingProvider: "auto",
			chunkTokens: 400,
			chunkOverlap: 50,
			vectorWeight: 0.7,
			minScore: 0.1,
			topK: 10,
			decayHalfLifeDays: 30,
			flushThreshold: 0.6,
			toolResultRetention: 20,
		},
		skills: {
			disabled: [],
		},
		learning: {
			enabled: false,
		},
	};

	it("should render all config items", () => {
		const view = new ConfigView(testConfig);
		const lines = view.render(60);
		const text = lines.join("\n");

		expect(text).toContain("Default Provider");
		expect(text).toContain("Model");
		expect(text).toContain("API Key");
		expect(text).toContain("Default Agent");
		expect(text).toContain("Base URL");
	});

	it("should show current config values", () => {
		const view = new ConfigView(testConfig);
		const lines = view.render(60);
		const text = lines.join("\n");

		expect(text).toContain("anthropic");
		expect(text).toContain("claude-sonnet-4-6");
		expect(text).toContain("claude-code");
	});

	it("should call onClose on Esc", () => {
		let closed = false;
		const view = new ConfigView(testConfig, {
			onClose: () => { closed = true; },
		});

		view.handleInput("\x1b"); // Esc
		expect(closed).toBe(true);
	});

	it("should show description for selected item", () => {
		const view = new ConfigView(testConfig);
		const lines = view.render(60);
		const text = lines.join("\n");

		// First item selected — should show its description
		expect(text).toContain("Configure the LLM provider for planning");
	});

	it("should open provider submenu on Enter", () => {
		const view = new ConfigView(testConfig);
		view.handleInput("\r"); // Enter on Default Provider

		const lines = view.render(60);
		const text = lines.join("\n");

		expect(text).toContain("Select Provider:");
		expect(text).toContain("OpenAI");
		expect(text).toContain("Anthropic");
	});

	it("should show hint text", () => {
		const view = new ConfigView(testConfig);
		const lines = view.render(60);
		const text = lines.join("\n");

		expect(text).toContain("Navigate");
		expect(text).toContain("Esc");
	});

	it("should show Learning Sessions item", () => {
		const view = new ConfigView(testConfig);
		const lines = view.render(60);
		const text = lines.join("\n");

		expect(text).toContain("Learning Sessions");
	});

	it("should cycle Learning Sessions ON/OFF", () => {
		let savedConfig: CliclawConfig | null = null;
		const view = new ConfigView(testConfig, {
			onSave: (cfg) => { savedConfig = cfg; },
		});

		// Navigate to Learning Sessions item (last item, index 6)
		for (let i = 0; i < 6; i++) view.handleInput("\x1b[B");
		view.handleInput("\r"); // Enter to cycle

		expect(savedConfig).not.toBeNull();
		expect(savedConfig!.learning.enabled).toBe(true);

		// Cycle again to turn off
		view.handleInput("\r");
		expect(savedConfig!.learning.enabled).toBe(false);
	});
});
