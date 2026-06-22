// Tiny authenticated GET helper for cliclaw's REST API.
import http from "node:http";

export function httpGetJson(baseUrl, cookie, path) {
	return new Promise((resolve, reject) => {
		const req = http.get(`${baseUrl}${path}`, { headers: { Cookie: cookie } }, (res) => {
			let body = "";
			res.on("data", (c) => {
				body += c;
			});
			res.on("end", () => {
				try {
					resolve(JSON.parse(body));
				} catch (e) {
					reject(new Error(`Bad JSON from ${path}: ${e.message}`));
				}
			});
		});
		req.on("error", reject);
		req.setTimeout(5000, () => req.destroy(new Error(`GET ${path} timeout`)));
	});
}
