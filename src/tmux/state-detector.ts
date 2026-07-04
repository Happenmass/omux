import { createHash } from "node:crypto";
import type { AgentCharacteristics } from "../agents/adapter.js";
import type { LLMClient } from "../llm/client.js";
import type { PromptLoader } from "../llm/prompt-loader.js";
import { logger } from "../utils/logger.js";
import type { TmuxBridge } from "./bridge.js";

export type PaneStatus = "active" | "waiting_input" | "completed" | "error" | "idle" | "unknown";

export interface PaneAnalysis {
	status: PaneStatus;
	confidence: number;
	detail: string;
}

export interface DeepAnalysis extends PaneAnalysis {
	shouldReplan: boolean;
	alternativeApproach?: string;
	humanInterventionNeeded: boolean;
	reason: string;
}

export interface StateDetectorConfig {
	pollIntervalMs: number;
	stableThresholdMs: number;
	captureLines: number;
}

export interface WaitForSettledOptions {
	preHash: string;
	timeoutMs?: number;
	isAborted?: () => boolean;
	/** Adapter-specific detection patterns for this pane. When omitted, no pattern matching runs and classification defers to Layer 2. */
	characteristics?: AgentCharacteristics | null;
}

export interface SettledResult {
	analysis: PaneAnalysis;
	content: string;
	timedOut: boolean;
}

type StateChangeCallback = (analysis: PaneAnalysis, paneContent: string) => void;

/**
 * Consecutive capturePane() failures in waitForSettled before we give up and
 * report the pane as unreachable. A single transient tmux hiccup should not end
 * a wait, but a killed session (every poll throwing) must not run to the 4-hour
 * timeout — that would park wait_for_agents on a wake-up that arrives hours late.
 */
const MAX_CONSECUTIVE_CAPTURE_FAILURES = 5;

export class StateDetector {
	private config: StateDetectorConfig;
	private bridge: TmuxBridge;
	private llmClient: LLMClient;
	private promptLoader: PromptLoader;

	private monitoring = false;
	private pollTimer: ReturnType<typeof setInterval> | null = null;
	private lastHash: string | null = null;
	private lastChangeTime = 0;
	private lastContent = "";
	private callbacks: StateChangeCallback[] = [];
	private analyzing = false;

	constructor(bridge: TmuxBridge, llmClient: LLMClient, config: StateDetectorConfig, promptLoader: PromptLoader) {
		this.bridge = bridge;
		this.llmClient = llmClient;
		this.config = config;
		this.promptLoader = promptLoader;
	}

	onStateChange(callback: StateChangeCallback): () => void {
		this.callbacks.push(callback);
		return () => {
			const idx = this.callbacks.indexOf(callback);
			if (idx >= 0) this.callbacks.splice(idx, 1);
		};
	}

	/**
	 * Single-pane interval-poll monitor. Characteristics are passed explicitly per
	 * call — the detector no longer holds a global set (which would misclassify a
	 * pane with the patterns of the most-recently-created agent once Claude Code (❯)
	 * and Codex (›) panes coexist). The core flow drives panes through
	 * {@link waitForSettled}; this interval-poll path is currently unused by the
	 * core flow (its former consumer, SignalRouter, was removed).
	 */
	startMonitoring(paneTarget: string, taskContext: string, characteristics: AgentCharacteristics | null): void {
		if (this.monitoring) return;
		this.monitoring = true;
		this.lastHash = null;
		this.lastChangeTime = Date.now();
		this.lastContent = "";

		logger.info("state-detector", `Starting monitoring for ${paneTarget}`);

		this.pollTimer = setInterval(() => {
			this.poll(paneTarget, taskContext, characteristics).catch((err) => {
				logger.error("state-detector", `Poll error: ${err.message}`);
			});
		}, this.config.pollIntervalMs);
	}

	stopMonitoring(): void {
		this.monitoring = false;
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = null;
		}
		logger.info("state-detector", "Monitoring stopped");
	}

	private async poll(
		paneTarget: string,
		taskContext: string,
		characteristics: AgentCharacteristics | null,
	): Promise<void> {
		if (!this.monitoring) return;

		try {
			const capture = await this.bridge.capturePane(paneTarget, {
				startLine: -this.config.captureLines,
			});

			const content = capture.content;
			const hash = createHash("md5").update(content).digest("hex");

			// Layer 1: Quick change detection
			if (hash !== this.lastHash) {
				// Content changed — agent is active
				this.lastHash = hash;
				this.lastChangeTime = Date.now();
				this.lastContent = content;

				// Quick pattern check (Layer 1.5)
				const quickResult = this.quickPatternCheck(content, characteristics);
				if (quickResult) {
					this.emit(quickResult, content);
				}
				return;
			}

			// Content hasn't changed — check if stable long enough
			const stableDuration = Date.now() - this.lastChangeTime;

			if (stableDuration >= this.config.stableThresholdMs && !this.analyzing) {
				// Stable for too long — trigger Layer 2
				this.analyzing = true;
				logger.info("state-detector", `Content stable for ${stableDuration}ms, triggering Layer 2 analysis`);
				try {
					const analysis = await this.analyzeState(content, taskContext);
					this.emit(analysis, content);
				} finally {
					this.analyzing = false;
					// Reset timer to avoid re-triggering immediately
					this.lastChangeTime = Date.now();
				}
			}
		} catch (err: any) {
			logger.error("state-detector", `Capture error: ${err.message}`);
		}
	}

	/** Whether any active pattern matches the tail of the pane content. */
	private matchesActive(content: string, characteristics: AgentCharacteristics): boolean {
		const lastLines = content.split("\n").slice(-8).join("\n");
		return characteristics.activePatterns.some((pattern) => pattern.test(lastLines));
	}

	/** Whether any error pattern matches the tail of the pane content. */
	private matchesError(content: string, characteristics: AgentCharacteristics): boolean {
		const lastLines = content.split("\n").slice(-8).join("\n");
		return characteristics.errorPatterns.some((pattern) => pattern.test(lastLines));
	}

	/**
	 * Layer 1.5: Quick regex-based pattern matching.
	 *
	 * `characteristics` is required — the detector no longer keeps a global set,
	 * so every classification is scoped to the pane's own adapter (mixing Claude
	 * Code and Codex panes previously misclassified whichever pane wasn't the
	 * most-recently-created agent).
	 *
	 * Priority ordering intentionally puts waiting/active ABOVE error: while an
	 * agent is still working, its transcript may quote strings like
	 * `Error: expected 200`. A live spinner or interactive prompt on screen is a
	 * stronger signal of "still busy" than a stray "Error:" is of "failed", so we
	 * never report `error` when the agent visibly is active/waiting. A genuine
	 * error that survives the stability window (no active pattern present) is still
	 * caught — see `waitForSettled`, which additionally requires stability before
	 * returning a pattern-detected error.
	 */
	quickPatternCheck(content: string, characteristics: AgentCharacteristics | null): PaneAnalysis | null {
		if (!characteristics) return null;

		const lastLines = content.split("\n").slice(-8).join("\n");

		// Check waiting patterns first (specific interactive prompts). These win over
		// a co-present "Error:" in the transcript because a live prompt is decisive.
		for (const pattern of characteristics.waitingPatterns) {
			if (pattern.test(lastLines)) {
				return {
					status: "waiting_input",
					confidence: 0.6,
					detail: "Agent appears to be waiting for input",
				};
			}
		}

		// Check active patterns before error: a running spinner / live status hint
		// means the agent is still working, so a quoted "Error:" is not terminal.
		for (const pattern of characteristics.activePatterns) {
			if (pattern.test(lastLines)) {
				return {
					status: "active",
					confidence: 0.8,
					detail: "Agent is actively working",
				};
			}
		}

		// Check error patterns. Only reached when no waiting/active pattern is
		// present — i.e. the pane is not visibly busy. waitForSettled still gates
		// this behind the stability window before treating it as terminal.
		for (const pattern of characteristics.errorPatterns) {
			if (pattern.test(lastLines)) {
				return {
					status: "error",
					confidence: 0.7,
					detail: "Error pattern detected in output",
				};
			}
		}

		// Check completion patterns (idle prompt — lowest priority so that
		// waiting/active/error signals take precedence when both are present)
		for (const pattern of characteristics.completionPatterns) {
			if (pattern.test(lastLines)) {
				return {
					status: "completed",
					confidence: 0.6,
					detail: "Agent appears to have completed its task",
				};
			}
		}

		return null;
	}

	/** Capture current pane content hash for use as preHash */
	async captureHash(paneTarget: string): Promise<string> {
		const capture = await this.bridge.capturePane(paneTarget, {
			startLine: -this.config.captureLines,
		});
		return createHash("md5").update(capture.content).digest("hex");
	}

	/**
	 * Block until the tmux pane content changes from preHash and stabilizes.
	 * Two-phase model:
	 *   Phase 1: Wait for hash !== preHash (agent started responding)
	 *   Phase 2: Wait for content to stabilize >= stableThresholdMs, then analyze
	 *
	 * Terminal-state discipline (see SD-1):
	 *  - Only `waiting_input` takes the fast escape on a content change. A live
	 *    interactive prompt is unambiguous and time-sensitive.
	 *  - `error` is NOT fast-escaped. A sub-agent quoting "Error: expected 200" in
	 *    its own transcript while still working must not be classified terminal.
	 *    Error is only returned after the content has been stable across the window
	 *    AND no active pattern is currently on screen (corroboration). Ambiguous
	 *    cases (error text present but stability inconclusive) fall through to the
	 *    Layer-2 LLM tiebreaker.
	 *  - `completed` additionally requires evidence the agent actually ran. The idle
	 *    prompt glyph (❯ / ›) is on screen both after real work AND during a slow
	 *    silent startup where the prompt's own echo satisfied Phase 1 but the agent
	 *    never began. So a completion is only accepted once we've observed an
	 *    "active" classification at least once during this wait; if we never saw
	 *    activity, we demand a substantially longer stability window before trusting
	 *    the idle glyph.
	 */
	async waitForSettled(paneTarget: string, taskContext: string, opts: WaitForSettledOptions): Promise<SettledResult> {
		const timeoutMs = opts.timeoutMs ?? 14400000; // 4 hours
		const characteristics = opts.characteristics ?? null;
		const startTime = Date.now();
		let lastChangeTime = Date.now();
		let lastHash = opts.preHash;
		let lastContent = "";
		let phase: 1 | 2 = 1;
		// SD-1b: has an "active" classification ever been observed during this wait?
		// Gates whether a bare idle prompt is trusted as "completed".
		let sawActive = false;
		// SD-3: consecutive capturePane() failures — a killed session must not run
		// the loop out to the 4-hour timeout.
		let consecutiveCaptureFailures = 0;
		// When the agent was never seen active, require a longer stable window before
		// trusting the idle glyph as "completed" (guards the slow-start false positive).
		const noActivityStableThresholdMs = this.config.stableThresholdMs * 3;

		logger.info("state-detector", `waitForSettled: starting Phase 1, preHash=${opts.preHash.slice(0, 8)}`);

		while (true) {
			// Timeout check
			if (Date.now() - startTime >= timeoutMs) {
				logger.info("state-detector", `waitForSettled: timeout after ${timeoutMs}ms`);
				return {
					analysis: { status: "active", confidence: 0, detail: `Timeout after ${timeoutMs}ms` },
					content: lastContent,
					timedOut: true,
				};
			}

			// Abort check
			if (opts.isAborted?.()) {
				logger.info("state-detector", "waitForSettled: aborted");
				return {
					analysis: { status: "unknown", confidence: 0, detail: "Aborted by user" },
					content: lastContent,
					timedOut: false,
				};
			}

			// Wait for poll interval
			await new Promise((resolve) => setTimeout(resolve, this.config.pollIntervalMs));

			// Capture current pane
			try {
				const capture = await this.bridge.capturePane(paneTarget, {
					startLine: -this.config.captureLines,
				});
				consecutiveCaptureFailures = 0;
				const content = capture.content;
				const hash = createHash("md5").update(content).digest("hex");

				if (phase === 1) {
					// Phase 1: Wait for hash to change from preHash
					if (hash !== opts.preHash) {
						lastHash = hash;
						lastChangeTime = Date.now();
						lastContent = content;
						phase = 2;
						if (characteristics && this.matchesActive(content, characteristics)) {
							sawActive = true;
						}
						logger.info("state-detector", "waitForSettled: Phase 1 → Phase 2 (content changed)");
					}
					continue;
				}

				// Phase 2: Wait for content to stabilize
				if (hash !== lastHash) {
					// Content changed — agent is still active
					lastHash = hash;
					lastChangeTime = Date.now();
					lastContent = content;

					// Fast escape: ONLY waiting_input. A live interactive prompt is
					// unambiguous. error/completed must go through the stability window
					// (error can be a quoted string mid-work; the idle glyph can be a
					// slow-start echo), so they are deliberately NOT fast-escaped here.
					const quickResult = this.quickPatternCheck(content, characteristics);
					if (quickResult?.status === "active") {
						sawActive = true;
					}
					if (quickResult?.status === "waiting_input") {
						logger.info("state-detector", "waitForSettled: waiting_input fast escape");
						return { analysis: quickResult, content, timedOut: false };
					}
					continue;
				}

				// Content stable — check duration
				const stableDuration = Date.now() - lastChangeTime;
				if (stableDuration >= this.config.stableThresholdMs) {
					// Stable long enough — analyze
					const quickResult = this.quickPatternCheck(lastContent, characteristics);
					if (quickResult) {
						if (quickResult.status === "active" && quickResult.confidence > 0.7) {
							// Agent appears still active despite stable content — reset and continue
							sawActive = true;
							logger.info("state-detector", "waitForSettled: stable but active pattern detected, continuing");
							lastChangeTime = Date.now();
							continue;
						}

						if (quickResult.status === "error") {
							// SD-1a: require corroboration before a terminal error. quickPatternCheck
							// already suppresses error when a waiting/active pattern is present, and
							// we are here only because the content held stable across the window. If
							// an active pattern is somehow still on screen, defer to Layer 2 rather
							// than declaring failure; otherwise the stable error stands.
							if (characteristics && this.matchesActive(lastContent, characteristics)) {
								logger.info(
									"state-detector",
									"waitForSettled: error pattern but active present — deferring to Layer 2",
								);
							} else {
								logger.info("state-detector", "waitForSettled: settled with stable error pattern");
								return { analysis: quickResult, content: lastContent, timedOut: false };
							}
						} else if (quickResult.status === "completed") {
							// SD-1b: the idle glyph is trustworthy only if the agent was observed
							// active at some point, OR it has held stable for a much longer window
							// (guards the slow-start case where the prompt echo satisfied Phase 1
							// but no work ever ran).
							if (sawActive || stableDuration >= noActivityStableThresholdMs) {
								logger.info("state-detector", "waitForSettled: settled with pattern completed");
								return { analysis: quickResult, content: lastContent, timedOut: false };
							}
							logger.info(
								"state-detector",
								`waitForSettled: idle glyph but no activity seen yet (stable ${stableDuration}ms < ${noActivityStableThresholdMs}ms) — continuing`,
							);
							// Fall through to Layer 2 as a tiebreaker rather than blindly waiting.
						} else {
							// waiting_input or other non-terminal-ambiguous pattern — return.
							logger.info("state-detector", `waitForSettled: settled with pattern ${quickResult.status}`);
							return { analysis: quickResult, content: lastContent, timedOut: false };
						}
					}

					// No decisive pattern match (or a deferred error/unverified completion)
					// — use Layer 2 LLM analysis as the tiebreaker.
					logger.info("state-detector", `waitForSettled: stable for ${stableDuration}ms, triggering Layer 2`);
					const analysis = await this.analyzeState(lastContent, taskContext);

					if (analysis.status === "active" && analysis.confidence > 0.7) {
						// LLM thinks still active — reset and continue
						sawActive = true;
						logger.info("state-detector", "waitForSettled: Layer 2 says active, continuing");
						lastChangeTime = Date.now();
						continue;
					}

					logger.info("state-detector", `waitForSettled: settled with Layer 2 ${analysis.status}`);
					return { analysis, content: lastContent, timedOut: false };
				}
			} catch (err: any) {
				// SD-3: a killed/unreachable pane throws on every capture. Tolerate a few
				// transient failures, but after N consecutive give up so the caller's
				// wake-up fires promptly instead of hanging until the 4-hour timeout.
				consecutiveCaptureFailures++;
				logger.error(
					"state-detector",
					`waitForSettled capture error (${consecutiveCaptureFailures}/${MAX_CONSECUTIVE_CAPTURE_FAILURES}): ${err.message}`,
				);
				if (consecutiveCaptureFailures >= MAX_CONSECUTIVE_CAPTURE_FAILURES) {
					logger.error("state-detector", "waitForSettled: pane unreachable, giving up");
					return {
						analysis: {
							status: "error",
							confidence: 0,
							detail: `pane unreachable (${consecutiveCaptureFailures} consecutive capture failures): ${err.message}`,
						},
						content: lastContent,
						timedOut: false,
					};
				}
			}
		}
	}

	/** Layer 2: LLM-based semantic analysis */
	async analyzeState(paneContent: string, taskContext: string): Promise<PaneAnalysis> {
		try {
			const result = await this.llmClient.completeJson<PaneAnalysis>(
				[
					{
						role: "user",
						content: `Task context: ${taskContext}\n\nCurrent pane content (last ${this.config.captureLines} lines):\n\`\`\`\n${paneContent}\n\`\`\``,
					},
				],
				{
					systemPrompt: this.promptLoader.resolve("state-analyzer"),
					temperature: 0,
				},
			);

			logger.info("state-detector", `Layer 2 analysis: ${result.status} (confidence: ${result.confidence})`);
			return result;
		} catch (err: any) {
			logger.error("state-detector", `Layer 2 analysis failed: ${err.message}`);
			return {
				status: "unknown",
				confidence: 0,
				detail: `Analysis failed: ${err.message}`,
			};
		}
	}

	/** Layer 3: Deep analysis with stronger model */
	async deepAnalyze(
		paneContent: string,
		taskContext: string,
		opts?: { fileChanges?: string; errorHistory?: string[] },
	): Promise<DeepAnalysis> {
		const contextParts = [`Task context: ${taskContext}`, `\nCurrent pane content:\n\`\`\`\n${paneContent}\n\`\`\``];

		if (opts?.fileChanges) {
			contextParts.push(`\nFile changes (git diff):\n\`\`\`\n${opts.fileChanges}\n\`\`\``);
		}

		if (opts?.errorHistory?.length) {
			contextParts.push(`\nPrevious errors:\n${opts.errorHistory.map((e, i) => `${i + 1}. ${e}`).join("\n")}`);
		}

		try {
			const result = await this.llmClient.completeJson<DeepAnalysis>(
				[{ role: "user", content: contextParts.join("\n") }],
				{
					systemPrompt: this.promptLoader.resolve("error-analyzer"),
					temperature: 0,
				},
			);

			logger.info("state-detector", `Layer 3 deep analysis: ${result.status}, replan=${result.shouldReplan}`);
			return result;
		} catch (err: any) {
			logger.error("state-detector", `Layer 3 analysis failed: ${err.message}`);
			return {
				status: "unknown",
				confidence: 0,
				detail: `Deep analysis failed: ${err.message}`,
				shouldReplan: false,
				humanInterventionNeeded: true,
				reason: `Analysis failed: ${err.message}`,
			};
		}
	}

	private emit(analysis: PaneAnalysis, paneContent: string): void {
		for (const cb of this.callbacks) {
			try {
				cb(analysis, paneContent);
			} catch (err: any) {
				logger.error("state-detector", `Callback error: ${err.message}`);
			}
		}
	}
}
