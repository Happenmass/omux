import { describe, expect, it } from "vitest";
import {
	classifyFetchAbort,
	createConnectTimeout,
	isTimeoutError,
	readWithIdleTimeout,
} from "../../src/llm/providers/stream-timeout.js";

// ─── createConnectTimeout ────────────────────────────────────────────────────────────

describe("createConnectTimeout", () => {
	it("returns undefined signal and a no-op disarm when no caller signal and no timeout", () => {
		const handle = createConnectTimeout(undefined, 0);
		expect(handle.signal).toBeUndefined();
		expect(() => handle.disarm()).not.toThrow();
	});

	it("returns the caller signal untouched when timeout is disabled", () => {
		const ac = new AbortController();
		expect(createConnectTimeout(ac.signal, 0).signal).toBe(ac.signal);
	});

	it("aborts with a retryable TimeoutError reason after the given ms when NOT disarmed", async () => {
		const handle = createConnectTimeout(undefined, 20);
		const sig = handle.signal!;
		expect(sig).toBeInstanceOf(AbortSignal);
		expect(sig.aborted).toBe(false);
		await new Promise((r) => setTimeout(r, 40));
		expect(sig.aborted).toBe(true);
		expect(isTimeoutError(sig.reason)).toBe(true);
	});

	it("disarm() clears the timer — the signal never fires once headers have arrived", async () => {
		const handle = createConnectTimeout(undefined, 20);
		handle.disarm();
		await new Promise((r) => setTimeout(r, 40));
		expect(handle.signal!.aborted).toBe(false);
	});

	it("caller abort still propagates through the composed signal after disarm", () => {
		const ac = new AbortController();
		const handle = createConnectTimeout(ac.signal, 10_000);
		handle.disarm();
		ac.abort();
		expect(handle.signal!.aborted).toBe(true);
	});
});

// ─── classifyFetchAbort ──────────────────────────────────────────────────────────────

describe("classifyFetchAbort", () => {
	it("rethrows the original error when the CALLER's signal is aborted (non-retryable)", () => {
		const ac = new AbortController();
		ac.abort();
		const orig = Object.assign(new Error("aborted"), { name: "AbortError" });
		const out = classifyFetchAbort(orig, ac.signal, "prov");
		expect(out).toBe(orig);
		expect(isTimeoutError(out)).toBe(false);
	});

	it("converts to a retryable TimeoutError when the caller did NOT abort (timeout leg fired)", () => {
		const orig = Object.assign(new Error("timed out"), { name: "TimeoutError" });
		const out = classifyFetchAbort(orig, undefined, "prov");
		expect(isTimeoutError(out)).toBe(true);
		expect((out as any).retryable).toBe(true);
		expect(out.message).toMatch(/timeout/i);
	});
});

// ─── readWithIdleTimeout ─────────────────────────────────────────────────────────────

describe("readWithIdleTimeout", () => {
	function streamThatHangsAfter(chunks: string[]): ReadableStream<Uint8Array> {
		const encoder = new TextEncoder();
		return new ReadableStream<Uint8Array>({
			start(controller) {
				for (const c of chunks) controller.enqueue(encoder.encode(c));
				// never closed — reads past the buffered chunks pend forever
			},
		});
	}

	it("returns buffered chunks without tripping the watchdog", async () => {
		const reader = streamThatHangsAfter(["hello"]).getReader();
		const r = await readWithIdleTimeout(reader, 100, "prov");
		expect(r.done).toBe(false);
		expect(new TextDecoder().decode(r.value)).toBe("hello");
	});

	it("throws a retryable TimeoutError when no data arrives within idleMs", async () => {
		const reader = streamThatHangsAfter(["hello"]).getReader();
		// First read drains the buffered chunk.
		await readWithIdleTimeout(reader, 40, "prov");
		// Second read stalls — the watchdog must fire and NOT return a cancel-induced {done:true}.
		let thrown: any;
		try {
			await readWithIdleTimeout(reader, 40, "prov");
		} catch (err) {
			thrown = err;
		}
		expect(isTimeoutError(thrown)).toBe(true);
		expect(thrown.retryable).toBe(true);
		expect(thrown.message).toMatch(/idle timeout/i);
	});

	it("is a no-op passthrough when idleMs <= 0", async () => {
		const reader = streamThatHangsAfter(["x"]).getReader();
		const r = await readWithIdleTimeout(reader, 0, "prov");
		expect(r.done).toBe(false);
	});
});
