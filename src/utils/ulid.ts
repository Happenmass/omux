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
