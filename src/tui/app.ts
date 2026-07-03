import type { MainAgent } from "../core/main-agent.js";
import type { TmuxBridge } from "../tmux/bridge.js";
import { loadConfig, saveConfig } from "../utils/config.js";
import { TUIRenderer } from "./components/renderer.js";
import { ConfigView } from "./config-view.js";
import { Dashboard } from "./dashboard.js";

export class AppTUI {
	private renderer: TUIRenderer;
	private dashboard: Dashboard;
	private mainAgent: MainAgent;
	private refreshTimer: ReturnType<typeof setInterval> | null = null;
	private configOverlayActive = false;
	private configView: ConfigView | null = null;

	constructor(mainAgent: MainAgent, _bridge: TmuxBridge) {
		this.renderer = new TUIRenderer();
		this.dashboard = new Dashboard();
		this.mainAgent = mainAgent;

		this.renderer.setRoot(this.dashboard);

		this.setupEventListeners();
		this.setupInputHandler();
	}

	start(): void {
		this.renderer.start();

		// Refresh agent preview periodically
		this.refreshTimer = setInterval(() => {
			this.refreshAgentPreview();
			this.renderer.requestRender();
		}, 2000);
	}

	stop(): void {
		if (this.refreshTimer) {
			clearInterval(this.refreshTimer);
			this.refreshTimer = null;
		}
		this.renderer.stop();
	}

	private setupEventListeners(): void {
		this.mainAgent.on("state_change", (state) => {
			this.dashboard.addLog(`State: ${state}`, "info");
			this.renderer.requestRender();
		});

		this.mainAgent.on("log", (message) => {
			this.dashboard.addLog(message);
			this.renderer.requestRender();
		});
	}

	private setupInputHandler(): void {
		this.renderer.setInputHandler((data: string) => {
			// If config overlay is active, delegate to config view
			if (this.configOverlayActive && this.configView) {
				this.configView.handleInput(data);
				this.renderer.requestRender();
				return;
			}

			switch (data) {
				case "q":
					this.mainAgent.requestStop();
					this.stop();
					process.exit(0);
					break;

				case "p":
					if (this.mainAgent.isStopRequested()) {
						this.mainAgent.clearStopRequest();
						this.dashboard.addLog("Resumed");
					} else {
						this.mainAgent.requestStop();
						this.dashboard.addLog("Stopped");
					}
					this.renderer.requestRender();
					break;

				case "c":
					this.openConfigOverlay();
					break;

				case "s":
					// TODO: Open steer input
					this.dashboard.addLog("Steer mode not yet implemented", "warn");
					this.renderer.requestRender();
					break;

				case "\t": // Tab
					// TODO: Switch to tmux agent view
					this.dashboard.addLog("Agent view switch not yet implemented", "warn");
					this.renderer.requestRender();
					break;
			}
		});
	}

	private async openConfigOverlay(): Promise<void> {
		const config = await loadConfig();
		this.configView = new ConfigView(config, {
			onSave: async (updatedConfig) => {
				await saveConfig(updatedConfig);
				this.dashboard.addLog("Configuration saved");
			},
			onClose: () => {
				this.closeConfigOverlay();
			},
		});
		this.configOverlayActive = true;
		this.renderer.setRoot(this.configView);
		this.renderer.requestRender();
	}

	private closeConfigOverlay(): void {
		this.configOverlayActive = false;
		this.configView = null;
		this.renderer.setRoot(this.dashboard);
		this.renderer.requestRender();
	}

	private async refreshAgentPreview(): Promise<void> {
		// TODO: Capture active agent pane and update preview
	}
}
