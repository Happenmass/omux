<div align="center">

# omux

**Run your CLI coding agent unattended, in parallel, at scale.**

omux is a meta-agent that orchestrates the CLI coding agent of your choice — Claude Code, Codex, or anything else — through tmux. It spawns multiple instances, handles state and confirmations, remembers across sessions, and lets you walk away.

[![npm](https://img.shields.io/npm/v/%40happenmass%2Fomux.svg)](https://www.npmjs.com/package/@happenmass/omux)
[![license](https://img.shields.io/npm/l/%40happenmass%2Fomux.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/%40happenmass%2Fomux.svg)](https://nodejs.org)

[Website](https://www.omux.sh) · [Demo video](#demo) · [How it works](#how-it-works) · [Install](#install) · [FAQ](#faq)

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

So I built omux instead.

## What omux is

omux is a chat-driven meta-agent that runs *your* CLI coding agent for you — whichever one you've chosen.

You configure your tools of choice once via `omux config`: Claude Code, Codex, etc. — anything with a tmux-friendly CLI. The *orchestration mechanics* don't care which tool sits behind them: the MainAgent operates against a generic agent contract — spawn, send, confirm, await — implemented per tool as a thin adapter (a couple hundred lines).

When you assign work, omux spawns one or more instances of your configured tools in tmux panes. It reads those panes like a human reads a terminal — recognizing spinners, confirmation prompts, error messages, completion markers. It sends keystrokes back. When a pane goes idle, it evaluates the result and decides what to do next.

**Enable more than one agent and the MainAgent routes by fit.** It sees every adapter you've turned on and its strengths, then assigns each task to the agent best suited to it — **Codex** for gnarly single-point reasoning and deep debugging, **Claude Code** for broad multi-file edit→test→rerun loops — and hands the diff to the *other* one for an independent review pass. You don't pick the agent per task; you describe the work and let the loop choose, always within the toolset you turned on (it never reaches for one you didn't enable). Roles aren't hard-wired — either can implement, either can review.

That's the entire idea. Switching tools is a config change. Adding support for a new tool is one adapter file. The orchestration layer never changes.

A side benefit of this layered design: **you and the MainAgent can talk in one language while the coding agents get briefed in another.** omux is locale-aware end to end (chat UI, MainAgent replies, its housekeeping prompts), and the briefs the MainAgent writes to Claude Code or Codex are its own prose — so a one-line standing instruction like "always brief sub-agents in English" pins that channel to whatever language you want. The language you read is decoupled from the language the agents reason in.

## omux is a loop, not a prompt box

There's a name for the shift happening to coding agents this year — **loop engineering**, structured by Google's Addy Osmani after [Boris Cherny](https://addyosmani.com/blog/loop-engineering/) (who built Claude Code) and Peter Steinberger (OpenClaw) kept saying the same thing out loud:

> "I don't prompt Claude anymore. I have loops running that prompt Claude and figuring out what to do. My job is to write loops."
> — **Boris Cherny**, *Acquired Unplugged*, June 2026

> "You shouldn't be prompting coding agents anymore. You should be designing loops that prompt your agents."
> — **Peter Steinberger**

The idea: stop hand-prompting the agent turn by turn. Stand up a system that prompts it for you, iterates until the goal is *verifiably* met, and only comes back when it genuinely needs you. The human moves from prompter to **loop designer**.

**omux's MainAgent is that general loop, pre-built.** You talk to it in plain language; it writes the prompts to Claude Code / Codex, reads their panes, decides the next move, and keeps going until the success criteria are met. You don't write the loop in bash — omux *is* the loop.

Osmani names six primitives a loop-engineering setup needs. omux ships four of them outright and approximates the other two:

| Loop-engineering primitive | omux |
|---|---|
| **Sub-agents** — maker ≠ checker | ✓ Claude Code implements, **Codex independently reviews the diff** — different vendor, different model, in one session |
| **State / memory** — external, persistent | ✓ two-tier hybrid memory (global + project) + shared `tasks.txt` / `progress.txt` for cross-agent handoff |
| **Skills** — codified knowledge | ✓ SKILL.md frontmatter, conditional activation |
| **Connectors** — MCP | ✓ and *per-agent scoped*, not tool-soup |
| **Parallel isolation** — worktrees | ~ parallel agents in separate tmux panes / working dirs (process-level, not git-worktree-level) |
| **Automations** — scheduled triage | ~ self-continues once started (below); no cron triage yet |

Three pieces make the loop real:

- **Auto-continue gate (`/autocontinue`).** At every natural stopping point a gate model asks *is the goal actually met, or is there a next round?* — and either keeps the loop running or hands back to you, capped so it can't run away.
- **A loop-shaped system prompt.** The MainAgent prompt is written around a TDD loop where a failing test is a *continue* signal, not a stop, and independent work fans out to parallel sub-agents instead of blocking on one.
- **Push-based waiting.** While sub-agents grind, the MainAgent parks — zero LLM calls, zero tokens — until a pane settles and a callback wakes it. There is no polling loop quietly burning money while you're away.

Honest about the edges: omux gives you *one general* loop (the MainAgent) rather than asking you to script task-specific ones, and its parallel isolation is panes-and-working-dirs, not git worktrees. But the core bet — **you converse with a loop that prompts the coding agents, instead of prompting them yourself** — is exactly the transition Cherny is describing.

## Demo

[![omux demo — click to play](assets/cliclaw_demo_poster.png)](https://github.com/Happenmass/omux/raw/main/assets/cliclaw_demo.mp4)

> Click the thumbnail to play the demo (~70 MB MP4).

## How omux fits in

This is the honest landscape. omux is not the only thing in this space.

| | omux | Claude Code subagents | OpenHands | Cursor Composer |
|---|---|---|---|---|
| Run multiple agents in parallel | ✓ | limited | ✓ | partial |
| Tool-agnostic (Claude Code, Codex, aider, local…) | ✓ | Claude only | own runtime | own runtime |
| Use the agent's native TUI (see its reasoning live) | ✓ | ✓ | ✗ | ✗ |
| Drive confirmation prompts / interactive flows | ✓ | N/A (in-process) | — | — |
| Remote-friendly (SSH, tmux detach, resume later) | ✓ | ✓ | ✓ | ✗ |
| Persistent memory + skill system | ✓ | ✓ | ✓ | partial |
| Per-agent MCP scoping (no tool-soup bloat) | ✓ | ✗ | ✗ | ✗ |

<sub>Landscape snapshot as of mid-2026 — these tools move fast; corrections welcome.</sub>

omux is for you if: you already live inside a CLI coding agent, you want to run more than one instance at once, and you don't want to give up the rich TUI output by wrapping the agent in an API.

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
                   │ State detector      │   ← reads pane output, classifies as
                   │ active / waiting /  │     active / waiting / completed / error
                   │ completed / error   │     (per-agent regex, LLM for ambiguity)
                   └─────────────────────┘
```

The pieces worth talking about:

**State detection via pane scraping.** Each agent adapter declares four regex patterns — waiting-for-input, active-work, completion, error. The state detector polls the tmux pane at a modest rate, classifies what it sees, and emits events the MainAgent subscribes to. When the regexes are ambiguous — a quoted error in a still-working transcript, an unfamiliar prompt — a cheap LLM classification pass settles it, biased toward "still working" so a busy agent doesn't get interrupted by a false "done". No API hooks. No SDK. The agent doesn't know omux exists.

**Adapter abstraction.** Adding support for a new CLI agent is a thin adapter (a couple hundred lines): the four regex patterns, the launch command, the confirm/abort keystrokes. `src/agents/adapter.ts` is the contract.

**Hybrid memory, two-tier.** SQLite-backed store with two indexes — `sqlite-vec` for dense retrieval, `FTS5` for BM25, configurable weighted combination. Five embedding providers including a local `node-llama-cpp` path (Qwen3-Embedding) for fully-offline operation. Memory lives in two layers that are indexed and searched together: a **global** store (your coding style, your tone, your team's people, things that don't change when you switch repos) and a **per-project** store (this codebase's conventions, its architecture decisions, its open todos). The same editing, search, and `/tidy` machinery applies to both. Markdown files are the source of truth; the DB is the index. Killed sub-agents leave a resume id behind (persisted to memory), so a later session can revive their full conversation via `claude --resume` / `codex resume` instead of starting cold.

**Skill system.** Markdown files with frontmatter, discovered from two places: skills bundled with each adapter, and per-project `.omux/skills/`. A skill is loaded on demand via conditional activation — the MainAgent decides when a skill is relevant from its description, then reads the full instructions. Project-local skills are **opt-in by design** (`skills.trustedWorkspaceDirs` in config, default deny), so cloning a repo can never silently inject instructions into your orchestrator. Modeled after Claude's skills.

**Per-agent capability scoping.** Every sub-agent has its own MCP roster (per-agent skill scoping is on the way). Don't load every tool you've ever installed into every agent — give each one only what it needs. A backend agent gets the database MCP; a docs agent doesn't. The result: smaller system prompts, no tool-name collisions, and an LLM that isn't distracted by tools it'll never call. This is one of the harder problems to retrofit onto an existing agent stack — omux's adapter abstraction made it cheap.

**Token-cost engineering.** The MainAgent's own bill is kept deliberately thin. Context compaction rides the same prompt cache as regular turns instead of paying for a separate full-price summarization call; the mutable parts of the system prompt sit at the end so compaction never invalidates the cached prefix; the in-prompt memory snapshot is deliberately not hot-reloaded mid-session for the same reason. Details in [docs/prompt-cache-design-spec.md](docs/prompt-cache-design-spec.md).

**Learning sessions** *(experimental, off by default)*. When a sub-agent is killed, omux captures what it actually changed — a git diff against the launch-time baseline, dirty worktrees included — and generates a structured summary: what changed, why, key files, design decisions. Each entry gets an isolated chat so you can interrogate the change, and can be flushed into long-term memory. Enable with `learning.enabled` in config.

Code layout:

```
src/
├── core/          MainAgent, work queue, context manager, built-in tool handlers,
│                  learning pipeline (prompt tracker + change tracker + summarizer)
├── agents/        Adapter interface + Claude Code / Codex implementations
├── tmux/          Bridge (shells out to tmux CLI), state detector
├── llm/           Provider-agnostic client (12 providers, 3 wire protocols)
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

Install omux:

```bash
npm install -g @happenmass/omux

omux          # run in foreground, prints URL
# → open http://localhost:3120
```

Or run as a daemon:

```bash
omux start    # background
omux stop
omux restart
```

Logs: `~/.omux/logs/server.log` · Config: `~/.omux/config.json` · State: `~/.omux/server-state.json`. (An existing `~/.cliclaw` home from earlier releases keeps working — omux picks it up automatically, no migration needed.)

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

Or run `omux config` for an interactive TUI. Environment variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …) are read as fallbacks. To run Claude Code and Codex side by side, add `"enabledAgents": ["claude-code", "codex"]` — the MainAgent only ever launches adapters in that list.

Supported LLM providers: OpenAI, Anthropic, OpenRouter, DeepSeek, Gemini, Groq, Mistral, xAI (Grok), Together, Moonshot (Kimi), MiniMax, Ollama.

## Security & network exposure

By default omux binds `0.0.0.0` and advertises itself over mDNS/Bonjour, so you can open the UI from a phone or laptop on the same network. Auth is a pairing token: the startup URL carries a one-time `?token=` that sets a session cookie; the token rotates on every restart and is never included in the mDNS broadcast. Two things to know before relying on that:

- **Transport is plain HTTP.** On a shared or untrusted network the pairing URL and cookie are sniffable. For remote use, prefer an SSH tunnel (`ssh -L 3120:localhost:3120 <host>`) over exposing the port.
- **Local processes are trusted.** Connections from localhost skip the token entirely — anything running on the same machine can reach the API.

To lock it down: `omux --host 127.0.0.1 --no-mdns` binds loopback-only with no discovery broadcast (binding to `127.0.0.1` alone already disables mDNS advertising). And treat the machine running omux as trusted infrastructure — the MainAgent can read files and drive terminals on it by design.

## Chat commands

| Command | Effect |
|---|---|
| `/stop` | Interrupt the current task (continuation is handled by the auto-resume model) |
| `/autocontinue` | Toggle auto-continue — the loop self-continues at stop points until the goal is met (capped) |
| `/clear` · `/reset` | Clear conversation (reset also reloads prompts/skills) |
| `/compact` | Force-compress conversation history |
| `/context` | Show token usage for the current context |
| `/tidy` | Have an LLM review memory files, archive stale entries |

## Status & roadmap

**Today (v4.0.0):** works for me, daily, against Claude Code and Codex. Cross-vendor **execute-then-review** (Claude implements, Codex reviews), the **auto-continue loop**, and the loop-shaped MainAgent prompt landed in v3.0; v3.1–v3.2 hardened the execution loop (race fixes, tool-handler extraction) and realigned prompts with code. Memory + skills + hybrid search shipped. The web chat UI is the primary interface (a legacy TUI dashboard still runs). Not battle-tested against production team workflows yet.

**Next:**
- [ ] Per-agent skill scoping (MCP scoping already shipped)
- [ ] More agent adapters (aider, gemini-cli, open-interpreter)
- [ ] Slack / Discord bridge (drive omux from chat on your phone)
- [ ] Multi-user mode (teams sharing a single omux server)
- [ ] Richer execution evidence (surface test results, diffs, PR links in chat)
- [ ] Budget / rate-limit enforcement across agents

If you want something specific, open an issue — this is still a solo project and priorities are flexible.

## FAQ

**Does omux decide which CLI agent to use for a task?**
Within the adapters *you've enabled*, yes. The MainAgent sees every active adapter and its characteristics (listed under "Agent Capabilities" in its prompt) and picks per task by fit — lead with **Codex** for gnarly single-point reasoning and deep debugging, lean **Claude Code** for broad multi-file work and tight edit→test→rerun loops, then have the *other* one review (see the execute-then-review FAQ below). If you've enabled only one adapter there's nothing to choose — it just runs that. The menu is always exactly the adapters you turned on: it never silently pulls in a tool you didn't enable. Roles aren't hard-wired — either can implement, either can review; the implement/review split is a heuristic, not a fixed division of labor.

**Can I run Claude Code and Codex together?**
Yes — as of v3.0.0 it's a headline feature. Enable both adapters and omux runs an **execute-then-review loop** in a single session: Claude Code implements, then a *separate* Codex agent independently reviews the diff — correctness, edge cases, regressions — and routes fixes back. They stay distinct agents you address individually, and the roles are interchangeable: either can implement, either can review. The default heuristic is Claude-implements / Codex-reviews; you override per task. (Want two fully independent sessions instead? Run two omux instances on different ports.)

**Why scope MCPs per-agent instead of globally?**
Because tool-soup hurts. Every MCP you load injects its tool descriptions into the system prompt of every agent that has it enabled. A docs agent doesn't need your Postgres MCP, and the LLM gets distracted by tools it'll never call. omux lets you give each agent a focused toolset — smaller prompts, faster decisions, no name collisions. Per-agent skill scoping is on the way next.

**Why two-tier memory (global + project)?**
Some things you teach an agent are about *you* — your coding style, your tone, your colleagues' names. Re-teaching that every time you `cd` into a new repo is wasteful. Other things are about *this codebase* — its conventions, its open todos, its architectural quirks — and shouldn't bleed into unrelated projects. omux splits memory into both layers and searches them together. Both run on the same hybrid-search index and the same editing tools, so the experience is identical at either level.

**Can I change the context window size?**
You usually don't have to — omux derives the window from the model id (claude → 200k, gemini / gpt-4.1 → 1M, 500k fallback for unrecognized models). To override: `--context-window` at launch, or `context.contextWindowLimit` in `~/.omux/config.json`. omux watches usage and auto-compresses (or flushes to memory) when you cross the threshold, so you can match the window to your model and budget without babysitting it.

**Why tmux and not the Anthropic SDK / OpenAI Assistants API?**
Because the experience of Claude Code or Codex is not in their API — it's in their TUI. The interactive confirmations, the step-by-step reasoning, the "here's what I'm about to do" preview — all of that is TUI output. Wrapping the API strips it. Driving the TUI keeps it, and as a bonus you get compatibility with any CLI agent that ever ships.

**How does state detection work across agents that update their UI differently?**
Each adapter declares its own regex patterns. When Claude Code 2026.04 changes its prompt format, you edit one file. The core orchestrator doesn't know or care.

**Does omux need its own API key?**
Yes — one, for the MainAgent's reasoning. The coding agents use whatever keys they already use. You pay twice in tokens but the MainAgent's traffic is much smaller than the coding agents'.

**Can I chat in one language while the agents work in another?**
Yes. omux auto-detects your locale (or you can set `locale` in `~/.omux/config.json` — `zh-CN` and `en-US` are supported today) and uses it for the chat UI and the MainAgent's replies to you. The briefs the MainAgent writes *into* the coding agents are a separate, steerable channel: tell it once to brief sub-agents in English and it will — so you can read and write in Chinese while Claude Code or Codex gets briefed in English (or any combination). Useful if you think faster in your native language but want the coding agent's reasoning trace to stay in the language its training data is densest in.

**Can I run this on a remote server?**
Yes. tmux is designed for detached sessions. SSH in, start omux, detach, come back hours later, pick up where you left off. This is actually the main mode I use it in.

**Can I grab the wheel while an agent is mid-run?**
Yes. Any agent pane can be taken over from the web UI: you get the live terminal, your keystrokes go straight in, and the MainAgent keeps its hands off that agent until you release it back. For lighter touches, `/stop` halts the MainAgent between rounds — and it can itself interrupt a sub-agent it catches going off-track.

**What happens if the omux server dies mid-task?**
Less than you'd fear. Sub-agents live in tmux, not in the server process — they keep working right through a server crash or restart. On startup omux re-adopts running `omux-*` (and legacy `cliclaw-*`) sessions, restores the conversation from SQLite, and repairs any tool call that was interrupted mid-flight.

**Why "omux"?**
**o**rchestrate × t**mux** — the orchestrator that lives where your agents live. (omux is the new name of cliclaw.)

## Credits & license

Built by [@happenmass](https://github.com/Happenmass). MIT.

Architectural nods to the Claude Code team for setting the bar that made omux worth building.