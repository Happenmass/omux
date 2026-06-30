import { type ChildProcess, spawn } from "node:child_process";
import { networkInterfaces, platform } from "node:os";
import { Bonjour } from "bonjour-service";

export interface MdnsHandle {
	/** Hostname being advertised, e.g. "cliclaw.local". */
	hostname: string;
	/** LAN IPv4 addresses we found locally — used for the startup banner. */
	ips: string[];
	/** Which backend was used (for diagnostics). */
	backend: "dns-sd" | "bonjour-service";
	stop: () => Promise<void>;
}

export interface StartMdnsOptions {
	/** Bare name without ".local" suffix. */
	name: string;
	port: number;
}

const NAME_RE = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/i;

/**
 * Interface names whose IPv4 addresses we never advertise: Docker bridges,
 * VPN tunnels, AWDL, virtual machine bridges, etc. Picking one of these as
 * the LAN address is the most common reason "cliclaw.local" resolves locally
 * but is unreachable from other LAN devices.
 */
const VIRTUAL_IFACE_RE = /^(bridge|docker|utun|awdl|llw|anpi|gif|stf|vmnet|vboxnet|tun|tap|veth|virbr|p2p|kube)/i;

export function isValidMdnsName(name: string): boolean {
	return NAME_RE.test(name);
}

export function getLanIPv4(): string[] {
	const ifaces = networkInterfaces();
	const candidates: { name: string; ip: string }[] = [];
	for (const [name, list] of Object.entries(ifaces)) {
		if (!list) continue;
		if (VIRTUAL_IFACE_RE.test(name)) continue;
		for (const info of list) {
			if (info.family === "IPv4" && !info.internal) candidates.push({ name, ip: info.address });
		}
	}
	candidates.sort((a, b) => {
		const score = (n: string): number => (/^(en|eth|wl|wlan)/i.test(n) ? 0 : 1);
		return score(a.name) - score(b.name);
	});
	return candidates.map((c) => c.ip);
}

function startWithDnsSd(opts: StartMdnsOptions, ips: string[]): MdnsHandle | null {
	if (ips.length === 0) return null;
	const hostname = `${opts.name}.local`;
	const procs: ChildProcess[] = [];
	for (const ip of ips) {
		try {
			const proc = spawn(
				"/usr/bin/dns-sd",
				["-P", opts.name, "_http._tcp", "local", String(opts.port), hostname, ip, "app=cliclaw"],
				{ stdio: "ignore", detached: false },
			);
			proc.on("error", () => {
				/* swallow — surface via process exit instead */
			});
			procs.push(proc);
		} catch {
			/* skip this IP, try next */
		}
	}
	if (procs.length === 0) return null;
	return {
		hostname,
		ips,
		backend: "dns-sd",
		stop: async () => {
			for (const proc of procs) {
				try {
					proc.kill("SIGTERM");
				} catch {
					/* best-effort */
				}
			}
		},
	};
}

function startWithBonjour(opts: StartMdnsOptions, ips: string[]): MdnsHandle {
	const hostname = `${opts.name}.local`;
	const bonjour = new Bonjour();
	bonjour.publish({
		name: opts.name,
		type: "http",
		port: opts.port,
		protocol: "tcp",
		host: hostname,
		txt: { app: "cliclaw" },
	});
	return {
		hostname,
		ips,
		backend: "bonjour-service",
		stop: () =>
			new Promise<void>((resolve) => {
				try {
					bonjour.unpublishAll(() => {
						bonjour.destroy();
						resolve();
					});
				} catch {
					resolve();
				}
			}),
	};
}

export function startMdns(opts: StartMdnsOptions): MdnsHandle {
	if (!isValidMdnsName(opts.name)) {
		throw new Error(`Invalid mDNS name "${opts.name}". Must match /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/i.`);
	}
	const ips = getLanIPv4();

	// On macOS, the system mDNSResponder owns UDP/5353 and is the only daemon
	// other LAN devices reliably accept responses from. Delegate publishing
	// to it via the bundled `dns-sd -P` (proxy) command so our advertisement
	// actually propagates beyond loopback.
	if (platform() === "darwin") {
		const handle = startWithDnsSd(opts, ips);
		if (handle) return handle;
	}

	return startWithBonjour(opts, ips);
}

/** True if the two IP sets differ (order-insensitive). */
export function ipsChanged(prev: string[], next: string[]): boolean {
	if (prev.length !== next.length) return true;
	const a = [...prev].sort();
	const b = [...next].sort();
	return a.some((ip, i) => ip !== b[i]);
}

export interface MdnsSupervisor {
	/** The current live advertisement handle, or null if no LAN IPv4 is available yet. */
	getHandle: () => MdnsHandle | null;
	/** Re-publish against freshly-detected LAN IPs. Returns the new handle (or the existing one if no usable IP). */
	rebind: (reason?: string) => Promise<MdnsHandle | null>;
	/** Stop polling and tear down the current advertisement. */
	stop: () => Promise<void>;
}

export interface StartMdnsSupervisorOptions extends StartMdnsOptions {
	/** How often to poll for LAN IP changes. Default 5000ms. */
	pollIntervalMs?: number;
	/** Invoked after every successful re-publish so callers can refresh state / notify clients. */
	onRebind?: (handle: MdnsHandle) => void;
	/** Diagnostic logger. */
	log?: (msg: string) => void;
	/** Test seams — defaults to the real implementations. */
	deps?: {
		startMdns?: (opts: StartMdnsOptions) => MdnsHandle;
		getLanIPv4?: () => string[];
		setInterval?: typeof setInterval;
		clearInterval?: typeof clearInterval;
	};
}

/**
 * Supervises an mDNS advertisement and re-publishes it whenever the host's LAN
 * IPv4 set changes (e.g. after a Wi-Fi reconnect that hands out a new DHCP
 * address). The `dns-sd -P` proxy hard-codes the IP captured at publish time
 * and never self-updates, so without this watcher `<name>.local` keeps pointing
 * at a dead address after any network change until the process restarts.
 *
 * Also exposes `rebind()` for an explicit manual trigger (wired to SIGHUP).
 */
export function startMdnsSupervisor(opts: StartMdnsSupervisorOptions): MdnsSupervisor {
	if (!isValidMdnsName(opts.name)) {
		throw new Error(`Invalid mDNS name "${opts.name}". Must match /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/i.`);
	}
	const pollIntervalMs = opts.pollIntervalMs ?? 5000;
	const log = opts.log ?? (() => {});
	const _startMdns = opts.deps?.startMdns ?? startMdns;
	const _getLanIPv4 = opts.deps?.getLanIPv4 ?? getLanIPv4;
	const _setInterval = opts.deps?.setInterval ?? setInterval;
	const _clearInterval = opts.deps?.clearInterval ?? clearInterval;

	let handle: MdnsHandle | null = null;
	let advertisedIps: string[] = [];
	let rebinding = false;
	// True once the LAN went dark (no IPv4) after we had published. macOS's
	// mDNSResponder drops the `dns-sd -P` proxy registration when the interface
	// goes down, but our `dns-sd` child keeps running — so when the network comes
	// back with the *same* IP, ipsChanged() is false and we'd never re-publish,
	// leaving `<name>.local` silently unresolvable. Force a rebind on recovery.
	let wasDown = false;

	const baseOpts: StartMdnsOptions = { name: opts.name, port: opts.port };

	const publish = (reason: string): MdnsHandle => {
		const next = _startMdns(baseOpts);
		handle = next;
		advertisedIps = next.ips;
		log(`mDNS advertising ${next.hostname} → [${advertisedIps.join(", ")}] (${reason})`);
		opts.onRebind?.(next);
		return next;
	};

	// Initial publish (skip if the host has no usable LAN IPv4 yet — the poller
	// will pick it up once an address appears).
	if (_getLanIPv4().length > 0) {
		try {
			publish("initial");
		} catch (err: any) {
			log(`mDNS initial publish failed (non-fatal): ${err?.message ?? err}`);
		}
	} else {
		log("mDNS deferred: no LAN IPv4 available yet");
	}

	const rebind = async (reason = "manual"): Promise<MdnsHandle | null> => {
		if (rebinding) return handle;
		rebinding = true;
		try {
			const ips = _getLanIPv4();
			if (ips.length === 0) {
				log(`mDNS rebind skipped (${reason}): no LAN IPv4 available`);
				return handle;
			}
			if (handle) {
				try {
					await handle.stop();
				} catch {
					/* best-effort */
				}
				handle = null;
			}
			return publish(reason);
		} finally {
			rebinding = false;
		}
	};

	const timer = _setInterval(() => {
		if (rebinding) return;
		const ips = _getLanIPv4();
		if (ips.length === 0) {
			// Network down — remember it so we re-publish on recovery even if the
			// IP comes back unchanged (the proxy registration was lost meanwhile).
			if (handle !== null) wasDown = true;
			return;
		}
		if (handle === null || wasDown || ipsChanged(advertisedIps, ips)) {
			const reason = wasDown ? "network-recovered" : "ip-change";
			wasDown = false;
			void rebind(reason);
		}
	}, pollIntervalMs);
	// Never hold the event loop open just for this housekeeping poll.
	if (typeof (timer as any).unref === "function") (timer as any).unref();

	return {
		getHandle: () => handle,
		rebind,
		stop: async () => {
			_clearInterval(timer);
			if (handle) {
				try {
					await handle.stop();
				} catch {
					/* best-effort */
				}
				handle = null;
			}
		},
	};
}
