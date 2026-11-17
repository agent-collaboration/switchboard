import { createRemoteJWKSet, customFetch } from 'jose';
import type { WorkerdStructuredLog } from 'miniflare';
import { z } from 'zod';

const failureNameSchema = z.enum(['AbortError', 'TimeoutError']);
const errorShapeSchema = z.object({ name: z.unknown().optional(), cause: z.unknown().optional() });
export const jwksFetchObservationSchema = z.strictObject({
	event: z.literal('auth-proof-jwks-fetch-ended'),
	caller: z.enum([
		'node-owner-person',
		'native-owner-person',
		'direct-test',
		'gateway-management-person',
		'gateway-workspace-agent',
		'gateway-unattributed',
	]),
	ending: z.enum(['normal', 'AbortError', 'TimeoutError', 'other-error']),
	signal: z.enum(['absent', 'active', 'AbortError', 'TimeoutError', 'other-abort']),
	invocationId: z.uuidv7().optional(),
	signalSource: z.literal('fixture-no-signal').optional(),
});
export type JwksFetchObservation = z.infer<typeof jwksFetchObservationSchema>;

function readJwksFetchAbortName(error: unknown): 'AbortError' | 'TimeoutError' | undefined {
	const visited = new Set<unknown>();
	let candidate = error;
	while (candidate !== undefined && !visited.has(candidate)) {
		visited.add(candidate);
		const shape = errorShapeSchema.safeParse(candidate);
		if (!shape.success) return undefined;
		const name = failureNameSchema.safeParse(shape.data.name);
		if (name.success) return name.data;
		candidate = shape.data.cause;
	}
	return undefined;
}

/** Observe the fetch promise, preserving its response/error and all request options. */
export function observeVerifierJwksFetch(props: {
	readonly caller: JwksFetchObservation['caller'];
	readonly fetch: typeof globalThis.fetch;
	readonly observe: (event: JwksFetchObservation) => void;
}): typeof globalThis.fetch {
	return async (input, init): Promise<Response> => {
		const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
		function observe(ending: JwksFetchObservation['ending']): void {
			const event: JwksFetchObservation = {
				event: 'auth-proof-jwks-fetch-ended',
				caller: props.caller,
				ending,
				signal:
					signal === undefined
						? 'absent'
						: signal.aborted
							? (readJwksFetchAbortName(signal.reason) ?? 'other-abort')
							: 'active',
			};
			try {
				props.observe(event);
			} catch {
				// A diagnostic sink cannot replace the observed protocol result.
			}
		}
		try {
			const response = await props.fetch(input, init);
			observe('normal');
			return response;
		} catch (error) {
			observe(readJwksFetchAbortName(error) ?? 'other-error');
			throw error;
		}
	};
}

/** Pinned JOSE URL/init proof calls retain real HTTP but omit the supplied clock deadline. */
export function createClockFreeProofJwksFetch(
	props: Parameters<typeof observeVerifierJwksFetch>[0],
): typeof globalThis.fetch {
	const observedFetch = observeVerifierJwksFetch({
		...props,
		observe: (event) => props.observe({ ...event, signalSource: 'fixture-no-signal' }),
	});
	return async (input, init): Promise<Response> => {
		const { signal: _clockSignal, ...requestOptions } = init ?? {};
		return observedFetch(input, requestOptions);
	};
}

/** The direct verifier keeps JOSE parsing/cache behavior and the real, clock-free HTTP key source. */
export function createObservedProofJwks(url: URL): ReturnType<typeof createRemoteJWKSet> {
	return createRemoteJWKSet(url, {
		[customFetch]: createClockFreeProofJwksFetch({
			caller: 'direct-test',
			fetch: globalThis.fetch,
			observe: (event) => process.stderr.write(`${JSON.stringify(event)}\n`),
		}),
	});
}

/** The runtime stream may carry unrelated logs; only this closed record is retained. */
export function retainJwksFetchStructuredLog(entry: Pick<WorkerdStructuredLog, 'message'>): void {
	try {
		const event = jwksFetchObservationSchema.safeParse(JSON.parse(entry.message));
		if (event.success) process.stderr.write(`${JSON.stringify(event.data)}\n`);
	} catch {
		// Unrelated runtime output is not diagnostic evidence.
	}
}
