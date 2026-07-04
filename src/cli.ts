import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8"));
export const VERSION: string = pkg.version;

export interface CLIArgs {
	subcommand: string | undefined;
	isInit: boolean;
	agent: string | undefined;
	provider: string | undefined;
	model: string | undefined;
	baseUrl: string | undefined;
	contextWindow: number | undefined;
	host: string;
	port: number;
	mdns: boolean | undefined;
	mdnsName: string | undefined;
	listProviders: boolean;
	help: boolean;
	version: boolean;
	cwd: string;
	rememberText: string | undefined;
	global: boolean;
}

export function parseCliArgs(): CLIArgs {
	const { values, positionals } = parseArgs({
		args: process.argv.slice(2),
		allowPositionals: true,
		options: {
			agent: { type: "string", short: "a" },
			provider: { type: "string", short: "p" },
			model: { type: "string", short: "m" },
			"base-url": { type: "string" },
			"context-window": { type: "string" },
			host: { type: "string", default: "0.0.0.0" },
			port: { type: "string", default: "3120" },
			mdns: { type: "boolean" },
			"no-mdns": { type: "boolean" },
			"mdns-name": { type: "string" },
			"list-providers": { type: "boolean", default: false },
			help: { type: "boolean", short: "h", default: false },
			version: { type: "boolean", short: "v", default: false },
			cwd: { type: "string", default: process.cwd() },
			global: { type: "boolean", short: "g", default: false },
		},
	});

	// Handle subcommands
	const subcommand = positionals[0];
	const isRemember = subcommand === "remember";
	const isInit = subcommand === "init";
	const rememberText = isRemember ? positionals.slice(1).join(" ") || undefined : undefined;

	return {
		subcommand: isRemember || isInit ? subcommand : subcommand,
		isInit,
		agent: values.agent as string | undefined,
		provider: values.provider as string | undefined,
		model: values.model as string | undefined,
		baseUrl: values["base-url"] as string | undefined,
		contextWindow: values["context-window"] ? Number.parseInt(values["context-window"] as string, 10) : undefined,
		host: values.host as string,
		port: Number.parseInt(values.port as string, 10) || 3120,
		mdns: values["no-mdns"] ? false : (values.mdns as boolean | undefined),
		mdnsName: values["mdns-name"] as string | undefined,
		listProviders: values["list-providers"] as boolean,
		help: values.help as boolean,
		version: values.version as boolean,
		cwd: values.cwd as string,
		rememberText,
		global: values.global as boolean,
	};
}

export function printHelp(): void {
	console.log(`
Omux - Chat-based meta-orchestrator for coding agents

Usage:
  omux [options]              Start the chat server in foreground (default)
  omux serve [options]        Start the chat server in foreground explicitly
  omux start [options]        Start the chat server in background
  omux stop                   Stop the background server
  omux restart [options]      Restart the background server

Subcommands:
  serve                   Start the chat server in foreground (default behavior)
  start                   Start the chat server in background (daemon mode)
  stop                    Stop the background server
  restart                 Restart the background server (stop + start)
  init                    Initialize project-level skills and prompts directories
  remember <text>         Save a note to persistent memory (MEMORY.md) for future sessions
                          Use --global/-g to save to global memory instead of project memory
  config                  Open configuration TUI
  doctor                  Run health checks on the CLI environment

Options:
  -a, --agent <name>      Coding agent to use: claude-code, codex (default: from config)
                          Options: claude-code, codex, pi
  -p, --provider <name>   LLM provider for planning/analysis (default: from config)
                          Built-in: openai, anthropic, openrouter, moonshot, minimax,
                                    deepseek, groq, together, xai, gemini, mistral, ollama
  -m, --model <id>        LLM model ID (default: provider's default)
  --base-url <url>        Custom API base URL (for self-hosted or custom endpoints)
  --context-window <n>    Context window size in tokens (default: 500000)
                          Match this to the model's actual context limit
  --host <host>           Bind address for the HTTP/WebSocket server (default: 0.0.0.0)
  --port <number>         Server port (default: 3120)
  --mdns-name <name>      mDNS hostname (default: omux → omux.local)
  --no-mdns               Disable mDNS / Bonjour advertising
  --list-providers        List all available LLM providers
  --cwd <path>            Working directory (default: current)
  -h, --help              Show this help
  -v, --version           Show version

Examples:
  omux                                            # Start foreground server on default port
  omux start                                      # Start background server
  omux stop                                       # Stop background server
  omux --host 127.0.0.1 --no-mdns                 # Localhost only, no mDNS broadcast
  omux --mdns-name happen                         # Reachable as http://happen.local:3120
  omux --port 8080                                # Start server on port 8080
  omux -p openai -m gpt-5.4                        # Start with specific LLM
  omux remember "This project uses PostgreSQL"    # Save a memory note

Environment variables:
  ANTHROPIC_API_KEY       Anthropic API key
  OPENAI_API_KEY          OpenAI API key
  OPENROUTER_API_KEY      OpenRouter API key
  MOONSHOT_API_KEY        Moonshot (Kimi) API key
  MINIMAX_API_KEY         MiniMax API key
  DEEPSEEK_API_KEY        DeepSeek API key
  GROQ_API_KEY            Groq API key
  XAI_API_KEY             xAI (Grok) API key
  GEMINI_API_KEY          Google Gemini API key
  MISTRAL_API_KEY         Mistral API key
`);
}

export function printVersion(): void {
	console.log(`omux v${VERSION}`);
}
