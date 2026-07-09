import { homedir } from "node:os";
import { basename, join } from "node:path";
import { readPersistentMemory } from "../../memory/persistent.js";
import { t } from "../../server/messages.js";
import { loadConfig, projectDotDir } from "../../utils/config.js";
import {
	addWorktree,
	deleteBranch,
	ensureExcluded,
	hasUnmergedCommits,
	isGitRepo,
	isWorktreeDirty,
	removeWorktree,
	repoRoot,
} from "../../utils/git.js";
import { logger } from "../../utils/logger.js";
import { cleanupMcpConfigFile, generateMcpConfigFile, selectMcpServers } from "../../utils/mcp-config.js";
import type { ToolContext, ToolHandler } from "./types.js";

function generateAgentName(prefix: string): string {
	const slug = prefix
		.replace(/[^\w\u4e00-\u9fff]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 30)
		.replace(/-$/, "");
	return `omux-${slug || "agent"}`;
}

export const sendToAgent: ToolHandler = {
	definition: {
		name: "send_to_agent",
		description:
			"Send an instruction prompt to the coding agent. Returns immediately with a task_id. The agent executes asynchronously — you will receive a callback message when the agent finishes, encounters an error, or needs input. If the target agent is busy, returns the current task info and recent agent logs instead. If agent_id is omitted, routes to the most recently used agent.",
		parameters: {
			type: "object",
			properties: {
				prompt: { type: "string", description: "The instruction prompt to send to the coding agent" },
				summary: {
					type: "string",
					description:
						"A brief human-readable summary of the current action for the chat interface (e.g., 'Asking agent to add JWT auth to auth/login.ts')",
				},
				agent_id: {
					type: "string",
					description: "Target agent name. If omitted, routes to the active agent.",
				},
			},
			required: ["prompt", "summary"],
		},
	},
	async execute(args: Record<string, any>, ctx: ToolContext) {
		const resolved = ctx.resolveAgent(args.agent_id as string | undefined);
		if ("error" in resolved) {
			return { output: `Error: ${resolved.error}`, terminal: false };
		}
		const { entry: sendAgent, id: sendAgentId } = resolved;
		ctx.activeAgentId = sendAgentId;

		const prompt = args.prompt as string;
		const summary = args.summary as string;

		// Non-blocking: check if agent is busy
		if (ctx.agentMonitor?.isBusy(sendAgentId)) {
			const task = ctx.agentMonitor.getTask(sendAgentId)!;
			const elapsed = Math.round((Date.now() - task.startedAt) / 1000);
			let paneContent = "";
			try {
				const capture = await ctx.bridge.capturePane(sendAgent.paneTarget, { startLine: -100 });
				paneContent = capture.content;
			} catch {
				paneContent = "(failed to capture pane content)";
			}
			return {
				output: `Agent ${sendAgentId} is busy (task_id: ${task.taskId}, running for ${elapsed}s).\nCurrent task: ${task.summary}\nCurrent agent logs:\n${paneContent}`,
				terminal: false,
			};
		}

		ctx.emitUiEvent("agent_update", summary);

		const sendAdapter = ctx.adapterFor(sendAgent);
		const sendPreHash = await ctx.stateDetector.captureHash(sendAgent.paneTarget);
		await sendAdapter.sendPrompt(ctx.bridge, sendAgent.paneTarget, prompt);
		ctx.promptTracker?.record(sendAgentId, prompt);

		if (ctx.agentMonitor) {
			const result = ctx.agentMonitor.dispatch(sendAgentId, sendAgent.paneTarget, {
				preHash: sendPreHash,
				summary,
				taskContext: prompt,
				characteristics: sendAdapter.getCharacteristics(),
			});

			if (result.dispatched) {
				return {
					output: `Task dispatched. task_id: ${result.task.taskId}, agent: ${sendAgentId}.\nYou will receive a callback when the agent finishes.`,
					terminal: false,
				};
			}
			return {
				output: `Agent ${sendAgentId} became busy unexpectedly.`,
				terminal: false,
			};
		}

		return { output: "Error: AgentMonitor not initialized", terminal: false };
	},
};

export const respondToAgent: ToolHandler = {
	definition: {
		name: "respond_to_agent",
		description:
			"Respond to an agent waiting for input. Only callable when the agent has an active task in waiting_input status. Returns immediately — you will receive a callback when the agent settles again.\n\nThe `value` grammar is STRICT (malformed directives are rejected with an explanatory error — do not invent other forms):\n  • `Enter` — press Enter (confirm current selection). Case-sensitive.\n  • `Escape` — press Escape. Case-sensitive.\n  • `arrow:up` | `arrow:down` | `arrow:up:N` | `arrow:down:N` — press Up/Down N times (N a positive integer, default 1) then Enter. Direction MUST be exactly `up` or `down`.\n  • `keys:<K1>,<K2>,...` — send a sequence of named keys (e.g. `keys:Down,Enter`). Each K must be a known key name (Enter, Escape, Up, Down, Left, Right, Tab, Space, Backspace, …), a single character, or a tmux key token like `C-c`, `S-Tab`, `F5`.\n  • `y` / `yes` / `n` / `no` — confirm/deny a genuine y/n or permission prompt (falls back to literal text on a numbered menu).\n  • anything else — sent as literal text then Enter (including menu option numbers like `2`).\nIf agent_id is omitted, routes to the most recently used agent.",
		parameters: {
			type: "object",
			properties: {
				value: { type: "string", description: "The response value to send" },
				summary: {
					type: "string",
					description:
						"A brief human-readable summary of this response for the chat interface (e.g., 'Confirming dependency installation')",
				},
				agent_id: {
					type: "string",
					description: "Target agent name. If omitted, routes to the active agent.",
				},
			},
			required: ["value", "summary"],
		},
	},
	async execute(args: Record<string, any>, ctx: ToolContext) {
		const resolved = ctx.resolveAgent(args.agent_id as string | undefined);
		if ("error" in resolved) {
			return { output: `Error: ${resolved.error}`, terminal: false };
		}
		const { entry: respondAgent, id: respondAgentId } = resolved;
		ctx.activeAgentId = respondAgentId;

		const value = args.value as string;
		const summary = args.summary as string;

		// Check task state
		if (ctx.agentMonitor) {
			const task = ctx.agentMonitor.getTask(respondAgentId);
			if (!task) {
				return {
					output: `Error: Agent ${respondAgentId} has no active task.`,
					terminal: false,
				};
			}
			if (task.status !== "waiting_input") {
				return {
					output: `Error: Agent ${respondAgentId} is not waiting for input (current status: ${task.status}).`,
					terminal: false,
				};
			}
		}

		ctx.emitUiEvent("agent_update", summary);

		// Capture preHash BEFORE sending the response (exactly like send_to_agent).
		// The response echo / menu dismissal then satisfies waitForSettled's Phase 1
		// by itself. Capturing after send was racy in both directions: an immediate
		// capture could snapshot the pane before it repainted (the race the previous
		// 500ms delay defended against), while the fixed delay let a fast agent fully
		// process the response first — snapshotting the SETTLED state as preHash, so
		// Phase 1 never saw a change and the monitor spun to its 4-hour timeout with
		// wait_for_agents parked on it. The pre-send pane is the one state guaranteed
		// to differ once the response lands, which covers both races.
		const respondPreHash = await ctx.stateDetector.captureHash(respondAgent.paneTarget);
		await ctx.adapterFor(respondAgent).sendResponse(ctx.bridge, respondAgent.paneTarget, value);
		ctx.promptTracker?.record(respondAgentId, value);

		if (ctx.agentMonitor) {
			const resumed = ctx.agentMonitor.resumeTask(respondAgentId, respondPreHash);
			if (!resumed) {
				return {
					output: `Error: Failed to resume task monitoring for agent ${respondAgentId}.`,
					terminal: false,
				};
			}
			return {
				output: "Response sent, agent continuing execution.",
				terminal: false,
			};
		}

		return { output: "Error: AgentMonitor not initialized", terminal: false };
	},
};

export const interruptAgent: ToolHandler = {
	definition: {
		name: "interrupt_agent",
		description:
			"Interrupt a coding agent that is going off track by sending an Escape key to its tmux session. This immediately interrupts the agent's current operation without destroying the session. Use when the agent is deviating from the goal and you want to regain control before sending a corrected instruction. If agent_id is omitted, routes to the most recently used agent.",
		parameters: {
			type: "object",
			properties: {
				summary: {
					type: "string",
					description:
						"A brief human-readable summary explaining why the agent is being interrupted (e.g., 'Agent is modifying wrong file, interrupting to redirect')",
				},
				agent_id: {
					type: "string",
					description: "Target agent name. If omitted, routes to the active agent.",
				},
			},
			required: ["summary"],
		},
	},
	async execute(args: Record<string, any>, ctx: ToolContext) {
		const resolved = ctx.resolveAgent(args.agent_id as string | undefined);
		if ("error" in resolved) {
			return { output: `Error: ${resolved.error}`, terminal: false };
		}
		const { entry: interruptAgent, id: interruptAgentId } = resolved;
		ctx.activeAgentId = interruptAgentId;

		const summary = args.summary as string;

		ctx.emitLog(`Interrupting agent ${interruptAgentId}: ${summary}`);
		ctx.broadcaster.broadcast({ type: "system", message: t("agent_interrupted", ctx.locale, { summary }) });

		// Route through the adapter's abort() rather than a raw single Escape: the
		// TUI adapters send a double Escape (the first often only cancels partial
		// input), so a bare bridge.sendEscape could leave the agent still running.
		await ctx.adapterFor(interruptAgent).abort(ctx.bridge, interruptAgent.paneTarget);

		if (ctx.agentMonitor) {
			ctx.agentMonitor.cleanup(interruptAgentId);
		}

		return {
			output: `Agent ${interruptAgentId} interrupted. You can now send a new instruction with send_to_agent.`,
			terminal: false,
		};
	},
};

export const inspectAgent: ToolHandler = {
	definition: {
		name: "inspect_agent",
		description:
			"Inspect an agent's current pane content and task status. Can be used at any time — during agent execution, while waiting, or after completion. Useful for checking progress, understanding what an agent is doing, or getting more context beyond what a callback provided. If agent_id is omitted, routes to the most recently used agent.",
		parameters: {
			type: "object",
			properties: {
				lines: { type: "number", description: "Number of lines to capture (e.g. 100, 200, 500)" },
				agent_id: {
					type: "string",
					description: "Target agent name. If omitted, routes to the active agent.",
				},
			},
			required: ["lines"],
		},
	},
	async execute(args: Record<string, any>, ctx: ToolContext) {
		const resolved = ctx.resolveAgent(args.agent_id as string | undefined);
		if ("error" in resolved) {
			return { output: `Error: ${resolved.error}`, terminal: false };
		}
		const { id: inspectAgentId } = resolved;
		const lines = args.lines as number;

		let paneContent: string;
		try {
			const capture = await ctx.bridge.capturePane(resolved.entry.paneTarget, { startLine: -lines });
			paneContent = capture.content;
		} catch (err: any) {
			return {
				output: `Error: Failed to capture pane for agent ${inspectAgentId}: ${err.message}`,
				terminal: false,
			};
		}

		let statusLabel = "idle";
		if (ctx.agentMonitor) {
			const task = ctx.agentMonitor.getTask(inspectAgentId);
			if (task) {
				statusLabel = task.status;
			}
		}

		return {
			output: `[Agent ${inspectAgentId}] Status: ${statusLabel}\n${paneContent}`,
			terminal: false,
		};
	},
};

export const createAgent: ToolHandler = {
	definition: {
		name: "create_agent",
		description:
			'Create a tmux session with the "omux-" prefix and launch the coding agent in it. Must be called before send_to_agent/respond_to_agent/inspect_agent. On naming conflict, returns an error so you can retry with a different name.\n\nIMPORTANT: If the user provides a resume id (or one was found in memory), you MUST pass it as resume_id. Omitting it will lose the agent\'s prior conversation context.',
		parameters: {
			type: "object",
			properties: {
				agent_name: {
					type: "string",
					description: 'Agent name (will be prefixed with "omux-" if not already). If omitted, auto-generated.',
				},
				adapter: {
					type: "string",
					description:
						'Which coding-agent adapter to launch (e.g. "claude-code", "codex"). Must be one of the active adapters listed under \'Agent Capabilities\'. When omitted, the configured default adapter is used. Pick per task — see the Multi-Agent Orchestration guidance when more than one adapter is active.',
				},
				working_dir: {
					type: "string",
					description: "Working directory for the agent. Defaults to process.cwd() if omitted.",
				},
				isolation: {
					type: "string",
					enum: ["shared", "worktree"],
					description:
						'Filesystem isolation for the agent. "shared" (default) launches the agent directly in working_dir — pick this when the task depends on other in-flight work or shares files with another agent; concurrent edits then serialize on the one checkout. "worktree" launches the agent in a dedicated git worktree on a fresh `omux/<name>` branch cut from working_dir\'s HEAD, so it can edit in parallel without colliding with other agents. Use it ONLY for independent, edit-heavy tasks. Requires working_dir to be a git repo. To integrate the result you MUST have the agent COMMIT its work to the branch, then dispatch a separate merge agent (in the main checkout) to `git merge omux/<name>`. kill_agent removes the worktree afterward and refuses if it still has uncommitted or unmerged changes.',
				},
				model: {
					type: "string",
					description:
						"Model to launch the agent with, passed through to the underlying CLI via --model. When omitted, the adapter's default is used (Claude Code: opus, Codex: gpt-5.5). Must not contain whitespace.",
				},
				resume_id: {
					type: "string",
					description:
						"Resume id for restoring a previous agent conversation. REQUIRED when the user supplies a resume id or one was retrieved from memory. When provided, launches with --resume to restore the agent's prior conversation. When omitted, a fresh agent starts and all previous context is lost.",
				},
				pre_commands: {
					type: "array",
					items: { type: "string" },
					description:
						'Shell commands to run before launching the agent. Each command is joined with " && " and prepended to the agent launch command. Example: ["export FOO=bar", "source .env"] results in: export FOO=bar && source .env && claude ...',
				},
				mcp_servers: {
					type: "array",
					items: { type: "string" },
					description:
						"Names of MCP servers to make available to this SubAgent. Uses server names from Omux's MCP configuration. When provided, only these servers are available via --strict-mcp-config. When omitted, the SubAgent uses its default MCP behavior. Pass an empty array to launch with no MCP servers.",
				},
			},
		},
	},
	async execute(args: Record<string, any>, ctx: ToolContext) {
		logger.debug("main-agent", `create_agent raw args: ${JSON.stringify(args)}`);
		const rawName = args.agent_name as string | undefined;
		let agentName: string;
		if (!rawName) {
			agentName = generateAgentName("chat");
		} else if (!rawName.startsWith("omux-") && !rawName.startsWith("cliclaw-")) {
			// Legacy cliclaw-prefixed names are kept as-is so pre-rename sessions
			// can be recreated/resumed under their original names.
			agentName = `omux-${rawName}`;
		} else {
			agentName = rawName;
		}

		const rawWorkingDir = (args.working_dir as string | undefined) ?? process.cwd();
		const workingDir = rawWorkingDir.startsWith("~/")
			? join(homedir(), rawWorkingDir.slice(2))
			: rawWorkingDir.startsWith("~")
				? homedir()
				: rawWorkingDir;
		if (workingDir !== rawWorkingDir) {
			logger.debug("main-agent", `create_agent expanded working_dir: "${rawWorkingDir}" → "${workingDir}"`);
		}

		try {
			const dirStat = await import("node:fs/promises").then((m) => m.stat(workingDir));
			if (!dirStat.isDirectory()) {
				return { output: `Error: "${workingDir}" is not a directory.`, terminal: false };
			}
		} catch {
			return { output: `Error: Directory "${workingDir}" does not exist.`, terminal: false };
		}

		const exists = await ctx.bridge.hasSession(agentName);
		if (exists) {
			return {
				output: `Error: Agent "${agentName}" already exists. Choose a different name or use list_agents to see existing agents.`,
				terminal: false,
			};
		}

		try {
			const rawResumeId = args.resume_id as string | undefined;
			const resumeId = rawResumeId?.trim() || undefined;
			if (resumeId && /\s/.test(resumeId)) {
				return {
					output: `Error: resume_id must not contain whitespace: "${resumeId}"`,
					terminal: false,
				};
			}
			const rawModel = args.model as string | undefined;
			const model = rawModel?.trim() || undefined;
			if (model && /\s/.test(model)) {
				return {
					output: `Error: model must not contain whitespace: "${model}"`,
					terminal: false,
				};
			}
			const rawPreCommands = args.pre_commands as string[] | undefined;
			const preCommands =
				rawPreCommands && Array.isArray(rawPreCommands) && rawPreCommands.length > 0
					? rawPreCommands.filter((c) => typeof c === "string" && c.trim())
					: undefined;

			// Resolve which adapter to launch: omitted → default; otherwise must be active.
			const rawAdapter = (args.adapter as string | undefined)?.trim();
			const adapterName = rawAdapter || ctx.defaultAdapterName;
			const adapter = ctx.adapters.get(adapterName);
			if (!adapter) {
				const active = [...ctx.adapters.keys()].join(", ");
				return {
					output: `Error: adapter "${adapterName}" is not active. Active adapters: ${active}.`,
					terminal: false,
				};
			}

			// Handle mcp_servers: generate temp config file if specified
			let mcpConfigPath: string | undefined;
			const rawMcpServers = args.mcp_servers as string[] | undefined;
			if (rawMcpServers !== undefined && Array.isArray(rawMcpServers)) {
				const config = await loadConfig();
				if (!config.mcpServers || Object.keys(config.mcpServers).length === 0) {
					return {
						output: "Error: No MCP servers configured. Add MCP servers via the settings UI or config.json.",
						terminal: false,
					};
				}
				const selection = selectMcpServers(config.mcpServers, rawMcpServers);
				if ("error" in selection) {
					return { output: `Error: ${selection.error}`, terminal: false };
				}
				mcpConfigPath = await generateMcpConfigFile(selection.servers, agentName);
				logger.info("main-agent", `Generated MCP config for ${agentName}: ${mcpConfigPath}`);
			}

			// Resolve filesystem isolation. "shared" launches in working_dir directly;
			// "worktree" cuts a dedicated git worktree so parallel edit-heavy agents don't
			// collide. `launchDir` is where the agent actually runs (worktree path when
			// isolated); `worktreeMeta` is persisted so kill_agent can clean it up later.
			let launchDir = workingDir;
			let worktreeMeta: { path: string; branch: string; sourceRepo: string } | undefined;
			const rawIsolation = (args.isolation as string | undefined)?.trim() || "shared";
			if (rawIsolation !== "shared" && rawIsolation !== "worktree") {
				return {
					output: `Error: isolation must be "shared" or "worktree" (got "${rawIsolation}").`,
					terminal: false,
				};
			}
			if (rawIsolation === "worktree") {
				if (!(await isGitRepo(workingDir))) {
					return {
						output: `Error: isolation "worktree" requires working_dir to be inside a git repository, but "${workingDir}" is not one.`,
						terminal: false,
					};
				}
				const sourceRepo = await repoRoot(workingDir);
				const branch = `omux/${agentName.replace(/^(omux|cliclaw)-/, "")}`;
				// Worktrees live under the target project's dot dir (<repo>/.omux/worktrees/<agent>).
				// Because that path is inside the main working tree, add it to the repo's local
				// info/exclude first so the checkout doesn't pollute the main checkout's git status.
				const dotDir = projectDotDir(sourceRepo);
				const worktreePath = join(dotDir, "worktrees", agentName);
				try {
					await ensureExcluded(sourceRepo, `${basename(dotDir)}/worktrees/`);
				} catch (err: any) {
					logger.warn("main-agent", `ensureExcluded failed for ${sourceRepo}: ${err?.message ?? err}`);
				}
				const pathExists = await import("node:fs/promises").then((m) =>
					m.stat(worktreePath).then(
						() => true,
						() => false,
					),
				);
				if (pathExists) {
					// Only tolerated on resume (reuse the prior worktree/branch); otherwise it's a
					// stale/colliding checkout the agent would silently inherit.
					if (!resumeId) {
						return {
							output: `Error: worktree path "${worktreePath}" already exists. Kill the previous agent (or remove the worktree) before reusing this name.`,
							terminal: false,
						};
					}
					logger.info("main-agent", `Reusing existing worktree for ${agentName}: ${worktreePath}`);
				} else {
					try {
						await addWorktree(sourceRepo, worktreePath, branch);
					} catch (err: any) {
						return {
							output: `Error: git worktree add failed: ${err?.stderr?.trim() || err?.message || err}`,
							terminal: false,
						};
					}
				}
				launchDir = worktreePath;
				worktreeMeta = { path: worktreePath, branch, sourceRepo };
				logger.info(
					"main-agent",
					`Worktree isolation for ${agentName}: ${worktreePath} on branch ${branch} (source ${sourceRepo})`,
				);
			}

			const paneTarget = await adapter.launch(ctx.bridge, {
				workingDir: launchDir,
				sessionName: agentName,
				resumeId,
				model,
				preCommands,
				mcpConfigPath,
			});
			const resolvedModel = model ?? adapter.defaultModel;
			ctx.agents.set(agentName, {
				paneTarget,
				workingDir: launchDir,
				model: resolvedModel,
				adapter: adapterName,
				worktree: worktreeMeta,
			});
			await ctx.changeTracker?.registerAgent(agentName, launchDir);
			ctx.agentStore?.saveAgent(agentName, {
				paneTarget,
				workingDir: launchDir,
				model: resolvedModel,
				adapter: adapterName,
				worktree: worktreeMeta,
			});
			ctx.activeAgentId = agentName;
			// Per-pane characteristics are passed explicitly at dispatch time
			// (send_to_agent → AgentMonitor.dispatch → waitForSettled). The detector
			// no longer holds a single global set, which would misclassify a pane with
			// the patterns of the most-recently-created agent once panes of different
			// adapters (Claude Code ❯ / Codex ›) coexist.
			logger.info(
				"main-agent",
				`Agent created: ${agentName} (${adapterName}), pane: ${paneTarget}, cwd: ${workingDir}`,
			);
			ctx.notifyAgentChange();
			const mcpNote = mcpConfigPath ? ` MCP servers: ${rawMcpServers!.join(", ")}.` : "";

			// Surface the target project's MEMORY.md to the main agent (not the sub agent).
			// The main agent decides whether/how to fold this into the first send_to_agent prompt.
			// projectDotDir prefers .omux/ and falls back to a legacy cliclaw .cliclaw/ dir.
			const projectMemoryPath = join(projectDotDir(workingDir), "MEMORY.md");
			const projectMemory = await readPersistentMemory(projectMemoryPath);
			const memorySection = projectMemory.trim()
				? `\n\n--- Project memory at ${projectMemoryPath} ---\n${projectMemory.trim()}\n--- end project memory ---\nThis is for YOUR reference only. The sub agent has not seen it. Decide whether to surface relevant excerpts in your first send_to_agent prompt, or to point the agent at the file path so it can read on demand.`
				: `\n\nNo project memory found at ${projectMemoryPath}.`;

			// Wait for the agent's TUI to settle, then capture the first 20 visible lines
			// so the main agent can confirm the launch state without an extra inspect_agent call.
			if (ctx.createAgentSettleMs > 0) {
				await new Promise((resolve) => setTimeout(resolve, ctx.createAgentSettleMs));
			}
			let initialPaneSection: string;
			try {
				const capture = await ctx.bridge.capturePane(paneTarget, { startLine: -20 });
				initialPaneSection = `\n\n--- Initial pane (${paneTarget}, last 20 lines after 10s) ---\n${capture.content}\n--- end pane ---`;
			} catch (err: any) {
				initialPaneSection = `\n\n[Initial pane capture failed: ${err?.message ?? err}]`;
			}

			const worktreeSection = worktreeMeta
				? `\n\n--- Worktree isolation ---\nThis agent runs in an ISOLATED git worktree at ${worktreeMeta.path} on branch ${worktreeMeta.branch} (cut from ${worktreeMeta.sourceRepo}). Its edits do NOT touch the main checkout. To integrate the result: (1) instruct the agent to COMMIT its work to the branch, (2) then create/reuse a separate agent in ${worktreeMeta.sourceRepo} and have it \`git merge ${worktreeMeta.branch}\` (resolving conflicts). kill_agent will remove the worktree afterward — and will REFUSE if the worktree is still dirty or the branch is unmerged (pass force:true to override and discard).\n--- end worktree ---`
				: "";

			return {
				output: `Agent "${agentName}" (${adapter.displayName}) created in ${launchDir}. Agent launched in ${paneTarget}.${mcpNote} You can now use send_to_agent.${worktreeSection}${memorySection}${initialPaneSection}`,
				terminal: false,
			};
		} catch (err: any) {
			return { output: `Failed to create agent: ${err.message}`, terminal: false };
		}
	},
};

export const listAgents: ToolHandler = {
	definition: {
		name: "list_agents",
		description:
			"List coding agents in two groups: (1) MANAGED agents this process owns — with adapter, model, working dir, status, and taken-over flag — these are the ones you can drive with send_to_agent; (2) UNMANAGED omux-* (or legacy cliclaw-*) tmux sessions outside this process's registry (another omux instance or a stale session) that you must NOT send_to_agent. Useful for checking existing agents before creating a new one.",
		parameters: {
			type: "object",
			properties: {},
		},
	},
	async execute(_args: Record<string, any>, ctx: ToolContext) {
		try {
			// Merge two views so the LLM never tries to drive a session this process can't:
			//  1. Registry — agents THIS process owns (send_to_agent works). Adapter/model/
			//     cwd/status/takenOver come from the in-memory map + monitor.
			//  2. Unmanaged tmux — omux-* (or legacy cliclaw-*) sessions NOT in our registry
			//     (e.g. another omux instance or a stale session). Listed separately as not controllable.
			const managed = ctx.getActiveAgents();
			const managedNames = new Set(managed.map((a) => a.agentName));
			let tmuxSessions: Array<{ name: string; windows?: number; attached?: boolean }> = [];
			try {
				tmuxSessions = await ctx.bridge.listOmuxAgents();
			} catch (err: any) {
				// tmux query failed — still report the registry view (source of truth for control).
				logger.warn("main-agent", `list_agents: listOmuxAgents failed: ${err?.message ?? err}`);
			}
			const unmanaged = tmuxSessions.filter((s) => !managedNames.has(s.name));

			if (managed.length === 0 && unmanaged.length === 0) {
				return { output: "No active agents found.", terminal: false };
			}

			const sections: string[] = [];
			if (managed.length > 0) {
				const rows = managed
					.map(
						(a) =>
							`- ${a.agentName} — adapter: ${a.adapter}, model: ${a.model}, cwd: ${a.workingDir}, status: ${a.status}${a.takenOver ? ", taken over: yes (release in Web UI before driving)" : ""}`,
					)
					.join("\n");
				sections.push(`Managed agents (${managed.length}) — you can send_to_agent these:\n${rows}`);
			}
			if (unmanaged.length > 0) {
				const rows = unmanaged.map((s) => `- ${s.name}`).join("\n");
				sections.push(
					`Unmanaged tmux sessions (${unmanaged.length}) — NOT controllable by this process (another omux instance or stale session); do NOT send_to_agent these:\n${rows}`,
				);
			}
			return { output: sections.join("\n\n"), terminal: false };
		} catch (err: any) {
			return { output: `Error listing agents: ${err.message}`, terminal: false };
		}
	},
};

/**
 * Remove a worktree-isolated agent's git worktree and branch after its tmux session is
 * gone. Returns a human-readable status line, or null when the agent had no worktree.
 *
 * Without `force`, refuses to remove a worktree that still has uncommitted changes or
 * unmerged commits — the worktree and branch are left in place and the returned message
 * explains how to recover, so a sub-agent's work is never silently discarded.
 */
async function cleanupAgentWorktree(
	entry: { worktree?: { path: string; branch: string; sourceRepo: string } },
	force: boolean,
): Promise<string | null> {
	const wt = entry.worktree;
	if (!wt) return null;
	const { path, branch, sourceRepo } = wt;

	const pathExists = await import("node:fs/promises").then((m) =>
		m.stat(path).then(
			() => true,
			() => false,
		),
	);

	if (!force && pathExists) {
		const reasons: string[] = [];
		try {
			if (await isWorktreeDirty(path)) reasons.push("uncommitted changes");
		} catch {
			/* `git status` failed — fall through and let removal decide */
		}
		try {
			if (await hasUnmergedCommits(sourceRepo, branch)) reasons.push("unmerged commits");
		} catch {
			/* rev-list failed (branch already gone?) — ignore */
		}
		if (reasons.length > 0) {
			return `Worktree preserved (not removed): ${path} on branch ${branch} still has ${reasons.join(
				" + ",
			)}. Merge it via a sub-agent (\`git merge ${branch}\` in ${sourceRepo}), then kill again — or kill with force:true to discard.`;
		}
	}

	try {
		if (pathExists) await removeWorktree(sourceRepo, path, force);
	} catch (err: any) {
		return `Worktree removal failed for ${path}: ${
			err?.stderr?.trim() || err?.message || err
		}. Remove it manually with \`git worktree remove${force ? " --force" : ""} ${path}\`.`;
	}
	// Branch delete is best-effort: `-d` already refuses unmerged branches, and a stray
	// branch is harmless. Only surface the worktree removal.
	try {
		await deleteBranch(sourceRepo, branch, force);
	} catch {
		/* unmerged (non-force) or already gone — leave the branch in place */
	}
	return `Worktree removed: ${path}; branch ${branch} ${force ? "force-deleted" : "cleaned up"}.`;
}

export const killAgent: ToolHandler = {
	definition: {
		name: "kill_agent",
		description:
			'Gracefully exit a coding agent and destroy its tmux session. Returns captured output and a resume id (if available) for resuming later with --resume. If agent_id is omitted, targets the active agent. Set agent_id to "all" to kill all agents.\n\nFor worktree-isolated agents this also removes the git worktree and deletes its branch — but REFUSES (preserving the worktree and reporting its path) when the worktree still has uncommitted changes or unmerged commits, so work is never silently lost. Merge the branch via a sub-agent first, or pass force:true to remove it anyway and discard the changes.',
		parameters: {
			type: "object",
			properties: {
				agent_id: {
					type: "string",
					description:
						'Target agent name (e.g. "omux-chat-1"). Omit to target the active agent. Set to "all" to kill all agents.',
				},
				summary: {
					type: "string",
					description: "A brief human-readable summary (e.g., 'Cleaning up agent after task complete')",
				},
				force: {
					type: "boolean",
					description:
						"For worktree-isolated agents: remove the worktree and delete its branch even when there are uncommitted or unmerged changes, discarding them. Ignored for shared-checkout agents. Default false.",
				},
			},
			required: ["summary"],
		},
	},
	async execute(args: Record<string, any>, ctx: ToolContext) {
		const killAgentId = args.agent_id as string | undefined;
		const killSummary = args.summary as string;
		const killForce = args.force === true;
		ctx.emitUiEvent("agent_update", killSummary);

		try {
			// ── Kill all agents ──
			if (killAgentId === "all") {
				// Only operate on agents THIS process manages, and only after graceful
				// exitAgent (so resume IDs are captured). Two classes are deliberately spared:
				//   • human-taken-over agents — killing them would yank a session out from
				//     under a human; report them as skipped.
				//   • unmanaged omux-* (or legacy cliclaw-*) tmux sessions not in our registry (e.g.
				//     another omux instance) — we never had control, so killing them ungracefully
				//     would lose someone else's resume IDs. List them as left untouched.
				let tmuxSessions: Array<{ name: string }> = [];
				try {
					tmuxSessions = await ctx.bridge.listOmuxAgents();
				} catch (err: any) {
					logger.warn("main-agent", `kill_agent all: listOmuxAgents failed: ${err?.message ?? err}`);
				}

				const killableIds = [...ctx.agents.keys()].filter((id) => !ctx.takenOverAgents.has(id));
				const skippedTakenOver = [...ctx.agents.keys()].filter((id) => ctx.takenOverAgents.has(id));
				const managedNames = new Set(ctx.agents.keys());
				const untouchedUnmanaged = tmuxSessions.map((s) => s.name).filter((n) => !managedNames.has(n));

				if (killableIds.length === 0 && skippedTakenOver.length === 0 && untouchedUnmanaged.length === 0) {
					return { output: "No agents to kill.", terminal: false };
				}

				// Gracefully exit + kill each killable registered agent (best-effort)
				const resumeIds: string[] = [];
				const killed: string[] = [];
				for (const id of killableIds) {
					const entry = ctx.agents.get(id);
					if (!entry) continue;
					try {
						const entryAdapter = ctx.adapterFor(entry);
						if (entryAdapter.exitAgent) {
							const result = await entryAdapter.exitAgent(ctx.bridge, entry.paneTarget);
							if (result.resumeId) resumeIds.push(`${id}: ${result.resumeId}`);
						}
					} catch {
						/* best-effort */
					}
					try {
						await ctx.bridge.killSession(id);
						killed.push(id);
					} catch {
						/* best-effort */
					}
				}

				// Cleanup registered agents that were actually killed
				const worktreeNotes: string[] = [];
				for (const id of killableIds) {
					const entry = ctx.agents.get(id);
					if (ctx.learningPipeline && ctx.changeTracker) {
						if (entry) {
							try {
								await ctx.learningPipeline.ingestAgentKill({
									sessionId: id,
									sessionName: id,
									cwd: entry.workingDir,
									agentPrompts: ctx.promptTracker?.getFor(id) ?? [],
								});
							} catch (err) {
								logger.warn("main-agent", `learning ingest failed for ${id}: ${(err as Error).message}`);
							}
						}
						ctx.changeTracker.releaseAgent(id);
					}
					// Remove the git worktree (if any) before dropping the registry entry.
					if (entry) {
						try {
							const note = await cleanupAgentWorktree(entry, killForce);
							if (note) worktreeNotes.push(`${id}: ${note}`);
						} catch (err) {
							worktreeNotes.push(`${id}: worktree cleanup errored: ${(err as Error).message}`);
						}
					}
					// Always release prompt tracker, independent of learning pipeline
					ctx.promptTracker?.release(id);
					// Cleanup MCP config temp file (best-effort)
					await cleanupMcpConfigFile(id).catch(() => {});
					ctx.cleanupAgent(id);
				}
				ctx.notifyAgentChange();

				const parts = [`Killed ${killed.length} agent(s): ${killed.join(", ") || "(none)"}`];
				if (worktreeNotes.length > 0) {
					parts.push(`\nWorktrees:\n${worktreeNotes.join("\n")}`);
				}
				if (resumeIds.length > 0) {
					parts.push(`\nResume IDs:\n${resumeIds.join("\n")}`);
				}
				if (skippedTakenOver.length > 0) {
					parts.push(`\nSkipped (human-taken-over — release in Web UI first): ${skippedTakenOver.join(", ")}`);
				}
				if (untouchedUnmanaged.length > 0) {
					parts.push(
						`\nLeft untouched (unmanaged omux-*/cliclaw-* sessions not owned by this process): ${untouchedUnmanaged.join(", ")}`,
					);
				}
				return { output: parts.join("\n"), terminal: false };
			}

			// ── Kill single agent ──
			const resolved = ctx.resolveAgent(killAgentId);
			if ("error" in resolved) {
				return { output: `Error: ${resolved.error}`, terminal: false };
			}
			const { entry: agentEntry, id: agentId } = resolved;

			// Gracefully exit agent to capture resume id (best-effort)
			let agentContent = "";
			let resumeId: string | undefined;
			const killAdapter = ctx.adapterFor(agentEntry);
			if (killAdapter.exitAgent) {
				try {
					const exitResult = await killAdapter.exitAgent(ctx.bridge, agentEntry.paneTarget);
					agentContent = exitResult.content;
					resumeId = exitResult.resumeId;
				} catch (err: any) {
					logger.warn("main-agent", `exitAgent failed (will still kill tmux): ${err.message}`);
				}
			}

			// Kill tmux session
			const exists = await ctx.bridge.hasSession(agentId);
			if (exists) {
				await ctx.bridge.killSession(agentId);
			}

			if (ctx.learningPipeline && ctx.changeTracker) {
				try {
					await ctx.learningPipeline.ingestAgentKill({
						sessionId: agentId,
						sessionName: agentId,
						cwd: agentEntry.workingDir,
						agentPrompts: ctx.promptTracker?.getFor(agentId) ?? [],
					});
				} catch (err) {
					logger.warn("main-agent", `learning ingest failed for ${agentId}: ${(err as Error).message}`);
				}
				ctx.changeTracker.releaseAgent(agentId);
			}
			// Remove the git worktree (if any) before dropping the registry entry.
			let worktreeNote: string | null = null;
			try {
				worktreeNote = await cleanupAgentWorktree(agentEntry, killForce);
			} catch (err) {
				worktreeNote = `worktree cleanup errored: ${(err as Error).message}`;
			}
			// Always release prompt tracker, independent of learning pipeline
			ctx.promptTracker?.release(agentId);
			// Cleanup MCP config temp file (best-effort)
			await cleanupMcpConfigFile(agentId).catch(() => {});

			// Cleanup agent registry
			ctx.cleanupAgent(agentId);
			ctx.notifyAgentChange();

			const parts = [`[Agent killed]\n${agentContent}`];
			if (resumeId) {
				parts.push(`\nResume ID: ${resumeId}`);
				parts.push(`Working directory: ${agentEntry.workingDir}`);
			}
			if (worktreeNote) {
				parts.push(`\n${worktreeNote}`);
			}
			return { output: parts.join("\n"), terminal: false };
		} catch (err: any) {
			return { output: `Failed to kill agent: ${err.message}`, terminal: false };
		}
	},
};

export const waitForAgents: ToolHandler = {
	definition: {
		name: "wait_for_agents",
		description:
			"Yield the execution loop and wait for running sub-agents to report back — WITHOUT polling. Call this as your final action of the turn when the only thing left to do is wait for one or more sub-agents that are still working. Every sub-agent is monitored in the background, and you will be AUTOMATICALLY resumed with a fresh turn the instant any agent completes, errors, needs input, or times out. Because of that callback, repeatedly calling inspect_agent to 'keep watching' is pure waste — it burns tokens on the full context every round and changes nothing. If at least one agent is still working (or an event is already queued), this parks you efficiently until the next callback. If nothing is working, it tells you so — then judge for yourself: keep driving with send_to_agent if the goal isn't met yet, or reply to the user to end the loop if it is.",
		parameters: {
			type: "object",
			properties: {},
			required: [],
		},
	},
	async execute(_args: Record<string, any>, ctx: ToolContext) {
		const activeTasks = ctx.agentMonitor?.getAllTasks() ?? [];
		const pendingEvents = ctx.workQueue.getAgentEvents();
		const running = activeTasks.filter((t) => t.status === "running");
		const waiting = activeTasks.filter((t) => t.status === "waiting_input");

		// A future wake-up is guaranteed only when something will fire a callback:
		// a running task (settles later → enqueues an event) or an event already in
		// the queue (drained by dispatchNext the moment we return to idle). A
		// waiting_input task already fired its callback and will NOT fire again until
		// respond_to_agent → resumeTask, so it does not, on its own, justify parking.
		const willWake = running.length > 0 || pendingEvents.length > 0;

		const lines: string[] = [];
		if (running.length > 0) {
			lines.push(`## Working (${running.length})`);
			for (const t of running) {
				const elapsed = Math.round((Date.now() - t.startedAt) / 1000);
				lines.push(`- ${t.agentId} (${t.taskId}) elapsed=${elapsed}s — ${t.summary}`);
			}
		}
		if (waiting.length > 0) {
			if (lines.length > 0) lines.push("");
			lines.push(`## Waiting for your input (${waiting.length}) — use respond_to_agent`);
			for (const t of waiting) {
				lines.push(`- ${t.agentId} (${t.taskId}) — ${t.summary}`);
			}
		}
		if (pendingEvents.length > 0) {
			if (lines.length > 0) lines.push("");
			lines.push(`## Already reported, delivered to you next (${pendingEvents.length})`);
			for (const e of pendingEvents) {
				lines.push(`- ${e.agentId} (${e.taskId}) status=${e.status} — ${e.summary}`);
			}
		}

		if (willWake) {
			ctx.broadcaster.broadcast({
				type: "system",
				message: t("parked_waiting", ctx.locale, { count: running.length }),
			});
			const header =
				`⏸ Parked. ${running.length} agent(s) still working` +
				(pendingEvents.length > 0 ? `, ${pendingEvents.length} event(s) already queued` : "") +
				". You will be resumed automatically on the next callback — do NOT poll in the meantime.";
			return { output: `${header}\n\n${lines.join("\n")}`, terminal: true };
		}

		// Nothing will wake us — parking would stall the loop. Nudge the model to act.
		if (waiting.length > 0) {
			return {
				output: `No agents are working in the background, but ${waiting.length} agent(s) are waiting for your input — respond with respond_to_agent instead of waiting.\n\n${lines.join("\n")}`,
				terminal: false,
			};
		}
		return {
			output:
				"No sub-agents are working and no events are queued — there is nothing to wait for. Decide based on the overall goal, not on this pause:\n" +
				"- If the success criteria are NOT yet met (tests not passing, behavior not verified end-to-end, or more work remains), keep driving — dispatch the next round with send_to_agent (or create_agent if no suitable agent exists).\n" +
				"- If the goal IS fully met, do NOT call another tool: reply with a brief final summary to the user. That returns you to idle and ends the loop.",
			terminal: false,
		};
	},
};
