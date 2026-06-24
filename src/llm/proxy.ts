import { ProxyAgent, fetch as undiciFetch } from "undici";

/**
 * Returns a fetch function that routes all requests through the given proxy URL.
 * Uses node:undici's ProxyAgent — no extra packages needed (bundled with Node 18+).
 *
 * Only used by the main-agent LLMClient. Sub-agent processes are unaffected.
 */
export function createProxyFetch(proxyUrl: string): typeof globalThis.fetch {
	const dispatcher = new ProxyAgent(proxyUrl);

	return (input, init?) =>
		undiciFetch(input as Parameters<typeof undiciFetch>[0], {
			...(init as any),
			dispatcher,
		}) as unknown as Promise<Response>;
}
