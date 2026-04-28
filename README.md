<div align="center">

# cliclaw

**Run your CLI coding agent unattended, in parallel, at scale.**

cliclaw is a meta-agent that orchestrates the CLI coding agent of your choice — Claude Code, Codex, or anything else — through tmux. It spawns multiple instances, handles state and confirmations, remembers across sessions, and lets you walk away.

[![npm](https://img.shields.io/npm/v/@happenmass/cliclaw.svg)](https://www.npmjs.com/package/@happenmass/cliclaw)
[![license](https://img.shields.io/npm/l/@happenmass/cliclaw.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/@happenmass/cliclaw.svg)](https://nodejs.org)

[Demo video](#demo) · [How it works](#how-it-works) · [Install](#install) · [FAQ](#faq)

</div>

---

## The problem

Claude Code and Codex are great at writing code. They are less great at the parts around writing code:

- You can't walk away. They pause on every destructive action, ask you to confirm, ask you to pick between two approaches.
- You can run one at a time per task. Want one agent on the backend, another on the frontend? You open two terminals and babysit both.
- They don't coordinate. Finishing a task, running tests, filing a PR, posting in Slack — that's your job, again, by hand.
- They don't learn across sessions. Every run starts fresh.
- Every agent sees every tool. Once you've installed 6 MCPs, every agent — even one writing docs — pays for the system-prompt bloat and risks tripping over tool name collisions.

I tried solving this with the Anthropic SDK and a bash script. It didn't work. The CLI agents have rich TUIs — step-by-step reasoning, interactive confirmations, live progress — and wrapping the API throws all of that away.

So I built cliclaw instead.

## What cliclaw is

cliclaw is a chat-driven meta-agent that runs *your* CLI coding agent for you — whichever one you've chosen.

You configure your tool of choice once via `cliclaw config`: Claude Code, Codex, aider, a local Qwen-Coder, anything with a tmux-friendly CLI. **The MainAgent doesn't know or care which one.** It operates against a generic agent contract — spawn, send, confirm, await — implemented per tool as a thin adapter (a couple hundred lines).

When you assign work, cliclaw spawns one or more instances of your configured tool in tmux panes. It reads those panes like a human reads a terminal — recognizing spinners, confirmation prompts, error messages, completion markers. It sends keystrokes back. When a pane goes idle, it evaluates the result and decides what to do next.

That's the entire idea. Switching tools is a config change. Adding support for a new tool is one adapter file. The orchestration layer never changes.

A side benefit of this layered design: **you and the MainAgent can talk in one language while the MainAgent talks to the coding agents in another.** Chat with the MainAgent in Chinese; have it brief Claude Code or Codex in English (or vice versa). cliclaw injects per-locale instructions into the prompts crossing each boundary, so the language you read is independent of the language the agents reason in.

## Demo

<video src="https://github.com/Happenmass/Cliclaw/raw/main/assets/cliclaw_demo.mp4" controls width="720">
  Your browser does not support embedded video. <a href="https://github.com/Happenmass/Cliclaw/raw/main/assets/cliclaw_demo.mp4">Download the demo MP4</a>.
</video>

## A real example

> _To be added._

## How cliclaw fits in

This is the honest landscape. cliclaw is not the only thing in this space.

| | cliclaw | Claude Code subagents | OpenHands | Cursor Composer |
|---|---|---|---|---|
| Run multiple agents in parallel | ✓ | limited | ✓ | partial |
| Tool-agnostic (Claude Code, Codex, aider, local…) | ✓ | Claude only | own runtime | own runtime |
| Use the agent's native TUI (see its reasoning live) | ✓ | ✓ | ✗ | ✗ |
| Drive confirmation prompts / interactive flows | ✓ | N/A (in-process) | — | — |
| Remote-friendly (SSH, tmux detach, resume later) | ✓ | ✓ | ✓ | ✗ |
| Persistent memory + skill system | ✓ | ✓ | ✓ | partial |
| Per-agent MCP scoping (no tool-soup bloat) | ✓ | ✗ | ✗ | ✗ |

cliclaw is for you if: you already live inside a CLI coding agent, you want to run more than one instance at once, and you don't want to give up the rich TUI output by wrapping the agent in an API.

## How it works

```
  ┌───────────────────────────────────────────────────────┐
  │  Web chat UI  ⇄  WebSocket  ⇄  MainAgent  ⇄  LLM      │
  └───────────────────────────────────────────────────────┘
                              │
                              ▼
                        tmux session
                     ┌────────┬────────┐
                     │ pane A │ pane B │   ← coding agents live here
                     │ Claude │ Codex  │     (Claude Code, Codex, …)
                     │ Code   │        │
                     └────────┴────────┘
                              │
                              ▼
                   ┌─────────────────────┐
                   │ State detector      │   ← reads pane output, classifies
                   │ idle / working /    │     as idle / working / waiting
                   │ waiting / error     │     using per-agent regex patterns
                   └─────────────────────┘
```

The four pieces worth talking about:

**State detection via pane scraping.** Each agent adapter declares four regex patterns — waiting-for-input, active-work, completion, error. The state detector polls the tmux pane at a modest rate, classifies what it sees, and emits events the MainAgent subscribes to. No API hooks. No SDK. The agent doesn't know cliclaw exists.

**Adapter abstraction.** Adding support for a new CLI agent is a thin adapter (a couple hundred lines): the four regex patterns, the launch command, the confirm/abort keystrokes. `src/agents/adapter.ts` is the contract.

**Hybrid memory, two-tier.** SQLite-backed store with two indexes — `sqlite-vec` for dense retrieval, `FTS5` for BM25, configurable weighted combination. Five embedding providers including a local `node-llama-cpp` path (Qwen3-Embedding) for fully-offline operation. Memory lives in two layers that are indexed and searched together: a **global** store (your coding style, your tone, your team's people, things that don't change when you switch repos) and a **per-project** store (this codebase's conventions, its architecture decisions, its open todos). The same editing, search, and `/tidy` machinery applies to both. Markdown files are the source of truth; the DB is the index.

**Skill system.** Markdown files with frontmatter under `skills/`. A skill is loaded on demand via conditional activation — the MainAgent decides when a skill is relevant from its description, then reads the full instructions. Modeled after Claude's skills.

**Per-agent capability scoping.** Every sub-agent has its own MCP roster (per-agent skill scoping is on the way). Don't load every tool you've ever installed into every agent — give each one only what it needs. A backend agent gets the database MCP; a docs agent doesn't. The result: smaller system prompts, no tool-name collisions, and an LLM that isn't distracted by tools it'll never call. This is one of the harder problems to retrofit onto an existing agent stack — cliclaw's adapter abstraction made it cheap.

Code layout:

```
src/
├── core/          MainAgent, signal router, work queue, context manager,
│                  learning pipeline (prompt tracker + change tracker + summarizer)
├── agents/        Adapter interface + Claude Code / Codex implementations
├── tmux/          Bridge (shells out to tmux CLI), state detector
├── llm/           Provider-agnostic client (12 providers)
├── memory/        sqlite-vec + FTS5 hybrid search, embedder, chunker
├── skills/        Parser, registry, injector, filter
├── tui/           Dashboard + agent preview (custom diff renderer)
├── server/        Express + WebSocket + auth
└── persistence/   Agent & conversation stores (SQLite)
```

## Install

Requires **Node 20+** and **tmux**.

```bash
# macOS
brew install tmux

# Ubuntu/Debian
sudo apt install tmux
```

Install cliclaw:

```bash
npm install -g @happenmass/cliclaw

cliclaw          # run in foreground, prints URL
# → open http://localhost:3120
```

Or run as a daemon:

```bash
cliclaw start    # background
cliclaw stop
cliclaw restart
```

Logs: `~/.cliclaw/logs/server.log` · Config: `~/.cliclaw/config.json` · State: `~/.cliclaw/server-state.json`.

## Configure

Minimum config:

```json
{
  "defaultAgent": "claude-code",
  "llm": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-6",
    "apiKey": "sk-..."
  }
}
```

Or run `cliclaw config` for an interactive TUI. Environment variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …) are read as fallbacks.

Supported LLM providers: OpenAI, Anthropic, OpenRouter, DeepSeek, Gemini, Groq, Mistral, xAI (Grok), Together, Moonshot (Kimi), MiniMax, Ollama.

## Chat commands

| Command | Effect |
|---|---|
| `/stop` · `/resume` | Interrupt or resume the current task |
| `/clear` · `/reset` | Clear conversation (reset also reloads prompts/skills) |
| `/compact` | Force-compress conversation history |
| `/context` | Show token usage for the current context |
| `/tidy` | Have an LLM review memory files, archive stale entries |

## Status & roadmap

**Today (v2.2.4):** works for me, daily, against Claude Code and Codex. Memory + skills + hybrid search shipped. TUI dashboard works. Not battle-tested against production team workflows yet.

**Next:**
- [ ] Per-agent skill scoping (MCP scoping already shipped)
- [ ] More agent adapters (aider, gemini-cli, open-interpreter)
- [ ] Slack / Discord bridge (drive cliclaw from chat on your phone)
- [ ] Multi-user mode (teams sharing a single cliclaw server)
- [ ] Richer execution evidence (surface test results, diffs, PR links in chat)
- [ ] Budget / rate-limit enforcement across agents

If you want something specific, open an issue — this is still a solo project and priorities are flexible.

## FAQ

**Does cliclaw decide which CLI agent to use for a task?**
No. You configure your CLI tool of choice once (`cliclaw config`, or `--agent` at launch). The MainAgent spawns and orchestrates instances of that tool — it doesn't second-guess your choice, and it has no idea whether it's talking to Claude Code, Codex, or aider. The contract is the same. We chose this over auto-routing because cost and determinism matter more than the convenience of automated tool selection.

**Can I run Claude Code and Codex simultaneously?**
Not in one cliclaw session — a session uses your one configured tool. If you want both, run two cliclaw instances on different ports. (Mixed-tool sessions are on the roadmap, but the design intent is "your tool of choice, in parallel" — not auto-routing across vendors.)

**Why scope MCPs per-agent instead of globally?**
Because tool-soup hurts. Every MCP you load injects its tool descriptions into the system prompt of every agent that has it enabled. A docs agent doesn't need your Postgres MCP, and the LLM gets distracted by tools it'll never call. cliclaw lets you give each agent a focused toolset — smaller prompts, faster decisions, no name collisions. Per-agent skill scoping is on the way next.

**Why two-tier memory (global + project)?**
Some things you teach an agent are about *you* — your coding style, your tone, your colleagues' names. Re-teaching that every time you `cd` into a new repo is wasteful. Other things are about *this codebase* — its conventions, its open todos, its architectural quirks — and shouldn't bleed into unrelated projects. cliclaw splits memory into both layers and searches them together. Both run on the same hybrid-search index and the same editing tools, so the experience is identical at either level.

**Can I change the context window size?**
Yes — `--context-window` at launch, or `contextWindow` in `~/.cliclaw/config.json`. cliclaw watches usage and auto-compresses (or flushes to memory) when you cross the threshold, so you can match the window to your model and budget without babysitting it.

**Why tmux and not the Anthropic SDK / OpenAI Assistants API?**
Because the experience of Claude Code or Codex is not in their API — it's in their TUI. The interactive confirmations, the step-by-step reasoning, the "here's what I'm about to do" preview — all of that is TUI output. Wrapping the API strips it. Driving the TUI keeps it, and as a bonus you get compatibility with any CLI agent that ever ships.

**How does state detection work across agents that update their UI differently?**
Each adapter declares its own regex patterns. When Claude Code 2026.04 changes its prompt format, you edit one file. The core orchestrator doesn't know or care.

**Does cliclaw need its own API key?**
Yes — one, for the MainAgent's reasoning. The coding agents use whatever keys they already use. You pay twice in tokens but the MainAgent's traffic is much smaller than the coding agents'.

**Can I chat in one language while the agents work in another?**
Yes. cliclaw auto-detects your locale (or you can set `locale` in `~/.cliclaw/config.json` — `zh-CN` and `en-US` are supported today) and uses it for the chat UI and the MainAgent's replies to you. The instructions cliclaw sends *into* the coding agents are a separate channel — so you can read and write in Chinese while Claude Code or Codex still gets briefed in English (or any combination). Useful if you think faster in your native language but want the coding agent's reasoning trace to stay in the language its training data is densest in.

**Can I run this on a remote server?**
Yes. tmux is designed for detached sessions. SSH in, start cliclaw, detach, come back hours later, pick up where you left off. This is actually the main mode I use it in.

**Is "cliclaw" a word?**
"CLI" + "claw" — what a meta-agent uses to grab CLI agents by the scruff.

## Credits & license

Built by [@happenmass](https://github.com/Happenmass). MIT.

Architectural nods to [openspec](https://github.com/Fission-AI/OpenSpec) for the spec-driven workflow and to the Claude Code team for setting the bar that made cliclaw worth building.