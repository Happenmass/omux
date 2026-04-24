/**
 * Non-spec, ULID-shaped 26-char random identifier generator.
 *
 * Produces strings shaped like ULIDs (10 time chars + 16 random chars using
 * Crockford-like alphabet) for visual compatibility, but is NOT interoperable
 * with real ULID parsers, and does NOT guarantee lexicographic monotonicity
 * within the same millisecond. Used only for internal IDs where strict
 * sortability is not required.
 */
import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export function ulid(): string {
	const time = Date.now();
	let timeStr = "";
	let t = time;
	for (let i = 0; i < 10; i++) {
		timeStr = ALPHABET[t % 32] + timeStr;
		t = Math.floor(t / 32);
	}
	const rand = randomBytes(10);
	let randStr = "";
	for (let i = 0; i < 10; i++) {
		randStr += ALPHABET[rand[i] % 32];
	}
	return timeStr + randStr;
}
