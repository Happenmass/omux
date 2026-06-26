# Auto-Continue Mode Implementation Plan

> **For agentic workers:** Use `spec-forge:executing-plans` to implement this
> plan — it runs one fresh subagent per task via a Workflow, routing each task to
> a model matched to its complexity (or `superpowers:subagent-driven-development`
> if the Superpowers plugin is installed). Steps use checkbox (`- [ ]`) syntax for
> tracking.

**Goal:** Add an opt-in "auto-continue" mode where, when the MainAgent's loop naturally finishes and would hand back to the user, a single separate LLM gate decides (from the last output + sub-agent state) whether to keep going — re-driving the loop with a synthesized instruction or returning control to the user.

**Architecture:** A new `maybeAutoContinue()` method on `MainAgent` runs at the three text-only "natural completion" return-to-idle sites. It short-circuits unless the mode is on; otherwise it calls `llmClient.complete()` with a new file-based gate prompt, parses `{continue, reason, driverText}`, and on continue enqueues `driverText` via the existing `WorkQueue` (so the existing `dispatchNext` re-drives the loop). A consecutive-continue counter (reset by any real user message) is the loop-guard. Toggled by `/autocontinue`, defaulted by `config.autoContinue`.

**Tech Stack:** TypeScript (ESM, Node16, strict), Vitest, Biome. Spec: [auto-continue-mode-spec.md](../../auto-continue-mode-spec.md). Mirrors the existing JSON-gate pattern in `src/core/learning-summarizer.ts` (`prompts.resolve` + `llm.complete({responseFormat:"json"})` + 2-attempt retry).

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `src/utils/config.ts` | Config schema + defaults | Task 1: `AutoContinueConfig`, field, default, merge |
| `src/llm/prompt-loader.ts` | Prompt registry | Task 2: register `"auto-continue"` |
| `prompts/auto-continue.md` | The gate prompt | Task 2: create |
| `src/core/main-agent.ts` | Gate logic + hooks | Task 3: fields, accessors, `maybeAutoContinue`, parse helper, 3 hook sites, counter reset, imports |
| `src/main.ts` | Bootstrap wiring | Task 4: pass `promptLoader`/`locale`/`autoContinue` |
| `src/server/command-router.ts` | Slash commands | Task 5: `/autocontinue` toggle |
| `CLAUDE.md` | Architecture doc | Tasks 1 & 5: config + command notes |
| `test/utils/config.test.ts` · `test/llm/auto-continue-prompt.test.ts` · `test/core/auto-continue.test.ts` · `test/server/command-router.test.ts` | Tests | per task |

**Note on lint:** the repo has pre-existing whole-repo Biome debt, so every lint step below is **scoped to the file(s) the task changed** (`npx biome check <file>`), never `npm run check`.

---

## Task 1: Config — `AutoContinueConfig`

**Files:**
- Modify: `src/utils/config.ts:65-68` (add interface near `LearningConfig`), `:107` (field), `:163-165` (default), `:207` (merge)
- Modify: `CLAUDE.md` (config section)
- Test: `test/utils/config.test.ts`

- [ ] **Step 1: Write the failing test**

Append this block inside `test/utils/config.test.ts` (it reuses the file's `loadConfig`/`saveConfig` imports; it backs up and restores the real `~/.cliclaw/config.json` like the existing `mcpServers` block):

```typescript
describe("autoContinue config", () => {
	const configDir = join(homedir(), ".cliclaw");
	const configFile = join(configDir, "config.json");
	let saved: string | null = null;

	beforeEach(async () => {
		saved = existsSync(configFile) ? await readFile(configFile, "utf-8") : null;
	});
	afterEach(async () => {
		if (saved !== null) await writeFile(configFile, saved, "utf-8");
		else if (existsSync(configFile)) await rm(configFile);
	});

	it("defaults autoContinue to disabled with a maxConsecutive cap", async () => {
		await mkdir(configDir, { recursive: true });
		await writeFile(configFile, JSON.stringify({ debug: false }), "utf-8");
		const config = await loadConfig();
		expect(config.autoContinue).toEqual({ enabled: false, maxConsecutive: 10 });
	});

	it("merges a partial autoContinue over the defaults", async () => {
		await mkdir(configDir, { recursive: true });
		await writeFile(configFile, JSON.stringify({ autoContinue: { enabled: true } }), "utf-8");
		const config = await loadConfig();
		expect(config.autoContinue).toEqual({ enabled: true, maxConsecutive: 10 });
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/utils/config.test.ts -t "autoContinue config"`
Expected: FAIL — `config.autoContinue` is `undefined` (field not defined yet).

- [ ] **Step 3: Add the interface**

In `src/utils/config.ts`, immediately after the `LearningConfig` interface (ends at `:68`), add:

```typescript
export interface AutoContinueConfig {
	/** When true, after the loop naturally finishes a gate LLM decides whether to keep going. Default false. */
	enabled: boolean;
	/** Max consecutive auto-continues before forcing a hand-back to the user. Default 10. */
	maxConsecutive: number;
}
```

- [ ] **Step 4: Add the field, default, and merge**

In `src/utils/config.ts`, add the field to `CliclawConfig` right after the `learning: LearningConfig;` line (`:107`):

```typescript
	autoContinue: AutoContinueConfig;
```

Add the default to `DEFAULT_CONFIG` right after the `learning: { enabled: false },` block (`:165`):

```typescript
	autoContinue: {
		enabled: false,
		maxConsecutive: 10,
	},
```

Add the merge line in `loadConfig` right after the `learning: { ...DEFAULT_CONFIG.learning, ...userConfig.learning },` line (`:207`):

```typescript
			autoContinue: { ...DEFAULT_CONFIG.autoContinue, ...userConfig.autoContinue },
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/utils/config.test.ts -t "autoContinue config"`
Expected: PASS (both cases).

- [ ] **Step 6: Document the config**

In `CLAUDE.md`, in the `config.memory.*` / Config section, add a line under the config options list:

```markdown
`config.autoContinue.*`:
- `enabled` — auto-continue mode (default `false`). When on, a gate LLM decides at loop-exit whether to keep going.
- `maxConsecutive` — consecutive auto-continues before forced hand-back (default 10).
```

- [ ] **Step 7: Build, lint, commit**

Run: `npm run build && npx biome check src/utils/config.ts && npx vitest run test/utils/config.test.ts`
Expected: build OK; Biome clean on `config.ts`; all config tests PASS.

```bash
git add src/utils/config.ts CLAUDE.md test/utils/config.test.ts
git commit -m "feat(config): add autoContinue config (enabled + maxConsecutive)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: PromptLoader registration + gate prompt file

**Files:**
- Modify: `src/llm/prompt-loader.ts:7-18` (`PromptName`), `:20-32` (`PROMPT_FILE_MAP`)
- Create: `prompts/auto-continue.md`
- Test: `test/llm/auto-continue-prompt.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/llm/auto-continue-prompt.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { PromptLoader } from "../../src/llm/prompt-loader.js";

describe("auto-continue gate prompt", () => {
	it("loads and interpolates last_output / agent_status / language_instruction", async () => {
		const loader = new PromptLoader();
		await loader.load();
		const out = loader.resolve("auto-continue", {
			language_instruction: "LANG_SENTINEL",
			last_output: "OUTPUT_SENTINEL",
			agent_status: "STATUS_SENTINEL",
		});
		expect(out).toContain("OUTPUT_SENTINEL");
		expect(out).toContain("STATUS_SENTINEL");
		expect(out).toContain("LANG_SENTINEL");
		expect(out).toContain("driverText");
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/llm/auto-continue-prompt.test.ts`
Expected: FAIL — `resolve("auto-continue", …)` returns `""` (the name is not registered / no file), so none of the sentinels are present.

- [ ] **Step 3: Register the prompt name**

In `src/llm/prompt-loader.ts`, add `"auto-continue"` to the `PromptName` union (after `"learning-memory"` on `:18`):

```typescript
	| "learning-memory"
	| "auto-continue";
```

And add the file mapping to `PROMPT_FILE_MAP` (after the `"learning-memory": "learning-memory.md",` entry on `:31`):

```typescript
	"auto-continue": "auto-continue.md",
```

- [ ] **Step 4: Create the gate prompt**

Create `prompts/auto-continue.md`:

```markdown
You are the auto-continue gate for Cliclaw's Main Agent. The Main Agent has just finished a turn and is about to hand control back to the user. Your only job: decide whether the overall task is actually finished, or whether the Main Agent should keep working autonomously.

{{language_instruction}}

You are given the Main Agent's final message for this turn and a snapshot of its sub-agents.

=== MAIN AGENT'S FINAL OUTPUT ===
{{last_output}}

=== SUB-AGENT STATUS ===
{{agent_status}}

Decide:
- continue = true ONLY IF the original task is clearly NOT finished AND there is a concrete, safe next action the Main Agent can take right now without new information from the user. Typical cases: it announced a next step but stopped before doing it; a sub-agent finished but its work has not been verified yet; the success criteria are not met.
- continue = false if: the success criteria appear met; the message is a normal conversational reply; it is a question or decision that genuinely needs the user; or a sub-agent is waiting_input (the Main Agent should respond to it, not be re-driven).

If continue = true, write driverText: a short, direct instruction — phrased as if the user wrote it — telling the Main Agent exactly what to do next toward the goal. It is fed back to the Main Agent verbatim as the next user message.

Respond with ONLY a JSON object — no prose, no code fences:
{"continue": true_or_false, "reason": "<one short sentence>", "driverText": "<next instruction, or empty string when continue is false>"}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/llm/auto-continue-prompt.test.ts`
Expected: PASS — the resolved prompt contains all three sentinels and the literal `driverText`.

- [ ] **Step 6: Build, lint, commit**

Run: `npm run build && npx biome check src/llm/prompt-loader.ts && npx vitest run test/llm/auto-continue-prompt.test.ts`
Expected: build OK; Biome clean; test PASS.

```bash
git add src/llm/prompt-loader.ts prompts/auto-continue.md test/llm/auto-continue-prompt.test.ts
git commit -m "feat(prompts): add auto-continue gate prompt + register it in PromptLoader

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: MainAgent — gate method, hooks, counter

**Risk:** concurrency — adds a gate + feedback hook into the core EXECUTING→idle loop; an over-broad hook or a missing short-circuit could spuriously re-drive the loop or interfere with `wait_for_agents` parking / `/stop`.

**Files:**
- Modify: `src/core/main-agent.ts` — imports (top), fields (`~:395-405`), constructor opts/assignments (`:422-467`), accessors (after constructor), `handleMessage` (`:698`), `maybeAutoContinue` + parse helper (new), and the three hook sites (`:885`, `:948`, `:982`)
- Test: `test/core/auto-continue.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/core/auto-continue.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MainAgent } from "../../src/core/main-agent.js";

function createAgent(opts: { enabled?: boolean; max?: number } = {}) {
	const broadcaster = { broadcast: vi.fn(), addClient: vi.fn(), removeClient: vi.fn(), getClientCount: vi.fn() } as any;
	const complete = vi.fn();
	const llmClient = { complete } as any;
	const promptLoader = { resolve: vi.fn().mockReturnValue("GATE PROMPT") } as any;
	const signalRouter = {
		notifyPromptSent: vi.fn(), on: vi.fn(), emit: vi.fn(),
		isStopRequested: vi.fn().mockReturnValue(false),
	} as any;
	const agent = new MainAgent({
		contextManager: {
			addMessage: vi.fn(), getMessages: vi.fn().mockReturnValue([]),
			getCurrentTokenEstimate: vi.fn().mockReturnValue(0),
			getContextWindowLimit: vi.fn().mockReturnValue(200000),
			setCompactTuning: vi.fn(),
		} as any,
		signalRouter,
		llmClient,
		adapter: { getCharacteristics: vi.fn().mockReturnValue({}) } as any,
		bridge: { capturePane: vi.fn() } as any,
		createAgentSettleMs: 0,
		stateDetector: { onStateChange: vi.fn() } as any,
		broadcaster,
		promptLoader,
		autoContinue: { enabled: opts.enabled ?? false, maxConsecutive: opts.max ?? 10 },
	});
	return { agent, broadcaster, complete, signalRouter };
}

function gateResponse(decision: object) {
	return { content: JSON.stringify(decision), usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, stopReason: "end_turn", model: "test" };
}

const run = (agent: MainAgent, text = "done for now") => (agent as any).maybeAutoContinue(text);
const queueSize = (agent: MainAgent) => (agent as any).workQueue.size();

describe("maybeAutoContinue", () => {
	it("returns false and makes no LLM call when the mode is disabled", async () => {
		const { agent, complete } = createAgent({ enabled: false });
		expect(await run(agent)).toBe(false);
		expect(complete).not.toHaveBeenCalled();
		expect(queueSize(agent)).toBe(0);
	});

	it("continues: enqueues driverText, increments the counter, broadcasts", async () => {
		const { agent, complete, broadcaster } = createAgent({ enabled: true });
		complete.mockResolvedValue(gateResponse({ continue: true, reason: "tests not run", driverText: "Run the test suite" }));
		expect(await run(agent)).toBe(true);
		expect((agent as any).autoContinueCount).toBe(1);
		expect(queueSize(agent)).toBe(1);
		expect((agent as any).workQueue.dequeue()).toEqual({ kind: "user_message", content: "Run the test suite" });
		expect(broadcaster.broadcast).toHaveBeenCalledWith(
			expect.objectContaining({ type: "system", message: expect.stringContaining("自动继续 (1/") }),
		);
	});

	it("stops when the gate says continue:false", async () => {
		const { agent, complete } = createAgent({ enabled: true });
		complete.mockResolvedValue(gateResponse({ continue: false, reason: "done", driverText: "" }));
		expect(await run(agent)).toBe(false);
		expect(queueSize(agent)).toBe(0);
	});

	it("treats continue:true with empty driverText as stop", async () => {
		const { agent, complete } = createAgent({ enabled: true });
		complete.mockResolvedValue(gateResponse({ continue: true, reason: "x", driverText: "   " }));
		expect(await run(agent)).toBe(false);
		expect(queueSize(agent)).toBe(0);
	});

	it("does not call the gate once the consecutive cap is reached", async () => {
		const { agent, complete } = createAgent({ enabled: true, max: 3 });
		(agent as any).autoContinueCount = 3;
		expect(await run(agent)).toBe(false);
		expect(complete).not.toHaveBeenCalled();
	});

	it("does not run when a stop was requested", async () => {
		const { agent, complete, signalRouter } = createAgent({ enabled: true });
		signalRouter.isStopRequested.mockReturnValue(true);
		expect(await run(agent)).toBe(false);
		expect(complete).not.toHaveBeenCalled();
	});

	it("defers when a real user message is already queued", async () => {
		const { agent, complete } = createAgent({ enabled: true });
		(agent as any).workQueue.enqueueUserMessage("user typed something");
		expect(await run(agent)).toBe(false);
		expect(complete).not.toHaveBeenCalled();
	});

	it("fails safe (false) when the gate returns non-JSON twice", async () => {
		const { agent, complete } = createAgent({ enabled: true });
		complete.mockResolvedValue({ content: "not json", usage: {}, stopReason: "end_turn", model: "test" });
		expect(await run(agent)).toBe(false);
		expect(complete).toHaveBeenCalledTimes(2);
		expect(queueSize(agent)).toBe(0);
	});

	it("handleMessage resets the consecutive counter", async () => {
		const { agent } = createAgent({ enabled: true });
		(agent as any).state = "executing"; // makes handleMessage enqueue+return without dispatching
		(agent as any).autoContinueCount = 5;
		await agent.handleMessage("hi");
		expect((agent as any).autoContinueCount).toBe(0);
	});

	it("setAutoContinueEnabled / isAutoContinueEnabled toggle the flag", () => {
		const { agent } = createAgent({ enabled: false });
		expect(agent.isAutoContinueEnabled()).toBe(false);
		expect(agent.setAutoContinueEnabled(true)).toBe(true);
		expect(agent.isAutoContinueEnabled()).toBe(true);
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/core/auto-continue.test.ts`
Expected: FAIL — `maybeAutoContinue`, `autoContinueCount`, `setAutoContinueEnabled`, and the `autoContinue` constructor option do not exist yet (TypeError / undefined). (Vitest runs without typechecking, so missing members surface at runtime.)

- [ ] **Step 3: Add imports**

At the top of `src/core/main-agent.ts`, add these imports alongside the existing ones (place near the other `../llm` / `../utils` imports):

```typescript
import type { PromptLoader } from "../llm/prompt-loader.js";
import { type SupportedLocale, getLanguageInstruction } from "../utils/locale.js";
```

- [ ] **Step 4: Add fields**

In `src/core/main-agent.ts`, add these fields near the other private fields (e.g. right after `private createAgentSettleMs: number;`):

```typescript
	private promptLoader: PromptLoader | null = null;
	private locale: SupportedLocale = "en-US";
	private autoContinueEnabled = false;
	private autoContinueMax = 10;
	private autoContinueCount = 0;
```

- [ ] **Step 5: Add constructor options and assignments**

In the constructor opts object (`:422-444`), add after `createAgentSettleMs?: number;`:

```typescript
		promptLoader?: PromptLoader;
		locale?: SupportedLocale;
		autoContinue?: { enabled: boolean; maxConsecutive: number };
```

In the assignment block (after `this.createAgentSettleMs = opts.createAgentSettleMs ?? 10_000;` on `:467`), add:

```typescript
		this.promptLoader = opts.promptLoader ?? null;
		this.locale = opts.locale ?? "en-US";
		this.autoContinueEnabled = opts.autoContinue?.enabled ?? false;
		this.autoContinueMax = opts.autoContinue?.maxConsecutive ?? 10;
```

- [ ] **Step 6: Add the accessors**

In `src/core/main-agent.ts`, right after the constructor's closing brace (after `:482`), add:

```typescript
	/** Toggle auto-continue mode at runtime (used by the /autocontinue command). Returns the new state. */
	setAutoContinueEnabled(on: boolean): boolean {
		this.autoContinueEnabled = on;
		return this.autoContinueEnabled;
	}

	isAutoContinueEnabled(): boolean {
		return this.autoContinueEnabled;
	}
```

- [ ] **Step 7: Reset the counter in `handleMessage`**

In `src/core/main-agent.ts`, make `this.autoContinueCount = 0;` the first line of `handleMessage` (`:698`), before the enqueue:

```typescript
	async handleMessage(content: string): Promise<void> {
		// A real user message ends any auto-continue streak.
		this.autoContinueCount = 0;
		this.workQueue.enqueueUserMessage(content);
```

- [ ] **Step 8: Add `maybeAutoContinue` + the parse helper**

In `src/core/main-agent.ts`, add these two methods (place them just before `private recoverFromExecutionError`, near the dispatch/loop code):

```typescript
	/**
	 * Auto-continue gate. Called at natural-completion return-to-idle sites. When the mode is on
	 * and no other actor is taking over, a single separate LLM call decides whether the task is
	 * actually done. On "continue" it enqueues a synthesized driver message (re-driving the loop
	 * via dispatchNext) and returns true; otherwise returns false (caller hands back to the user).
	 * The caller calls setState("idle") regardless — a true result just means a queued message
	 * will immediately re-drive it.
	 */
	private async maybeAutoContinue(lastText: string): Promise<boolean> {
		if (!this.autoContinueEnabled) return false;
		if (!this.promptLoader) return false;
		if (this.signalRouter.isStopRequested()) return false;
		if (this.workQueue.pendingUserMessages() > 0) return false; // a real user message is waiting — defer
		if (this.autoContinueCount >= this.autoContinueMax) {
			this.broadcaster.broadcast({ type: "system", message: "已达自动继续上限，交还控制权" });
			return false;
		}

		const tasks = this.agentMonitor?.getAllTasks() ?? [];
		const pending = this.workQueue.getAgentEvents();
		const statusLines: string[] = [];
		for (const t of tasks) {
			const elapsed = Math.round((Date.now() - t.startedAt) / 1000);
			statusLines.push(`- ${t.agentId} (${t.taskId}) status=${t.status} elapsed=${elapsed}s — ${t.summary}`);
		}
		for (const e of pending) {
			statusLines.push(`- ${e.agentId} (${e.taskId}) reported=${e.status} — ${e.summary}`);
		}
		const agentStatus = statusLines.length > 0 ? statusLines.join("\n") : "(no active sub-agents)";

		const prompt = this.promptLoader.resolve("auto-continue", {
			language_instruction: getLanguageInstruction(this.locale),
			last_output: lastText || "(the agent produced no text this turn)",
			agent_status: agentStatus,
		});

		let decision: { continue: boolean; reason: string; driverText: string } | null = null;
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				const res = await this.llmClient.complete([{ role: "user", content: prompt }], {
					responseFormat: "json",
					temperature: 0.2,
				});
				decision = this.parseAutoContinueDecision(res.content);
				break;
			} catch (err: any) {
				logger.warn("main-agent", `auto-continue gate parse attempt ${attempt + 1} failed: ${err.message}`);
			}
		}

		if (!decision || !decision.continue || decision.driverText.trim() === "") {
			return false;
		}

		this.autoContinueCount++;
		this.broadcaster.broadcast({
			type: "system",
			message: `🔄 自动继续 (${this.autoContinueCount}/${this.autoContinueMax}): ${decision.reason}`,
		});
		this.workQueue.enqueueUserMessage(decision.driverText);
		return true;
	}

	private parseAutoContinueDecision(text: string): { continue: boolean; reason: string; driverText: string } {
		const stripped = text
			.replace(/^```(?:json)?\s*/, "")
			.replace(/\s*```\s*$/, "")
			.trim();
		const parsed = JSON.parse(stripped);
		if (typeof parsed.continue !== "boolean") {
			throw new Error("auto-continue decision missing 'continue' boolean");
		}
		return {
			continue: parsed.continue,
			reason: typeof parsed.reason === "string" ? parsed.reason : "",
			driverText: typeof parsed.driverText === "string" ? parsed.driverText : "",
		};
	}
```

- [ ] **Step 9: Hook the three natural-completion sites**

In `src/core/main-agent.ts`, in `executeToolLoop` (the `nextToolCalls.length === 0` branch, `:879-886`), insert the gate call immediately before `this.setState("idle");`:

```typescript
			if (nextToolCalls.length === 0) {
				// No more tool calls — add text response and back to IDLE
				if (textContent) {
					this.contextManager.addMessage({ role: "assistant", content: textContent });
				}
				this.broadcastAssistantDone();
				await this.maybeAutoContinue(textContent);
				this.setState("idle");
				return;
			}
```

In `processUserMessage` (the pure-text `else` branch, `:944-948`):

```typescript
		} else {
			// Pure text response — return to IDLE
			this.contextManager.addMessage({ role: "assistant", content: textContent });
			this.broadcastAssistantDone();
			await this.maybeAutoContinue(textContent);
			this.setState("idle");
		}
```

In `processAgentEventItem` (the pure-text/empty `else` branch, `:976-982`):

```typescript
		} else {
			if (textContent) {
				this.contextManager.addMessage({ role: "assistant", content: textContent });
				this.broadcastAssistantDone();
			}
			// Pure text / empty response — return to IDLE
			await this.maybeAutoContinue(textContent);
			this.setState("idle");
		}
```

Do **not** modify the terminal-tool idle path (`:847-849`) or the stopRequested idle path (`:855-863`).

- [ ] **Step 10: Run the tests to verify they pass**

Run: `npx vitest run test/core/auto-continue.test.ts`
Expected: PASS (all 10 cases).

- [ ] **Step 11: Build, lint, regression**

Run: `npm run build && npx biome check src/core/main-agent.ts && npx vitest run test/core/`
Expected: build OK; `main-agent.ts` reports only the pre-existing warnings (top-of-file unused imports, unused `formatSignal`) — **no new errors**; all `test/core/` tests PASS.

- [ ] **Step 12: Commit**

```bash
git add src/core/main-agent.ts test/core/auto-continue.test.ts
git commit -m "feat(main-agent): auto-continue gate at natural loop-exit

When enabled, a single gate LLM decides at the text-only return-to-idle sites
whether to keep going; on continue it enqueues a synthesized driver message to
re-drive the loop, else hands back to the user. Guarded by a consecutive cap
reset on real user messages; skips stop/parking/terminal paths.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Wire config + promptLoader + locale into MainAgent

**Files:**
- Modify: `src/main.ts:789-806` (the `new MainAgent({ … })` options)

- [ ] **Step 1: Add the three options at the construction site**

In `src/main.ts`, in the `const mainAgent = new MainAgent({ … })` object (starts `:789`), add these three lines alongside the existing options (e.g. right after `thinking: config.llm.thinking ?? "off",` on `:806`). `promptLoader` (`:583`), `locale` (in scope, used at `:678`), and `config.autoContinue` (Task 1) are all already available here:

```typescript
		promptLoader,
		locale,
		autoContinue: config.autoContinue,
```

- [ ] **Step 2: Build to verify the wiring type-checks**

Run: `npm run build`
Expected: PASS — the constructor accepts `promptLoader` / `locale` / `autoContinue` (added in Task 3); no type errors.

- [ ] **Step 3: Verify the options are present**

Run: `grep -n "promptLoader,\|locale,\|autoContinue: config.autoContinue" src/main.ts`
Expected: shows the three new lines inside the MainAgent construction.

- [ ] **Step 4: Commit**

```bash
git add src/main.ts
git commit -m "feat(main): wire promptLoader, locale, and autoContinue config into MainAgent

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: `/autocontinue` slash command

**Files:**
- Modify: `src/server/command-router.ts:16-22` (`BUILTIN_COMMANDS`), `:40` (doc comment), `:87-99` (switch), new `handleAutoContinue` method
- Modify: `CLAUDE.md` (command list)
- Test: `test/server/command-router.test.ts`

- [ ] **Step 1: Write the failing test**

In `test/server/command-router.test.ts`, extend `createMockMainAgent` so it carries a toggleable flag (replace the existing factory at `:5-11`):

```typescript
function createMockMainAgent(state: "idle" | "executing" = "idle") {
	let autoContinue = false;
	return {
		state,
		handleMessage: vi.fn().mockResolvedValue(undefined),
		waitForIdle: vi.fn().mockResolvedValue(undefined),
		isAutoContinueEnabled: vi.fn(() => autoContinue),
		setAutoContinueEnabled: vi.fn((on: boolean) => {
			autoContinue = on;
			return autoContinue;
		}),
	} as any;
}
```

Then add this describe block (anywhere inside the top-level `describe("CommandRouter", …)`):

```typescript
	describe("/autocontinue", () => {
		it("toggles auto-continue on from off and reports it", async () => {
			setup("idle");
			await commandRouter.handle("autocontinue");
			expect(mockAgent.setAutoContinueEnabled).toHaveBeenCalledWith(true);
			expect(mockBroadcaster.broadcast).toHaveBeenCalledWith(
				expect.objectContaining({ type: "system", message: expect.stringContaining("已开启") }),
			);
		});

		it("toggles auto-continue off when already on", async () => {
			setup("idle");
			mockAgent.setAutoContinueEnabled(true); // pre-enable
			await commandRouter.handle("autocontinue");
			expect(mockAgent.setAutoContinueEnabled).toHaveBeenLastCalledWith(false);
			expect(mockBroadcaster.broadcast).toHaveBeenCalledWith(
				expect.objectContaining({ type: "system", message: expect.stringContaining("已关闭") }),
			);
		});
	});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/server/command-router.test.ts -t "/autocontinue"`
Expected: FAIL — `/autocontinue` hits the `default` branch ("未知指令"), so `setAutoContinueEnabled` is never called.

- [ ] **Step 3: Register the command descriptor**

In `src/server/command-router.ts`, add to `BUILTIN_COMMANDS` (after the `tidy` entry on `:22`):

```typescript
	{ name: "autocontinue", description: "切换 auto-continue 自动续跑模式", category: "builtin" },
```

- [ ] **Step 4: Add the switch case and handler**

In `src/server/command-router.ts`, add a case to `handle()` (after `case "tidy":` on `:98`):

```typescript
			case "autocontinue":
				return this.handleAutoContinue();
```

Add the handler method (e.g. after `handleStop`):

```typescript
	private handleAutoContinue(): void {
		const on = this.mainAgent.setAutoContinueEnabled(!this.mainAgent.isAutoContinueEnabled());
		this.broadcaster.broadcast({
			type: "system",
			message: `auto-continue 已${on ? "开启" : "关闭"}`,
		});
	}
```

- [ ] **Step 5: Update the doc comment**

In `src/server/command-router.ts`, the class doc comment at `:40` lists the handled commands. Add `/autocontinue`:

```typescript
 * Routes slash commands (/stop, /clear, /reset, /compact, /context, /tidy, /autocontinue) to the
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run test/server/command-router.test.ts -t "/autocontinue"`
Expected: PASS (both cases).

- [ ] **Step 7: Update CLAUDE.md command list**

In `CLAUDE.md`, in the `command-router.ts` description, add `/autocontinue` to the handled-commands list:

```markdown
- `command-router.ts` — **`CommandRouter`** ... Handled slash commands: **`/stop`, `/clear`, `/reset`, `/compact`, `/context`, `/tidy`, `/autocontinue`**.
```

- [ ] **Step 8: Build, lint, commit**

Run: `npm run build && npx biome check src/server/command-router.ts && npx vitest run test/server/command-router.test.ts`
Expected: build OK; Biome clean on `command-router.ts`; all command-router tests PASS.

```bash
git add src/server/command-router.ts CLAUDE.md test/server/command-router.test.ts
git commit -m "feat(commands): add /autocontinue toggle for auto-continue mode

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final verification

- [ ] **Step 1: Full build + test sweep**

Run: `npm run build && npm test`
Expected: build OK; entire Vitest suite PASS.

- [ ] **Step 2: Lint (scoped to changed files)**

Run: `npx biome check src/utils/config.ts src/llm/prompt-loader.ts src/core/main-agent.ts src/main.ts src/server/command-router.ts`
Expected: clean except the pre-existing `main-agent.ts` warnings (top-of-file unused imports, unused `formatSignal`). Do **not** run whole-repo `npm run check` — the repo has unrelated pre-existing Biome debt.

- [ ] **Step 3: Confirm spec acceptance criteria**

- Mode off → `maybeAutoContinue` returns false, no `complete` call, queue unchanged.
- Mode on + gate continue → enqueues driverText, counter→1, `自动继续 (1/` broadcast.
- Mode on + gate exit / empty driverText → false, queue empty.
- Cap reached / stop requested / pending user message → no gate call.
- `handleMessage` resets the counter.
- Gate non-JSON twice → false (fail safe).
- `/autocontinue` toggles the flag and reports the new state.

---

## Notes

- **Spec deviation (documented):** the spec mentioned a `.cn.md` variant for the gate prompt; the actual `PromptLoader` does **not** do `.cn.md` switching (`PROMPT_FILE_MAP` is fixed `.md`). The repo idiom for JSON-gate prompts (see `learning-summarizer`) is a **single** file with a `{{language_instruction}}` variable, which this plan follows. Localization comes from `getLanguageInstruction(this.locale)`.
- The gate is a separate `llmClient.complete()` (no tool surface), mirroring `learning-summarizer` — it does not ride the main turn's prompt cache. This is intentional and matches the spec's Data/State section.
- Suggested release tag for this feature: **v2.3.6** (bundle with the earlier tool-cleanup). Version bump is **not** part of this plan.
- Out of scope: a web-UI toggle for the mode (command + config only), and firing the gate on pure-chat turns is accepted (the gate returns `continue:false` quickly; the mode is opt-in).
