import { describe, expect, it, vi } from "vitest";
import {
	ipsChanged,
	isValidMdnsName,
	type MdnsHandle,
	type StartMdnsOptions,
	startMdnsSupervisor,
} from "../../src/server/mdns.js";

function fakeHandle(ips: string[]): MdnsHandle {
	return {
		hostname: "cliclaw.local",
		ips,
		backend: "dns-sd",
		stop: vi.fn(async () => {}),
	};
}

/**
 * Wires up a supervisor with fully injected deps so we can drive the poll loop
 * by hand and observe publish/teardown without touching real timers or dns-sd.
 */
function makeHarness(initialIps: string[]) {
	let currentIps = initialIps;
	const handles: MdnsHandle[] = [];
	let pollCb: (() => void) | null = null;

	const getLanIPv4 = vi.fn(() => currentIps);
	const startMdns = vi.fn((_opts: StartMdnsOptions) => {
		const h = fakeHandle(currentIps);
		handles.push(h);
		return h;
	});
	const setIntervalFn = vi.fn((cb: () => void) => {
		pollCb = cb;
		return { unref: vi.fn() } as any;
	});
	const clearIntervalFn = vi.fn();

	const setIps = (ips: string[]) => {
		currentIps = ips;
	};
	const tick = () => pollCb?.();

	return {
		getLanIPv4,
		startMdns,
		setIntervalFn,
		clearIntervalFn,
		handles,
		setIps,
		tick,
		deps: {
			startMdns,
			getLanIPv4,
			setInterval: setIntervalFn as unknown as typeof setInterval,
			clearInterval: clearIntervalFn as unknown as typeof clearInterval,
		},
	};
}

describe("isValidMdnsName", () => {
	it("accepts simple names and rejects bad ones", () => {
		expect(isValidMdnsName("cliclaw")).toBe(true);
		expect(isValidMdnsName("my-box1")).toBe(true);
		expect(isValidMdnsName("-bad")).toBe(false);
		expect(isValidMdnsName("has space")).toBe(false);
		expect(isValidMdnsName("")).toBe(false);
	});
});

describe("ipsChanged", () => {
	it("is order-insensitive and detects add/remove/replace", () => {
		expect(ipsChanged(["a", "b"], ["b", "a"])).toBe(false);
		expect(ipsChanged([], [])).toBe(false);
		expect(ipsChanged(["a"], ["a", "b"])).toBe(true);
		expect(ipsChanged(["a", "b"], ["a"])).toBe(true);
		expect(ipsChanged(["192.168.1.5"], ["192.168.31.5"])).toBe(true);
	});
});

describe("startMdnsSupervisor", () => {
	it("publishes once on start and reports the handle", () => {
		const h = makeHarness(["192.168.1.10"]);
		const onRebind = vi.fn();
		const sup = startMdnsSupervisor({ name: "cliclaw", port: 3120, onRebind, deps: h.deps });

		expect(h.startMdns).toHaveBeenCalledTimes(1);
		expect(onRebind).toHaveBeenCalledTimes(1);
		expect(sup.getHandle()?.ips).toEqual(["192.168.1.10"]);
	});

	it("defers publishing when no LAN IPv4 is available yet, then publishes when one appears", () => {
		const h = makeHarness([]);
		startMdnsSupervisor({ name: "cliclaw", port: 3120, deps: h.deps });
		expect(h.startMdns).not.toHaveBeenCalled();

		h.setIps(["10.0.0.4"]);
		h.tick();
		expect(h.startMdns).toHaveBeenCalledTimes(1);
	});

	it("re-publishes when the LAN IP changes (the reconnect case)", async () => {
		const h = makeHarness(["192.168.101.93"]);
		const sup = startMdnsSupervisor({ name: "cliclaw", port: 3120, deps: h.deps });
		const firstHandle = h.handles[0];

		// Network reconnect hands out a new subnet.
		h.setIps(["192.168.31.233"]);
		h.tick();
		await Promise.resolve();
		await Promise.resolve();

		expect(firstHandle.stop).toHaveBeenCalledTimes(1); // old advertisement torn down
		expect(h.startMdns).toHaveBeenCalledTimes(2); // re-published
		expect(sup.getHandle()?.ips).toEqual(["192.168.31.233"]);
	});

	it("re-publishes after a network outage even when the IP is unchanged", async () => {
		const h = makeHarness(["192.168.1.10"]);
		const sup = startMdnsSupervisor({ name: "cliclaw", port: 3120, deps: h.deps });
		const firstHandle = h.handles[0];
		expect(h.startMdns).toHaveBeenCalledTimes(1);

		// Network drops: no LAN IPv4 for a couple of polls.
		h.setIps([]);
		h.tick();
		h.tick();
		expect(h.startMdns).toHaveBeenCalledTimes(1); // nothing to do while down

		// Network returns with the SAME address — the dns-sd proxy registration
		// was dropped during the outage, so we must re-publish anyway.
		h.setIps(["192.168.1.10"]);
		h.tick();
		await Promise.resolve();
		await Promise.resolve();

		expect(firstHandle.stop).toHaveBeenCalledTimes(1); // stale advertisement torn down
		expect(h.startMdns).toHaveBeenCalledTimes(2); // re-published on recovery
		expect(sup.getHandle()?.ips).toEqual(["192.168.1.10"]);
	});

	it("does not re-publish when the IP set is unchanged", () => {
		const h = makeHarness(["192.168.1.10"]);
		startMdnsSupervisor({ name: "cliclaw", port: 3120, deps: h.deps });
		h.tick();
		h.tick();
		expect(h.startMdns).toHaveBeenCalledTimes(1);
	});

	it("manual rebind re-publishes against fresh IPs", async () => {
		const h = makeHarness(["192.168.1.10"]);
		const sup = startMdnsSupervisor({ name: "cliclaw", port: 3120, deps: h.deps });

		h.setIps(["192.168.1.50"]);
		await sup.rebind("SIGHUP");

		expect(h.startMdns).toHaveBeenCalledTimes(2);
		expect(sup.getHandle()?.ips).toEqual(["192.168.1.50"]);
	});

	it("manual rebind is a no-op tear-down when no IP is available", async () => {
		const h = makeHarness(["192.168.1.10"]);
		const sup = startMdnsSupervisor({ name: "cliclaw", port: 3120, deps: h.deps });
		const handle = sup.getHandle();

		h.setIps([]);
		await sup.rebind("manual");

		// Keep the (possibly still-valid) handle rather than going dark.
		expect(handle?.stop).not.toHaveBeenCalled();
		expect(sup.getHandle()).toBe(handle);
	});

	it("stop() clears the poll loop and tears down the advertisement", async () => {
		const h = makeHarness(["192.168.1.10"]);
		const sup = startMdnsSupervisor({ name: "cliclaw", port: 3120, deps: h.deps });
		const handle = sup.getHandle();

		await sup.stop();
		expect(h.clearIntervalFn).toHaveBeenCalledTimes(1);
		expect(handle?.stop).toHaveBeenCalledTimes(1);
		expect(sup.getHandle()).toBeNull();
	});

	it("rejects an invalid mDNS name", () => {
		const h = makeHarness(["192.168.1.10"]);
		expect(() => startMdnsSupervisor({ name: "bad name", port: 3120, deps: h.deps })).toThrow();
	});
});
