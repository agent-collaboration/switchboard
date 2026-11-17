import {
	createFleetAdminLinkClient,
	fleetAdminRoutePaths,
	runAuthorizationRevisionDrain,
	type CentralTransport,
} from '@agent-collaboration/sign-in-core';
import {
	createOrganizationFleetCallGuard,
	type SignInHttpConfiguration,
} from '@agent-collaboration/sign-in-core/better-auth';
import { z } from 'zod';

import { createManualDeadlines } from '#sign-in-test-support/test-fixtures/manual-deadlines';

const synchronizationScopeSchema = z.discriminatedUnion('kind', [
	z.strictObject({
		kind: z.literal('personInOrganization'),
		organizationId: z.uuidv7(),
		personId: z.uuidv7(),
	}),
	z.strictObject({ kind: z.literal('personEverywhere'), personId: z.uuidv7() }),
	z.strictObject({ kind: z.literal('organization'), organizationId: z.uuidv7() }),
]);

/**
 * D7 proof mode. With a barrier prefix set, each proof drain's renewal send goes out over the
 * real link, then waits at the `hold` barrier `<prefix>:<organizationId>` until the test, having
 * seen central hold that send, releases it; only then does that request's own deadline fire
 * (workerd forbids aborting another request's signal). Central never answers, so only the
 * guard's deadline race can end the wait. Plain data, so it may cross requests.
 */
let renewalDeadlineBarrier: string | null = null;
/**
 * WS7 R-retrysignal proof mode. With this prefix set, the admin client is the production client
 * over an observing transport. The second admin request of one sign-in request (the retry after a
 * recovery) goes out over the real link, waits at the `hold` barrier `<prefix>:<organizationId>`,
 * then fires that request's deadline whether or not the request carries a signal. What the
 * transport received is kept as plain data, readable across requests.
 */
let retryDeadlineBarrier: string | null = null;
const retryTransportObservations: {
	readonly first: string;
	readonly retry: string;
	readonly sameBody: boolean;
}[] = [];

/** Whether proof requests now hold a renewal send or an admin retry at a barrier. */
export function proofRenewalDeadlineActive(): boolean {
	return renewalDeadlineBarrier !== null || retryDeadlineBarrier !== null;
}

function signalState(signal: AbortSignal): string {
	if (!signal.aborted) return 'not-aborted';
	const reason: unknown = signal.reason;
	return `aborted:${reason instanceof Error ? reason.name : 'unnamed'}`;
}

const adminRoutePaths = new Set<string>(Object.values(fleetAdminRoutePaths));

function bodyOrganizationId(body: Uint8Array): string {
	const parsed = z
		.looseObject({ organizationId: z.string() })
		.safeParse(JSON.parse(new TextDecoder().decode(body)));
	return parsed.success ? parsed.data.organizationId : '';
}

/**
 * The link as the production admin client reaches it: the first admin request passes through;
 * the second waits for `onRetry` (the barrier, then the deadline) while central holds it, and
 * both requests' signals and bytes are then recorded.
 */
function observingAdminTransport(
	transport: CentralTransport,
	onRetry: (organizationId: string) => Promise<void>,
): CentralTransport {
	let first: { readonly request: Request; readonly body: Uint8Array } | null = null;
	return {
		async fetch(request): Promise<Response> {
			if (!adminRoutePaths.has(new URL(request.url).pathname)) return transport.fetch(request);
			const body = new Uint8Array(await request.clone().arrayBuffer());
			if (first === null) {
				first = { request, body };
				return transport.fetch(request);
			}
			const reply = transport.fetch(request);
			await onRetry(bodyOrganizationId(body));
			retryTransportObservations.push({
				first: signalState(first.request.signal),
				retry: signalState(request.signal),
				sameBody:
					first.body.length === body.length &&
					first.body.every((byte, index) => byte === body[index]),
			});
			return reply;
		},
	};
}

/**
 * The production configuration with a request-local deadline source and, while a barrier prefix
 * is set, a provisioning client that sends through production, waits at the barrier, then fires
 * that request's deadline. Without a prefix the configuration is returned unchanged.
 */
export function withProofRenewalDeadline(
	production: SignInHttpConfiguration,
	arriveAtBarrier: (key: string, event: unknown) => Promise<void>,
	/** The host's own link transport, under the production admin client (R-retrysignal). */
	transport?: CentralTransport,
): SignInHttpConfiguration {
	const barrierPrefix = renewalDeadlineBarrier;
	const retryPrefix = retryDeadlineBarrier;
	if (barrierPrefix === null && retryPrefix === null) return production;
	const deadlines = createManualDeadlines();
	const centralClient = production.platform.centralClient;
	const observedAdmin =
		retryPrefix === null || transport === undefined
			? null
			: createFleetAdminLinkClient(
					observingAdminTransport(transport, async (organizationId) => {
						await arriveAtBarrier(`${retryPrefix}:${organizationId}`, {
							point: 'retry-in-flight',
						});
						deadlines.fire();
					}),
				);
	return {
		...production,
		platform: {
			...production.platform,
			deadlines: deadlines.deadlines,
			centralClient: {
				...centralClient,
				// The production client sends; the deadline fires once the test releases the barrier.
				...(barrierPrefix === null
					? {}
					: {
							provisionOrganization: async (input) => {
								const answer = centralClient.provisionOrganization(input);
								await arriveAtBarrier(`${barrierPrefix}:${input.organizationId}`, {
									point: 'renewal-in-flight',
								});
								deadlines.fire();
								return answer;
							},
						}),
				...(observedAdmin === null
					? {}
					: {
							sendFleetAdminRequest: observedAdmin.sendFleetAdminRequest,
							relayFleetAdminRequest: observedAdmin.relayFleetAdminRequest,
						}),
			},
		},
	};
}

/**
 * Proof-only controls over production code: run one drain pass (what Node's timer runs), fire
 * its pending renewal deadlines, and read the synchronization status (core read only; the
 * product route waits for the people page).
 */
export async function handleAuthorizationDrainProof(
	request: Request,
	readConfiguration: () => SignInHttpConfiguration,
	arriveAtBarrier: (key: string, event: unknown) => Promise<void>,
): Promise<Response | null> {
	const pathname = new URL(request.url).pathname;
	if (pathname === '/__auth-proof/renewal-deadline' && request.method === 'POST') {
		renewalDeadlineBarrier = z
			.strictObject({ barrierPrefix: z.string().min(1).nullable() })
			.parse(await request.json()).barrierPrefix;
		return Response.json({ barrierPrefix: renewalDeadlineBarrier });
	}
	if (pathname === '/__auth-proof/retry-deadline' && request.method === 'POST') {
		retryDeadlineBarrier = z
			.strictObject({ barrierPrefix: z.string().min(1).nullable() })
			.parse(await request.json()).barrierPrefix;
		retryTransportObservations.length = 0;
		return Response.json({ barrierPrefix: retryDeadlineBarrier });
	}
	if (pathname === '/__auth-proof/retry-signal' && request.method === 'GET')
		return Response.json({ observations: retryTransportObservations });
	if (pathname === '/__auth-proof/organization-fleet-call' && request.method === 'POST') {
		// Exactly the guard run each sign-in to Fleet call makes first (WS3 drain on use).
		const { organizationId } = z
			.strictObject({ organizationId: z.uuidv7() })
			.parse(await request.json());
		const configuration = withProofRenewalDeadline(readConfiguration(), arriveAtBarrier);
		return Response.json(await createOrganizationFleetCallGuard(configuration)(organizationId));
	}
	if (pathname === '/__auth-proof/authorization-drain' && request.method === 'POST') {
		const configuration = withProofRenewalDeadline(readConfiguration(), arriveAtBarrier);
		return Response.json(
			await runAuthorizationRevisionDrain({
				...configuration,
				prepareFleetCall: createOrganizationFleetCallGuard(configuration),
			}),
		);
	}
	if (pathname === '/__auth-proof/authorization-sync' && request.method === 'POST') {
		const scope = synchronizationScopeSchema.parse(await request.json());
		return Response.json(
			await readConfiguration().store.revisionDelivery.readSynchronization(scope),
		);
	}
	return null;
}

/** Owns after-response work so a proof can wait for it on an event, never on time. */
export function createDeferredWorkTracker(): {
	readonly track: (work: Promise<unknown>) => Promise<unknown>;
	readonly settled: () => Promise<void>;
} {
	const pending = new Set<Promise<unknown>>();
	return {
		track(work: Promise<unknown>): Promise<unknown> {
			const owned = work
				.catch((): void => undefined)
				.finally((): void => {
					pending.delete(owned);
				});
			pending.add(owned);
			return owned;
		},
		async settled(): Promise<void> {
			while (pending.size > 0) await Promise.all(pending);
		},
	};
}
