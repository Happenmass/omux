/**
 * Shared timeout / abort plumbing for the streaming HTTP providers.
 *
 * Two independent hazards a hung LLM connection creates:
 *   1. `fetch()` never resolves (server accepts the socket but never responds) — guarded by a
 *      connect-phase timeout (`createConnectTimeout`) whose timer is DISARMED the moment
 *      response headers arrive, so it can never abort a healthy long-running body.
 *   2. `fetch()` resolves but the SSE body then stalls mid-stream (no bytes for a long time) —
 *      guarded by a per-read idle watchdog that cancels the reader if no chunk arrives in time.
 *
 * Node >= 20 (see package.json `engines`), so `AbortSignal.any` is available without a polyfill.
 */

/**
 * Marker on errors that represent a cliclaw-side timeout (connect timeout or SSE idle timeout),
 * as opposed to a caller-initiated abort. Timeouts are transient and retryable; caller aborts
 * are not. `retryable = true` matches the flag `openai-responses.ts` `isRetryableStreamError`
 * gates on, so idle-timeout errors ride the existing stream-level retry loop.
 */
export interface TimeoutError extends Error {
	isTimeout: true;
	retryable: true;
}

export function isTimeoutError(err: unknown): err is TimeoutError {
	return !!err && typeof err === "object" && (err as { isTimeout?: boolean }).isTimeout === true;
}

function makeTimeoutError(message: string): TimeoutError {
	const err = new Error(message) as TimeoutError;
	// Name matches what `AbortSignal.timeout` produces, so a fetch rejection that propagates
	// this error as the abort reason still hits the providers' name-based abort classification.
	err.name = "TimeoutError";
	err.isTimeout = true;
	err.retryable = true;
	return err;
}

/**
 * Handle returned by `createConnectTimeout`: the signal to pass to `fetch()`, plus a `disarm()`
 * the caller MUST invoke as soon as `fetch()` settles (headers received, or the request failed).
 * Disarming clears the connect-timeout timer WITHOUT aborting — the composed signal stays
 * attached to the response body for the caller-abort leg only.
 */
export interface ConnectTimeoutHandle {
	signal: AbortSignal | undefined;
	disarm: () => void;
}

/**
 * Connect-phase timeout scoped to time-to-response-headers ONLY. `AbortSignal.timeout` is
 * deliberately NOT used here: it measures from request start through the ENTIRE body
 * consumption and cannot be disarmed, so it would abort any healthy stream lasting longer than
 * `timeoutMs` in total — and long turns are routine for this orchestrator. Instead a manual
 * AbortController is armed with a timer the caller clears via `disarm()` the moment `fetch()`
 * resolves; body stalls are guarded separately by `readWithIdleTimeout`.
 *
 * A caller abort surfaces as the caller's own `AbortError`; the timeout leg aborts with a
 * retryable `TimeoutError` reason. Downstream code distinguishes the two via
 * `classifyFetchAbort`. `timeoutMs <= 0` disables the timeout leg (caller signal passed
 * through, or undefined when there's no caller signal either).
 */
export function createConnectTimeout(callerSignal: AbortSignal | undefined, timeoutMs: number): ConnectTimeoutHandle {
	if (timeoutMs <= 0) return { signal: callerSignal, disarm: () => {} };
	const controller = new AbortController();
	const timer = setTimeout(() => {
		controller.abort(makeTimeoutError("connect timeout — no response headers from server"));
	}, timeoutMs);
	// A pending watchdog must not keep the process alive.
	timer.unref?.();
	const signal = callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal;
	return { signal, disarm: () => clearTimeout(timer) };
}

/**
 * When a connect-timeout-composed fetch throws an AbortError/TimeoutError, decide whether it was
 * the caller aborting (rethrow the original — non-retryable) or our own connect timeout firing
 * (convert to a retryable TimeoutError). `callerSignal?.aborted` is the discriminator: if the
 * caller's own signal is aborted, it was the caller; otherwise the timeout leg fired.
 */
export function classifyFetchAbort(err: unknown, callerSignal: AbortSignal | undefined, providerName: string): Error {
	const e = err as Error;
	// Caller explicitly aborted — surface the original AbortError untouched (non-retryable).
	if (callerSignal?.aborted) return e;
	// Otherwise the timeout leg fired (connect-timeout TimeoutError reason, or a bare AbortError
	// with no caller abort behind it). Treat as a retryable connect timeout.
	return makeTimeoutError(`[${providerName}] connect/response timeout — no response from server`);
}

/**
 * Wrap a `ReadableStreamDefaultReader.read()` with a per-read idle watchdog. If no chunk arrives
 * within `idleMs`, the reader is cancelled and a retryable `TimeoutError` is thrown. The timer is
 * created fresh per read (the caller resets it every time by calling this again), so it measures
 * the gap BETWEEN chunks — a stream producing steady output never trips it.
 *
 * `idleMs <= 0` disables the watchdog (plain `reader.read()`).
 */
export async function readWithIdleTimeout<T>(
	reader: ReadableStreamDefaultReader<T>,
	idleMs: number,
	providerName: string,
): Promise<Awaited<ReturnType<ReadableStreamDefaultReader<T>["read"]>>> {
	if (idleMs <= 0) return reader.read();

	let timer: ReturnType<typeof setTimeout> | undefined;
	let timedOut = false;
	const idle = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			timedOut = true;
			// Cancel the underlying stream so the socket is released. This also resolves the
			// pending `reader.read()` with `{done:true}` — which is why the read side below
			// re-checks `timedOut` and rethrows: a cancel-induced `done` must NOT be mistaken
			// for a clean end-of-stream. `.catch` keeps an errored cancel from producing an
			// unhandled rejection.
			reader.cancel(new Error("idle timeout")).catch(() => {});
			reject(makeTimeoutError(`[${providerName}] stream idle timeout — no data for ${idleMs}ms`));
		}, idleMs);
	});
	try {
		const result = await Promise.race([
			reader.read().then((r) => {
				// If the watchdog already fired, this `done` is an artifact of `reader.cancel()`,
				// not a genuine end-of-stream. Surface the timeout so the caller retries instead
				// of accepting a silently-truncated stream.
				if (timedOut) throw makeTimeoutError(`[${providerName}] stream idle timeout — no data for ${idleMs}ms`);
				return r;
			}),
			idle,
		]);
		return result;
	} finally {
		if (timer) clearTimeout(timer);
	}
}
