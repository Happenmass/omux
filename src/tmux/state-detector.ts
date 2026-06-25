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
	/** Adapter-specific detection patterns for this pane. Falls back to the detector's global set when omitted. */
	characteristics?: AgentCharacteristics | null;
}

export interface SettledResult {
	analysis: PaneAnalysis;
	content: string;
	timedOut: boolean;
}

type StateChangeCallback = (analysis: PaneAnalysis, paneContent: string) => void;

export class StateDetector {
	private config: StateDetectorConfig;
	private bridge: TmuxBridge;
	private llmClient: LLMClient;
	private promptLoader: PromptLoader;
	private characteristics: AgentCharacteristics | null = null;

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

	setCharacteristics(characteristics: AgentCharacteristics): void {
		this.characteristics = characteristics;
	}

	onStateChange(callback: StateChangeCallback): () => void {
		this.callbacks.push(callback);
		return () => {
			const idx = this.callbacks.indexOf(callback);
			if (idx >= 0) this.callbacks.splice(idx, 1);
		};
	}

	startMonitoring(paneTarget: string, taskContext: string): void {
		if (this.monitoring) return;
		this.monitoring = true;
		this.lastHash = null;
		this.lastChangeTime = Date.now();
		this.lastContent = "";

		logger.info("state-detector", `Starting monitoring for ${paneTarget}`);

		this.pollTimer = setInterval(() => {
			this.poll(paneTarget, taskContext).catch((err) => {
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

	private async poll(paneTarget: string, taskContext: string): Promise<void> {
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
				const quickResult = this.quickPatternCheck(content);
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

	/** Layer 1.5: Quick regex-based pattern matching */
	quickPatternCheck(
		content: string,
		characteristics: AgentCharacteristics | null = this.characteristics,
	): PaneAnalysis | null {
		if (!characteristics) return null;

		const lastLines = content.split("\n").slice(-8).join("\n");

		// Check error patterns (highest priority)
		for (const pattern of characteristics.errorPatterns) {
			if (pattern.test(lastLines)) {
				return {
					status: "error",
					confidence: 0.7,
					detail: "Error pattern detected in output",
				};
			}
		}

		// Check waiting patterns (specific interactive prompts)
		for (const pattern of characteristics.waitingPatterns) {
			if (pattern.test(lastLines)) {
				return {
					status: "waiting_input",
					confidence: 0.6,
					detail: "Agent appears to be waiting for input",
				};
			}
		}

		// Check active patterns
		for (const pattern of characteristics.activePatterns) {
			if (pattern.test(lastLines)) {
				return {
					status: "active",
					confidence: 0.8,
					detail: "Agent is actively working",
				};
			}
		}

		// Check completion patterns (idle prompt — lowest priority so that
		// waiting/active signals take precedence when both are present)
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
	 */
	async waitForSettled(paneTarget: string, taskContext: string, opts: WaitForSettledOptions): Promise<SettledResult> {
		const timeoutMs = opts.timeoutMs ?? 1800000; // 30 minutes
		const characteristics = opts.characteristics ?? this.characteristics;
		const startTime = Date.now();
		let lastChangeTime = Date.now();
		let lastHash = opts.preHash;
		let lastContent = "";
		let phase: 1 | 2 = 1;

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
				const content = capture.content;
				const hash = createHash("md5").update(content).digest("hex");

				if (phase === 1) {
					// Phase 1: Wait for hash to change from preHash
					if (hash !== opts.preHash) {
						lastHash = hash;
						lastChangeTime = Date.now();
						lastContent = content;
						phase = 2;
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

					// Fast escape: only for urgent states (error/waiting_input).
					// "completed" must go through the stability window to avoid false positives
					// when the agent is still writing output.
					const quickResult = this.quickPatternCheck(content, characteristics);
					if (quickResult && (quickResult.status === "error" || quickResult.status === "waiting_input")) {
						logger.info("state-detector", `waitForSettled: ${quickResult.status} fast escape`);
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
							logger.info("state-detector", "waitForSettled: stable but active pattern detected, continuing");
							lastChangeTime = Date.now();
							continue;
						}
						// error, waiting_input, completed, etc. — return
						logger.info("state-detector", `waitForSettled: settled with pattern ${quickResult.status}`);
						return { analysis: quickResult, content: lastContent, timedOut: false };
					}

					// No pattern match — use Layer 2 LLM analysis
					logger.info("state-detector", `waitForSettled: stable for ${stableDuration}ms, triggering Layer 2`);
					const analysis = await this.analyzeState(lastContent, taskContext);

					if (analysis.status === "active" && analysis.confidence > 0.7) {
						// LLM thinks still active — reset and continue
						logger.info("state-detector", "waitForSettled: Layer 2 says active, continuing");
						lastChangeTime = Date.now();
						continue;
					}

					logger.info("state-detector", `waitForSettled: settled with Layer 2 ${analysis.status}`);
					return { analysis, content: lastContent, timedOut: false };
				}
			} catch (err: any) {
				logger.error("state-detector", `waitForSettled capture error: ${err.message}`);
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
