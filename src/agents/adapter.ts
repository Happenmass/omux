import type { TmuxBridge } from "../tmux/bridge.js";

export interface ExitAgentResult {
	/** Captured tmux pane content after exit */
	content: string;
	/** Extracted resume id for --resume, if available */
	resumeId?: string;
}

export interface LaunchOptions {
	workingDir: string;
	sessionName: string;
	windowName?: string;
	env?: Record<string, string>;
	/** Resume id for --resume, obtained from kill_agent */
	resumeId?: string;
	/** Model to pass via --model. When omitted, the adapter applies its own default. */
	model?: string;
	/** Pre-commands to run before the agent launch command, joined with && */
	preCommands?: string[];
	/** Path to a temporary MCP config JSON file to pass via --mcp-config */
	mcpConfigPath?: string;
}

export interface AgentCharacteristics {
	/** Patterns indicating the agent is waiting for user input */
	waitingPatterns: RegExp[];
	/** Patterns indicating the agent has completed its task */
	completionPatterns: RegExp[];
	/** Patterns indicating an error occurred */
	errorPatterns: RegExp[];
	/** Patterns indicating the agent is actively working (spinners, progress) */
	activePatterns: RegExp[];
}

export interface AgentAdapter {
	/** Agent identifier */
	readonly name: string;

	/** Human-readable display name */
	readonly displayName: string;

	/** Model used when LaunchOptions.model is omitted (e.g. "opus", "gpt-5.5") */
	readonly defaultModel: string;

	/**
	 * Launch the agent in a tmux pane.
	 * Returns the tmux pane target string (e.g., "omux:0.0").
	 */
	launch(bridge: TmuxBridge, opts: LaunchOptions): Promise<string>;

	/**
	 * Send a task prompt to the agent.
	 * Handles long text via paste-buffer if needed.
	 */
	sendPrompt(bridge: TmuxBridge, paneTarget: string, prompt: string): Promise<void>;

	/**
	 * Send a response to an agent that's waiting for input.
	 * Used for confirmation prompts, follow-up questions, etc.
	 */
	sendResponse(bridge: TmuxBridge, paneTarget: string, response: string): Promise<void>;

	/** Abort the current operation */
	abort(bridge: TmuxBridge, paneTarget: string): Promise<void>;

	/** Gracefully shut down the agent. Optional — called after all tasks complete. */
	shutdown?(bridge: TmuxBridge, paneTarget: string): Promise<void>;

	/** Get agent-specific characteristics for state detection */
	getCharacteristics(): AgentCharacteristics;

	/** Return the absolute path to this adapter's bundled skills directory */
	getSkillsDir?(): string;

	/** Return the relative path to the adapter's capabilities file under prompts/ (e.g. "adapters/claude-code.md") */
	getCapabilitiesFile?(): string;

	/** Exit the agent process and return captured output with optional session id */
	exitAgent?(bridge: TmuxBridge, paneTarget: string): Promise<ExitAgentResult>;
}
