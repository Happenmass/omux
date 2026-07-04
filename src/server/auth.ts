import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

export const AUTH_COOKIE_NAME = "omux_auth";

/** Query-string parameter carrying the pairing token in the printed access URL. */
export const AUTH_QUERY_PARAM = "token";

export function createServerAuthToken(): string {
	return randomBytes(24).toString("base64url");
}

export function buildAuthCookie(token: string): string {
	return `${AUTH_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict`;
}

/** Constant-time string comparison to avoid leaking the token via response timing. */
export function timingSafeEqualStr(a: string, b: string): boolean {
	const bufA = Buffer.from(a);
	const bufB = Buffer.from(b);
	if (bufA.length !== bufB.length) return false;
	return timingSafeEqual(bufA, bufB);
}

/**
 * True when the request originates from the loopback interface. Localhost users are
 * paired implicitly (no token needed) to preserve the single-machine UX. `req.socket`
 * addresses may be IPv6-mapped IPv4 (`::ffff:127.0.0.1`).
 */
export function isLoopbackAddress(remoteAddress: string | undefined): boolean {
	if (!remoteAddress) return false;
	return (
		remoteAddress === "127.0.0.1" ||
		remoteAddress === "::1" ||
		remoteAddress === "::ffff:127.0.0.1" ||
		remoteAddress.startsWith("127.")
	);
}

export function parseCookies(cookieHeader: string | undefined): Record<string, string> {
	if (!cookieHeader) return {};

	const pairs = cookieHeader.split(";");
	const cookies: Record<string, string> = {};
	for (const pair of pairs) {
		const trimmed = pair.trim();
		if (!trimmed) continue;
		const eqIdx = trimmed.indexOf("=");
		if (eqIdx <= 0) continue;
		const key = trimmed.slice(0, eqIdx).trim();
		const value = trimmed.slice(eqIdx + 1).trim();
		cookies[key] = decodeURIComponent(value);
	}
	return cookies;
}

export function isAuthorized(headers: IncomingHttpHeaders, expectedToken: string): boolean {
	const cookies = parseCookies(headers.cookie);
	const token = cookies[AUTH_COOKIE_NAME];
	if (typeof token !== "string") return false;
	return timingSafeEqualStr(token, expectedToken);
}

/**
 * Build the set of host authorities (host[:port]) the server will accept in the
 * Host / Origin headers. Anything else is a likely DNS-rebinding attempt: a malicious
 * page that rebinds its hostname to our LAN IP could otherwise pull the auth cookie and
 * open an authorized WebSocket. The allowlist covers loopback names, the machine's LAN
 * IPv4(s), and the advertised `<mdnsName>.local`, each with and without the port.
 */
export function buildHostAllowlist(opts: { port: number; lanIps?: string[]; mdnsName?: string }): Set<string> {
	const { port, lanIps = [], mdnsName } = opts;
	const hosts = new Set<string>();
	const bareHosts = ["localhost", "127.0.0.1", "[::1]", "::1", ...lanIps];
	if (mdnsName) bareHosts.push(`${mdnsName}.local`);
	for (const host of bareHosts) {
		hosts.add(host);
		hosts.add(`${host}:${port}`);
	}
	return hosts;
}

/** Extract the host authority (`host[:port]`) from a Host header or an Origin URL. */
function hostFromValue(value: string, isOrigin: boolean): string | null {
	if (!value) return null;
	if (isOrigin) {
		try {
			return new URL(value).host;
		} catch {
			return null;
		}
	}
	return value;
}

/**
 * Validate a Host header against the allowlist. A missing Host is rejected (HTTP/1.1
 * requires it; anything without one is abnormal).
 */
export function isHostAllowed(hostHeader: string | undefined, allowlist: Set<string>): boolean {
	if (typeof hostHeader !== "string") return false;
	const host = hostFromValue(hostHeader.trim(), false);
	return host !== null && allowlist.has(host);
}

/**
 * Validate a WebSocket-upgrade Origin against the allowlist. A missing Origin is allowed
 * (non-browser clients like the test harness and native sockets omit it); a present but
 * unlisted Origin is rejected.
 */
export function isOriginAllowed(originHeader: string | undefined, allowlist: Set<string>): boolean {
	if (typeof originHeader !== "string" || originHeader === "" || originHeader === "null") return true;
	const host = hostFromValue(originHeader.trim(), true);
	return host !== null && allowlist.has(host);
}
