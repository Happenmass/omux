import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { TmuxBridge } from "../../src/tmux/bridge.js";

const bridge = new TmuxBridge();
let sessionCounter = 0;

function makeSessionName() {
	return `omux-test-${Date.now()}-${sessionCounter++}`;
}

describe("TmuxBridge", () => {
	let tmuxAvailable = false;
	const activeSessions: string[] = [];

	beforeAll(async () => {
		tmuxAvailable = await bridge.checkInstalled();
	});

	afterEach(async () => {
		for (const name of activeSessions) {
			try {
				await bridge.killSession(name);
			} catch {
				// Already killed or never created
			}
		}
		activeSessions.length = 0;
	});

	it("should check if tmux is installed", async () => {
		const installed = await bridge.checkInstalled();
		expect(typeof installed).toBe("boolean");
	});

	it("should get tmux version", async () => {
		if (!tmuxAvailable) return;
		const version = await bridge.getVersion();
		expect(version).toMatch(/tmux/i);
	});

	it("should create and destroy sessions", async () => {
		if (!tmuxAvailable) return;

		const name = makeSessionName();
		activeSessions.push(name);

		await bridge.createSession(name);
		const has = await bridge.hasSession(name);
		expect(has).toBe(true);

		const sessions = await bridge.listSessions();
		expect(sessions.some((s) => s.name === name)).toBe(true);

		await bridge.killSession(name);
		const hasAfter = await bridge.hasSession(name);
		expect(hasAfter).toBe(false);
	});

	it("should send keys and capture pane", async () => {
		if (!tmuxAvailable) return;

		const name = makeSessionName();
		activeSessions.push(name);

		await bridge.createSession(name);
		const target = `${name}:0.0`;

		// Send a command
		await bridge.sendKeys(target, "echo hello-omux-test", { literal: true });
		await bridge.sendEnter(target);

		// Wait for command to execute
		await new Promise((r) => setTimeout(r, 500));

		// Capture output
		const capture = await bridge.capturePane(target);
		expect(capture.content).toContain("hello-omux-test");
		expect(capture.lines.length).toBeGreaterThan(0);
		expect(capture.timestamp).toBeGreaterThan(0);
	});

	it("should build target strings correctly", () => {
		expect(TmuxBridge.target("sess")).toBe("sess");
		expect(TmuxBridge.target("sess", 0)).toBe("sess:0");
		expect(TmuxBridge.target("sess", 1, 2)).toBe("sess:1.2");
	});

	it("should list windows", async () => {
		if (!tmuxAvailable) return;

		const name = makeSessionName();
		activeSessions.push(name);

		await bridge.createSession(name);
		const windows = await bridge.listWindows(name);
		expect(windows.length).toBeGreaterThanOrEqual(1);
		expect(windows[0].index).toBe(0);
	});

	it("should list panes", async () => {
		if (!tmuxAvailable) return;

		const name = makeSessionName();
		activeSessions.push(name);

		await bridge.createSession(name);
		const panes = await bridge.listPanes(name);
		expect(panes.length).toBeGreaterThanOrEqual(1);
		expect(panes[0].width).toBeGreaterThan(0);
		expect(panes[0].height).toBeGreaterThan(0);
	});

	it("should list only omux sessions", async () => {
		if (!tmuxAvailable) return;

		const OmuxName = makeSessionName(); // starts with "omux-test-"
		const otherName = `other-session-${Date.now()}-${sessionCounter++}`;
		activeSessions.push(OmuxName, otherName);

		await bridge.createSession(OmuxName);
		await bridge.createSession(otherName);

		const OmuxAgents = await bridge.listOmuxAgents();
		expect(OmuxAgents.some((s) => s.name === OmuxName)).toBe(true);
		// The host may have unrelated live agents, but every listed session must
		// carry the omux- prefix or the legacy cliclaw- prefix.
		expect(OmuxAgents.every((s) => s.name.startsWith("omux-") || s.name.startsWith("cliclaw-"))).toBe(true);
		expect(OmuxAgents.some((s) => s.name === otherName)).toBe(false);
	});

	it("should also list legacy cliclaw-prefixed sessions", async () => {
		if (!tmuxAvailable) return;

		const legacyName = `cliclaw-test-${Date.now()}-${sessionCounter++}`;
		activeSessions.push(legacyName);

		await bridge.createSession(legacyName);

		const OmuxAgents = await bridge.listOmuxAgents();
		expect(OmuxAgents.some((s) => s.name === legacyName)).toBe(true);
	});
});
