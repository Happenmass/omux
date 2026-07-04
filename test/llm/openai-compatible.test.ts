import { describe, expect, it } from "vitest";
import { OpenAICompatibleProvider } from "../../src/llm/providers/openai-compatible.js";
import type { ProviderConfig } from "../../src/llm/types.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────────────

const CONFIG: ProviderConfig = {
	name: "test-oai",
	displayName: "Test OpenAI-compatible",
	protocol: "openai-compatible",
	baseUrl: "https://example.invalid/v1",
	apiKeyEnvVar: "TEST_API_KEY",
	defaultModel: "gpt-test",
};

function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const c of chunks) controller.enqueue(encoder.encode(c));
			controller.close();
		},
	});
}

/** A ReadableStream that emits the given chunks then hangs forever (never closes). */
function hangingStream(chunks: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const c of chunks) controller.enqueue(encoder.encode(c));
			// Intentionally never call controller.close() — the reader stalls waiting for more.
		},
	});
}

function delta(obj: any): string {
	return `data: ${JSON.stringify(obj)}\n\n`;
}

// ─── LLM-2: silent stream truncation ─────────────────────────────────────────────────

describe("OpenAICompatibleProvider — truncation detection (LLM-2)", () => {
	it("throws a retryable error when the stream ends without a [DONE] marker", async () => {
		const provider = new OpenAICompatibleProvider(CONFIG, { apiKey: "sk-test", maxRetries: 0 });
		// Stream drops after partial text — no `data: [DONE]`.
		(provider as any).fetchWithRetry = async () =>
			new Response(
				sseStream([
					delta({ choices: [{ delta: { content: "partial " } }] }),
					delta({ choices: [{ delta: { content: "text" } }] }),
				]),
				{ headers: { "Content-Type": "text/event-stream" } },
			);

		let thrown: any;
		const events: any[] = [];
		try {
			for await (const ev of provider.stream([{ role: "user", content: "hi" }])) {
				events.push(ev);
			}
		} catch (err) {
			thrown = err;
		}

		expect(thrown).toBeTruthy();
		expect(String(thrown.message)).toMatch(/truncated|\[DONE\]/i);
		expect(thrown.retryable).toBe(true);
		// It must NOT have yielded a `done` event (that would look like a clean finish).
		expect(events.some((e) => e.type === "done")).toBe(false);
	});

	it("completes normally (yields done, no throw) when [DONE] is present", async () => {
		const provider = new OpenAICompatibleProvider(CONFIG, { apiKey: "sk-test", maxRetries: 0 });
		(provider as any).fetchWithRetry = async () =>
			new Response(
				sseStream([
					delta({ choices: [{ delta: { content: "all good" }, finish_reason: "stop" }] }),
					"data: [DONE]\n\n",
				]),
				{ headers: { "Content-Type": "text/event-stream" } },
			);

		const events: any[] = [];
		for await (const ev of provider.stream([{ role: "user", content: "hi" }])) {
			events.push(ev);
		}

		const done = events.at(-1);
		expect(done.type).toBe("done");
		expect(done.response.content).toBe("all good");
	});
});

// ─── LLM-1: SSE idle watchdog ────────────────────────────────────────────────────────

describe("OpenAICompatibleProvider — idle watchdog (LLM-1)", () => {
	it("throws a retryable timeout when the stream stalls mid-flight", async () => {
		// Short idle timeout so the test is fast.
		const provider = new OpenAICompatibleProvider(CONFIG, { apiKey: "sk-test", maxRetries: 0, timeout: 50 });
		(provider as any).fetchWithRetry = async () =>
			new Response(hangingStream([delta({ choices: [{ delta: { content: "partial" } }] })]), {
				headers: { "Content-Type": "text/event-stream" },
			});

		let thrown: any;
		try {
			for await (const _ev of provider.stream([{ role: "user", content: "hi" }])) {
				// drain
			}
		} catch (err) {
			thrown = err;
		}

		expect(thrown).toBeTruthy();
		expect(String(thrown.message)).toMatch(/idle timeout/i);
		expect(thrown.retryable).toBe(true);
	});
});

// ─── LLM-1: connect timeout in fetchWithRetry ────────────────────────────────────────

describe("OpenAICompatibleProvider — connect timeout (LLM-1)", () => {
	it("aborts a hung fetch via the composed timeout signal and retries", async () => {
		const provider = new OpenAICompatibleProvider(CONFIG, { apiKey: "sk-test", maxRetries: 1, timeout: 40 });

		let calls = 0;
		// Fetch that hangs until its abort signal fires, then rejects like undici does.
		(provider as any).fetch = (_url: string, init: any) => {
			calls++;
			return new Promise((_resolve, reject) => {
				const sig: AbortSignal | undefined = init?.signal;
				if (sig) {
					sig.addEventListener("abort", () => {
						const e = new Error("aborted") as any;
						e.name = "AbortError";
						reject(e);
					});
				}
			});
		};

		let thrown: any;
		try {
			// complete() drives fetchWithRetry directly.
			await provider.complete([{ role: "user", content: "hi" }]);
		} catch (err) {
			thrown = err;
		}

		// The connect timeout fired; because maxRetries=1, it attempted twice then surfaced.
		expect(calls).toBe(2);
		expect(thrown).toBeTruthy();
		expect(String(thrown.message)).toMatch(/timeout/i);
	});

	it("a healthy stream running longer than `timeout` total (but never idle) completes without error", async () => {
		// Regression: the connect timeout must be scoped to time-to-response-headers only.
		// An overall AbortSignal.timeout would kill this stream mid-flight (~200ms total vs
		// timeout=100ms) even though data flows steadily every 25ms.
		const provider = new OpenAICompatibleProvider(CONFIG, { apiKey: "sk-test", maxRetries: 0, timeout: 100 });

		const chunks = [
			...Array.from({ length: 8 }, (_, i) => delta({ choices: [{ delta: { content: `c${i} ` } }] })),
			delta({ choices: [{ delta: {}, finish_reason: "stop" }] }),
			"data: [DONE]\n\n",
		];
		(provider as any).fetch = async (_url: string, init: any) => {
			const sig: AbortSignal | undefined = init?.signal;
			const encoder = new TextEncoder();
			const body = new ReadableStream<Uint8Array>({
				async start(controller) {
					for (const c of chunks) {
						await new Promise((r) => setTimeout(r, 25));
						// Simulate undici: an aborted request signal errors the body mid-stream.
						if (sig?.aborted) {
							controller.error(sig.reason ?? new Error("aborted"));
							return;
						}
						controller.enqueue(encoder.encode(c));
					}
					controller.close();
				},
			});
			return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
		};

		const events: any[] = [];
		for await (const ev of provider.stream([{ role: "user", content: "hi" }])) {
			events.push(ev);
		}

		const done = events.at(-1);
		expect(done.type).toBe("done");
		expect(done.response.content).toBe("c0 c1 c2 c3 c4 c5 c6 c7 ");
	});

	it("propagates a caller abort without converting it to a timeout", async () => {
		const provider = new OpenAICompatibleProvider(CONFIG, { apiKey: "sk-test", maxRetries: 3, timeout: 10_000 });

		const controller = new AbortController();
		(provider as any).fetch = (_url: string, init: any) => {
			return new Promise((_resolve, reject) => {
				const sig: AbortSignal | undefined = init?.signal;
				const abort = () => {
					const e = new Error("aborted") as any;
					e.name = "AbortError";
					reject(e);
				};
				// Handle both already-aborted and future-abort (composed signal aborts synchronously
				// when the caller's leg is already aborted).
				if (sig?.aborted) abort();
				else sig?.addEventListener("abort", abort);
			});
		};

		// Abort right away from the caller side.
		controller.abort();

		let thrown: any;
		try {
			await provider.complete([{ role: "user", content: "hi" }], { signal: controller.signal });
		} catch (err) {
			thrown = err;
		}

		expect(thrown).toBeTruthy();
		expect(thrown.name).toBe("AbortError");
		// Caller abort is NOT a timeout — must not be tagged retryable/isTimeout.
		expect(thrown.isTimeout).toBeUndefined();
	});
});
