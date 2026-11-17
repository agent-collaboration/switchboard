import { Response as WorkerResponse, type V4FetchHandler } from 'miniflare';
import { z } from 'zod';

import type { createAuthProofBarrierServer } from '#sign-in-test-support/test-fixtures/auth-proof-barrier-server';

type SiteVerifyTransportFailure = 'connection-refused' | 'unexpected-transport-error';
const connectionRefusalSchema = z.object({ cause: z.object({ code: z.literal('ECONNREFUSED') }) });

/** Preserve the incoming protocol request when crossing the test's native HTTP boundary. */
export async function fetchAuthProofOutbound(request: {
	readonly url: string;
	readonly method: string;
	readonly headers: Iterable<readonly [string, string]>;
	readonly text: () => Promise<string>;
	readonly signal: AbortSignal;
}): Promise<Response> {
	return fetch(request.url, {
		method: request.method,
		headers: Object.fromEntries(request.headers),
		...(['GET', 'HEAD'].includes(request.method) ? {} : { body: await request.text() }),
		redirect: 'manual',
		signal: request.signal,
	});
}

/** Routes only external protocols and existing test controls. Production auth
 * code still owns every captcha call, header and response decision. */
export function createAuthProofOutbound(props: {
	readonly issuer: string;
	readonly upstreamOrigin: string;
	readonly siteVerifyURL: string;
	readonly nodeOrigin?: string;
	readonly provider: { readonly fetch: V4FetchHandler };
	readonly barriers: ReturnType<typeof createAuthProofBarrierServer>;
}): {
	readonly fetch: V4FetchHandler;
	readonly siteVerifyAttempts: () => number;
	readonly transportFailures: () => readonly SiteVerifyTransportFailure[];
} {
	let siteVerifyAttempts = 0;
	const transportFailures: SiteVerifyTransportFailure[] = [];
	return {
		siteVerifyAttempts: (): number => siteVerifyAttempts,
		transportFailures: (): readonly SiteVerifyTransportFailure[] => transportFailures.slice(),
		async fetch(
			request: Parameters<V4FetchHandler>[0],
			runtime: Parameters<V4FetchHandler>[1],
		): Promise<WorkerResponse> {
			const destination = new URL(request.url);
			const siteVerify = destination.href === props.siteVerifyURL;
			if (siteVerify) siteVerifyAttempts += 1;
			if (
				destination.origin !== props.issuer &&
				destination.origin !== props.upstreamOrigin &&
				destination.origin !== props.nodeOrigin &&
				!siteVerify
			)
				return props.provider.fetch(request, runtime);
			const barrierResponse =
				destination.origin === props.issuer &&
				destination.pathname === '/__auth-proof/management-hold/arrive'
					? await props.barriers.handle(
							`${destination.pathname}${destination.search}`,
							request.method,
							await request.text(),
						)
					: null;
			try {
				const response = barrierResponse ?? (await fetchAuthProofOutbound(request));
				return new WorkerResponse(response.status === 204 ? null : await response.arrayBuffer(), {
					status: response.status,
					headers: Object.fromEntries(response.headers),
				});
			} catch (error) {
				if (siteVerify)
					transportFailures.push(
						connectionRefusalSchema.safeParse(error).success
							? 'connection-refused'
							: 'unexpected-transport-error',
					);
				// This is the deliberately exercised external transport failure.
				throw error;
			}
		},
	};
}
