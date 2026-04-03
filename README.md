# Cliclaw

Chat-based meta-orchestrator that commands coding agents (like Claude Code) via tmux to accomplish complex development tasks.

Cliclaw runs as a persistent server with a web chat UI. You chat with the MainAgent naturally — it can answer questions, discuss code, and when you assign a development task, it autonomously commands coding agents in tmux sessions to get the work done, streaming progress updates back to you in real-time.

## Core Features

- **Natural chat + autonomous execution** — Talk naturally or assign complex dev tasks, the agent decides when to act
- **Multi-agent orchestration** — Create, manage, and kill multiple coding agents simultaneously in tmux sessions
- **Hybrid memory system** — Vector + keyword search over persistent Markdown memory files with auto-indexing
- **Memory editing** — Append, overwrite, search-and-replace, and delete operations on memory files
- **Memory tidy** — LLM-powered `/tidy` command reviews memory files and archives outdated entries
- **Context management** — Automatic compression and memory flush when context window fills up
- **Conversation persistence** — SQLite-backed chat history survives server restarts
- **Skill system** — Extensible capabilities via Markdown skill files with conditional activation
- **Human takeover** — Take direct control of an agent session from the web UI
- **Execution evidence** — Track what agents changed (files, tests, memory writes) with structured events
- **12 LLM providers** — OpenAI, Anthropic, DeepSeek, Gemini, Groq, Mistral, xAI, Ollama, and more

## Prerequisites

- **Node.js** >= 20.0.0
- **tmux** installed and available in PATH

```bash
# macOS
brew install tmux

# Ubuntu/Debian
sudo apt install tmux
```

## Quick Start

```bash
# Clone and install
git clone <repo-url>
cd cliclaw
npm install
npm run build

# Start the server (default port 3120)
cliclaw

# Open the chat UI
open http://localhost:3120
```

### Background Mode

```bash
cliclaw start           # Start in background (daemon)
cliclaw stop            # Stop background server
cliclaw restart         # Restart
```

Logs at `~/.cliclaw/logs/server.log`, runtime state at `~/.cliclaw/server-state.json`.

## How It Works

```
You (Browser) <--> WebSocket <--> MainAgent <--> LLM (streaming)
                                      |
                                 tmux sessions
                                      |
                              Coding Agents (Claude Code, Codex)
```

1. You send a message through the chat UI
2. MainAgent streams it to the LLM for analysis
3. For simple questions, it responds directly (stays **IDLE**)
4. For tasks, it enters **EXECUTING** state and uses tools to create agents, send instructions, and monitor progress
5. Summary updates stream back to your chat in real-time
6. When done, it calls `mark_complete` and returns to **IDLE**

## Chat Commands

| Command | Description |
|---------|-------------|
| `/stop` | Stop the current task execution |
| `/resume` | Resume after `/stop` |
| `/clear` | Clear conversation history (runs memory flush first) |
| `/reset` | Reset: clear conversation + reload prompts and skills |
| `/compact` | Force compress conversation history |
| `/context` | Show context token usage |
| `/tidy` | LLM reviews memory files, archives outdated entries |

## Memory System

Dual-storage architecture: **Markdown files** are the source of truth, **SQLite** is the search index.

### Memory Files

| File | Purpose |
|------|---------|
| `memory/core.md` | Architecture decisions, project conventions |
| `memory/preferences.md` | User preferences, coding style |
| `memory/people.md` | Team members, roles |
| `memory/todos.md` | Action items, pending tasks |
| `memory/YYYY-MM-DD.md` | Daily logs, archived entries |

### Search

Hybrid search combining vector KNN (sqlite-vec) and keyword BM25 (FTS5) with configurable weights. Supports 6 embedding providers with auto-detection fallback:

- **Remote**: OpenAI, Gemini, Voyage, Mistral
- **Local**: Qwen3-Embedding via node-llama-cpp
- **Fallback**: FTS-only mode when no provider available

### Editing

The `memory_edit` tool supports four modes:
- **append** — Add content to file (default)
- **overwrite** — Replace entire file
- **replace** — Find exact text and replace it
- **delete** — Find exact text and remove it

## Agent Tools

| Tool | Description |
|------|-------------|
| `send_to_agent` | Send instruction to a coding agent |
| `respond_to_agent` | Reply to agent waiting for input |
| `inspect_agent` | Capture agent pane content |
| `create_agent` / `list_agents` / `kill_agent` | Agent lifecycle |
| `memory_search` / `memory_get` / `memory_edit` | Memory operations |
| `exec_command` | Read-only bash for reconnaissance |
| `read_skill` | Load full skill instructions |
| `mark_complete` / `mark_failed` / `escalate_to_human` | Task completion |

## CLI

```
cliclaw [options]              Start the chat server (default: foreground)
cliclaw start [options]        Start in background (daemon)
cliclaw stop                   Stop background server
cliclaw restart                Restart background server
cliclaw init                   Initialize project skills/prompts
cliclaw remember <text>        Save a note to memory
cliclaw config                 Open configuration TUI
cliclaw doctor                 Run health checks

Options:
  -a, --agent <name>      Coding agent (default: claude-code)
  -p, --provider <name>   LLM provider
  -m, --model <id>        LLM model ID
  --base-url <url>        Custom API base URL
  --host <host>           Bind address (default: 127.0.0.1)
  --port <number>         Server port (default: 3120)
  --context-window <n>    Context window size (default: 500000)
  --list-providers        List all available LLM providers
  --cwd <path>            Working directory
```

## Configuration

Config at `~/.cliclaw/config.json`. Edit directly or use `cliclaw config`.

```json
{
  "defaultAgent": "claude-code",
  "llm": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-6",
    "apiKey": "sk-..."
  },
  "memory": {
    "embeddingProvider": "auto",
    "flushThreshold": 0.6,
    "vectorWeight": 0.7,
    "decayHalfLifeDays": 30
  }
}
```

## Supported LLM Providers

| Provider | Models | Env Variable |
|----------|--------|-------------|
| OpenAI | gpt-5.4, gpt-5.2, gpt-4.1, o3, o3-pro, o4-mini | `OPENAI_API_KEY` |
| Anthropic | claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5 | `ANTHROPIC_API_KEY` |
| OpenRouter | Multi-provider aggregator (default: openai/gpt-5.4) | `OPENROUTER_API_KEY` |
| DeepSeek | deepseek-chat, deepseek-reasoner | `DEEPSEEK_API_KEY` |
| Google Gemini | gemini-2.5-flash, gemini-3-flash-preview, gemini-3.1-pro-preview | `GEMINI_API_KEY` |
| Groq | llama-3.3-70b, llama-4-scout, qwen3-32b | `GROQ_API_KEY` |
| Mistral | mistral-large-latest, codestral-latest, magistral-medium-latest | `MISTRAL_API_KEY` |
| xAI (Grok) | grok-4-1-fast-reasoning, grok-4, grok-3 | `XAI_API_KEY` |
| Together AI | Llama 4 Scout | `TOGETHER_API_KEY` |
| Moonshot (Kimi) | kimi-k2.5, kimi-k2-thinking | `MOONSHOT_API_KEY` |
| MiniMax | MiniMax-M2.5, MiniMax-M2.1 | `MINIMAX_API_KEY` |
| Ollama (Local) | llama4 (local models) | — |

## Development

```bash
npm run build          # tsc — compile to dist/
npm run dev            # tsc --watch
npm test               # vitest run — all tests
npm run test:watch     # vitest — watch mode
npm run check          # biome check src/
npm run format         # biome format --write src/
```

## License

MIT
