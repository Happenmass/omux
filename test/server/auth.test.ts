import { describe, expect, it } from "vitest";
import {
	AUTH_COOKIE_NAME,
	buildAuthCookie,
	buildHostAllowlist,
	createServerAuthToken,
	isAuthorized,
	isHostAllowed,
	isLoopbackAddress,
	isOriginAllowed,
	parseCookies,
	timingSafeEqualStr,
} from "../../src/server/auth.js";

describe("timingSafeEqualStr", () => {
	it("returns true for equal strings and false otherwise", () => {
		expect(timingSafeEqualStr("abc", "abc")).toBe(true);
		expect(timingSafeEqualStr("abc", "abd")).toBe(false);
	});

	it("returns false for length mismatch without throwing", () => {
		expect(timingSafeEqualStr("abc", "abcd")).toBe(false);
		expect(timingSafeEqualStr("", "x")).toBe(false);
	});
});

describe("isAuthorized", () => {
	it("accepts only the exact token via cookie", () => {
		const token = createServerAuthToken();
		const cookie = buildAuthCookie(token).split(";")[0]; // "omux_auth=<token>"
		expect(isAuthorized({ cookie }, token)).toBe(true);
		expect(isAuthorized({ cookie }, `${token}x`)).toBe(false);
		expect(isAuthorized({}, token)).toBe(false);
	});

	it("parses the token out of a multi-cookie header", () => {
		const token = "sekret";
		const cookie = `other=1; ${AUTH_COOKIE_NAME}=${token}; foo=bar`;
		expect(parseCookies(cookie)[AUTH_COOKIE_NAME]).toBe(token);
		expect(isAuthorized({ cookie }, token)).toBe(true);
	});
});

describe("isLoopbackAddress", () => {
	it("recognizes IPv4, IPv6, and IPv4-mapped loopback", () => {
		expect(isLoopbackAddress("127.0.0.1")).toBe(true);
		expect(isLoopbackAddress("::1")).toBe(true);
		expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
		expect(isLoopbackAddress("127.5.5.5")).toBe(true);
	});

	it("rejects LAN and undefined addresses", () => {
		expect(isLoopbackAddress("192.168.1.10")).toBe(false);
		expect(isLoopbackAddress("10.0.0.2")).toBe(false);
		expect(isLoopbackAddress(undefined)).toBe(false);
	});
});

describe("buildHostAllowlist / isHostAllowed", () => {
	const allow = buildHostAllowlist({ port: 3120, lanIps: ["192.168.1.42"], mdnsName: "omux" });

	it("allows loopback names, the LAN IP, and <mdnsName>.local with and without port", () => {
		expect(isHostAllowed("localhost", allow)).toBe(true);
		expect(isHostAllowed("localhost:3120", allow)).toBe(true);
		expect(isHostAllowed("127.0.0.1:3120", allow)).toBe(true);
		expect(isHostAllowed("192.168.1.42:3120", allow)).toBe(true);
		expect(isHostAllowed("omux.local:3120", allow)).toBe(true);
		expect(isHostAllowed("omux.local", allow)).toBe(true);
	});

	it("rejects unknown hosts, wrong ports, and a missing Host header (DNS rebinding)", () => {
		expect(isHostAllowed("evil.example.com", allow)).toBe(false);
		expect(isHostAllowed("evil.example.com:3120", allow)).toBe(false);
		expect(isHostAllowed("192.168.1.42:9999", allow)).toBe(false);
		expect(isHostAllowed(undefined, allow)).toBe(false);
	});
});

describe("isOriginAllowed", () => {
	const allow = buildHostAllowlist({ port: 3120, lanIps: ["192.168.1.42"], mdnsName: "omux" });

	it("allows a missing / null Origin (non-browser clients)", () => {
		expect(isOriginAllowed(undefined, allow)).toBe(true);
		expect(isOriginAllowed("", allow)).toBe(true);
		expect(isOriginAllowed("null", allow)).toBe(true);
	});

	it("allows origins whose host is in the allowlist and rejects others", () => {
		expect(isOriginAllowed("http://omux.local:3120", allow)).toBe(true);
		expect(isOriginAllowed("http://192.168.1.42:3120", allow)).toBe(true);
		expect(isOriginAllowed("http://evil.example.com", allow)).toBe(false);
		expect(isOriginAllowed("http://192.168.1.42:9999", allow)).toBe(false);
		expect(isOriginAllowed("not a url", allow)).toBe(false);
	});
});
