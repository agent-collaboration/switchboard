import { decodeJwt } from 'jose';
import { z } from 'zod';

import type { FleetAdminAnswer } from '#sign-in-core/central-link/fleet-admin-client';
import type { SignInPlatform } from '#sign-in-core/contracts/sign-in-platform';
import type { FleetAdminRequest } from '#sign-in-core/organizations/fleet-admin-operation';
import type { RunOrganizationFleetCall } from '#sign-in-core/organizations/organization-fleet-call';
import { organizationIdSchema } from '#sign-in-core/storage/models/sign-in-store';

/**
 * The CLI's relay to central's link-only admin routes. The CLI
 * signs `htu` = `centralPublicOrigin` + central's path, which names central's admin endpoint
 * rather than this hop; central checks it against its own configured origin.
 */
export const fleetAdminRelayRoutes = {
	'/api/auth/organization-admin/v1/create-workspace': 'CreateWorkspace',
	'/api/auth/organization-admin/v1/workspace-lookup': 'WorkspaceLookup',
	'/api/auth/organization-admin/v1/change-records': 'ReadChangeRecords',
} as const satisfies Record<string, FleetAdminRequest['operation']>;
export type FleetAdminRelayRoute = keyof typeof fleetAdminRelayRoutes;

export function isFleetAdminRelayRoute(pathname: string): pathname is FleetAdminRelayRoute {
	return Object.hasOwn(fleetAdminRelayRoutes, pathname);
}

/** Central's closed bodies are small; anything larger never reaches the link. */
const maximumRelayBodyBytes = 16_384;

/**
 * DPoP only: a browser cookie or a Bearer token is refused before anything is sent. The
 * credential, proof and body bytes are forwarded unchanged, and central verifies all three.
 */
export async function relayFleetAdminRequest(props: {
	readonly request: Request;
	readonly route: FleetAdminRelayRoute;
	readonly platform: Pick<SignInPlatform, 'centralClient'>;
	/** B2 renew-on-use: the token's organization passes its guard before the relay (WS7: and is
	 * recovered if a freshly emptied central forgot it). */
	readonly runFleetCall: RunOrganizationFleetCall;
}): Promise<Response> {
	const noStore = { 'cache-control': 'no-store' };
	if (props.request.method !== 'POST' || props.request.headers.has('cookie'))
		return Response.json({ error: 'not-allowed' }, { status: 403, headers: noStore });
	const authorization = props.request.headers.get('authorization');
	const proof = props.request.headers.get('dpop');
	if (authorization === null || !/^DPoP [^\s]+$/u.test(authorization) || proof === null)
		return Response.json(
			{ error: 'dpop-required' },
			{ status: 401, headers: { ...noStore, 'www-authenticate': 'DPoP' } },
		);
	const body = new Uint8Array(await props.request.arrayBuffer());
	if (body.byteLength > maximumRelayBodyBytes)
		return Response.json({ error: 'too-large' }, { status: 413, headers: noStore });
	// D1: the organization comes from sign-in's own token, read only to pick the guard; central
	// still verifies everything. An unreadable token is relayed unguarded and central refuses it.
	const organizationId = relayOrganizationId(authorization);
	// R-retrysignal: only the retry carries the run's deadline to the link.
	const send = async (
		retry: { readonly signal: AbortSignal } | null = null,
	): Promise<FleetAdminAnswer> =>
		props.platform.centralClient.relayFleetAdminRequest({
			operation: fleetAdminRelayRoutes[props.route],
			authorization,
			proof,
			body,
			...(retry === null ? {} : { signal: retry.signal }),
		});
	// Central refuses an unstamped store before it verifies the proof, so a retry may reuse it.
	const run =
		organizationId === null
			? ({ kind: 'sent', answer: await send() } as const)
			: await props.runFleetCall<FleetAdminAnswer>({
					organizationId,
					send,
					answeredUnavailable: (sent) => sent.kind === 'answered-unavailable',
					atDeadline: { kind: 'unknown', reason: 'timeout' },
				});
	if (run.kind === 'held')
		return Response.json({ error: 'central-unavailable' }, { status: 503, headers: noStore });
	const answer = run.answer;
	switch (answer.kind) {
		case 'answered':
			return Response.json(answer.result, { headers: noStore });
		case 'unauthenticated':
			return new Response(null, {
				status: 401,
				headers: { ...noStore, 'www-authenticate': 'DPoP' },
			});
		case 'request-refused':
			return new Response(null, { status: 400, headers: noStore });
		case 'answered-unavailable':
		case 'unknown':
			return Response.json({ error: 'central-unavailable' }, { status: 503, headers: noStore });
		default:
			return unreachableAnswer(answer);
	}
}

const relayTokenOrganizationSchema = z.looseObject({ organization_id: organizationIdSchema });

function relayOrganizationId(authorization: string): z.infer<typeof organizationIdSchema> | null {
	try {
		const claims = relayTokenOrganizationSchema.safeParse(
			decodeJwt(authorization.slice('DPoP '.length)),
		);
		return claims.success ? claims.data.organization_id : null;
	} catch {
		return null;
	}
}

function unreachableAnswer(_answer: never): never {
	throw new Error('Unknown Fleet admin relay answer');
}
