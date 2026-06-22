// Small shared helpers for the SWE-bench Pro eval harness.
import net from "node:net";

/** Find a free TCP port on 127.0.0.1. */
export function getFreePort() {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.on("error", reject);
		srv.listen(0, "127.0.0.1", () => {
			const addr = srv.address();
			const port = typeof addr === "object" && addr ? addr.port : 0;
			srv.close(() => resolve(port));
		});
	});
}

/** Resolve true once `host:port` accepts a TCP connection, or false on timeout. */
export function waitForPort(host, port, timeoutMs = 30000) {
	const deadline = Date.now() + timeoutMs;
	return new Promise((resolve) => {
		const tryOnce = () => {
			const sock = net.createConnection({ host, port });
			sock.once("connect", () => {
				sock.destroy();
				resolve(true);
			});
			sock.once("error", () => {
				sock.destroy();
				if (Date.now() >= deadline) resolve(false);
				else setTimeout(tryOnce, 250);
			});
			sock.setTimeout(1000, () => {
				sock.destroy();
				if (Date.now() >= deadline) resolve(false);
				else setTimeout(tryOnce, 250);
			});
		};
		tryOnce();
	});
}

export function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}
