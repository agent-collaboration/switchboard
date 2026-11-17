import { z } from 'zod';

export interface GatewayProofJwksContext {
	readonly caller: 'gateway-management-person' | 'gateway-workspace-agent';
	readonly jwksUrl: unknown;
}
const errorShapeSchema = z.object({ name: z.unknown().optional(), cause: z.unknown().optional() });
const abortNameSchema = z.enum(['AbortError', 'TimeoutError']);

function readGatewayAbortName(error: unknown): 'AbortError' | 'TimeoutError' | undefined {
	const visited = new Set<unknown>();
	let candidate = error;
	while (candidate !== undefined && !visited.has(candidate)) {
		visited.add(candidate);
		const parsed = errorShapeSchema.safeParse(candidate);
		if (!parsed.success) return undefined;
		const name = abortNameSchema.safeParse(parsed.data.name);
		if (name.success) return name.data;
		candidate = parsed.data.cause;
	}
	return undefined;
}

/** Only the fixture's scoped issuer JWKS call omits JOSE's clock deadline. */
export function createGatewayProofJwksFetch(props: {
	readonly fetch: typeof globalThis.fetch;
	readonly context: () => GatewayProofJwksContext | undefined;
	readonly observe: (event: {
		readonly event: 'auth-proof-jwks-fetch-ended';
		readonly caller: GatewayProofJwksContext['caller'];
		readonly ending: 'normal' | 'AbortError' | 'TimeoutError' | 'other-error';
		readonly signal: 'absent' | 'active' | 'AbortError' | 'TimeoutError' | 'other-abort';
		readonly signalSource: 'fixture-no-signal';
	}) => void;
}): typeof globalThis.fetch {
	const nativeFetch = props.fetch;
	return async (input, init): Promise<Response> => {
		const context = props.context();
		const url = new URL(
			typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
		);
		const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
		if (context === undefined || method !== 'GET') return nativeFetch(input, init);
		const configuredJwksUrl = z.url().safeParse(context.jwksUrl);
		if (!configuredJwksUrl.success || url.href !== new URL(configuredJwksUrl.data).href)
			return nativeFetch(input, init);
		let ending: 'normal' | 'AbortError' | 'TimeoutError' | 'other-error' = 'normal';
		try {
			const { signal: _clockSignal, ...requestOptions } = init ?? {};
			return await nativeFetch(input, requestOptions);
		} catch (error) {
			ending = readGatewayAbortName(error) ?? 'other-error';
			throw error;
		} finally {
			try {
				props.observe({
					event: 'auth-proof-jwks-fetch-ended',
					caller: context.caller,
					ending,
					signal: 'absent',
					signalSource: 'fixture-no-signal',
				});
			} catch {
				// Diagnostics cannot replace a protocol result.
			}
		}
	};
}
