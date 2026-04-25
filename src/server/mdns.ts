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
