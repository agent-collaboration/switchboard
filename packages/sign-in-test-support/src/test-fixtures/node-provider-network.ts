import { AsyncLocalStorage } from 'node:async_hooks';

type ProviderResponder = (request: Request) => Promise<Response>;
interface ProviderNetwork {
	readonly respond: ProviderResponder;
	readonly additionalUrls: readonly string[];
}
const responders = new AsyncLocalStorage<ProviderNetwork>();
const nativeFetch = globalThis.fetch;

// Only external provider I/O is controlled. Concurrent Node hosts keep separate
// provider fixtures through the invocation's async context.
globalThis.fetch = async (
	input: Parameters<typeof fetch>[0],
	init?: RequestInit,
): Promise<Response> => {
	const url = new URL(
		typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
	);
	const responder = responders.getStore();
	return responder !== undefined &&
		(['oauth2.googleapis.com', 'www.googleapis.com', 'github.com', 'api.github.com'].includes(
			url.hostname,
		) ||
			responder.additionalUrls.includes(url.href))
		? responders.exit(() => responder.respond(new Request(input, init)))
		: nativeFetch(input, init);
};

export function withNodeProviderNetwork<TValue>(
	responder: ProviderResponder,
	operation: () => Promise<TValue>,
	additionalUrls: readonly string[] = [],
): Promise<TValue> {
	return responders.run({ respond: responder, additionalUrls }, operation);
}
