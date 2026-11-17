import { createSignInHttpHandler } from '@agent-collaboration/sign-in-core/better-auth';
import productionSignInWorker from '@agent-collaboration/sign-in-host-cloudflare';
import {
	signInWorkerConfiguration,
	workerClientAddressHeaders,
} from '@agent-collaboration/sign-in-host-cloudflare/configuration';
import { z } from 'zod';

import { callAuthProofBarrier } from '#sign-in-test-support/test-fixtures/auth-proof-barrier-client';
import {
	authProofRateLimitBindings,
	handleAuthProofLimiterControl,
} from '#sign-in-test-support/test-fixtures/auth-proof-rate-limit-bindings';
import { handleAuthProofTokenRequest } from '#sign-in-test-support/test-fixtures/auth-proof-tokens';
import {
	handleAuthorizationDrainProof,
	proofRenewalDeadlineActive,
	withProofRenewalDeadline,
} from '#sign-in-test-support/test-fixtures/authorization-drain-proof';
import { handleAuthorizationFenceProof } from '#sign-in-test-support/test-fixtures/authorization-fence-proof';
import { handleCaptchaObservationDrain } from '#sign-in-test-support/test-fixtures/captcha-observation-control';
import { handleCaptchaProviderProof } from '#sign-in-test-support/test-fixtures/captcha-provider-proof';
import {
	readControlledWorkerTime,
	setControlledWorkerTime,
} from '#sign-in-test-support/test-fixtures/controlled-worker-date';
import type { DatabaseReadHold } from '#sign-in-test-support/test-fixtures/database-proof-holds';
import { handleFleetAdminClientProof } from '#sign-in-test-support/test-fixtures/fleet-admin-client-proof';
import { readFleetSnapshotProbe } from '#sign-in-test-support/test-fixtures/fleet-snapshot-proof';
import { handleIntrospectionClientFixture } from '#sign-in-test-support/test-fixtures/introspection-client-fixture';
import { withNativeSigningObservation } from '#sign-in-test-support/test-fixtures/native-signature-observer';
import { handleOrganizationKeyChangeProofRequest } from '#sign-in-test-support/test-fixtures/organization-key-change-proof';
import { readOrganizationReadProbe } from '#sign-in-test-support/test-fixtures/organization-read-proof';
import { readPersonConfirmationProbe } from '#sign-in-test-support/test-fixtures/person-confirmation-proof';
import { recordingD1Database } from '#sign-in-test-support/test-fixtures/recording-d1-database';

/** Only __proof routes use a wrapper-built provider. Every sign-in route, including
 * held token races, is served by unchanged production Worker bytes. */
export async function handleAuthProofRequest(
	request: Request,
	incomingBindings: AuthWorkerEnv,
	context: Pick<ExecutionContext, 'waitUntil'>,
): Promise<Response> {
	const bindings = authProofRateLimitBindings(incomingBindings);
	const authorizationFence = await handleAuthorizationFenceProof(
		request,
		() => signInWorkerConfiguration({ ...bindings, DB: recordingD1Database(bindings.DB) }),
		async (key): Promise<void> => {
			await callAuthProofBarrier({
				bindings,
				channel: 'hold',
				operation: 'arrive',
				key,
				event: { point: 'before-authorization-fence-batch' },
			});
		},
	);
	if (authorizationFence !== null) return authorizationFence;
	const fleetAdminClient = await handleFleetAdminClientProof(request, () =>
		signInWorkerConfiguration({ ...bindings, DB: recordingD1Database(bindings.DB) }),
	);
	if (fleetAdminClient !== null) return fleetAdminClient;
	const authorizationDrain = await handleAuthorizationDrainProof(
		request,
		() => signInWorkerConfiguration({ ...bindings, DB: recordingD1Database(bindings.DB) }),
		async (key, event) => {
			await callAuthProofBarrier({ bindings, channel: 'hold', operation: 'arrive', key, event });
		},
	);
	if (authorizationDrain !== null) return authorizationDrain;
	const limiterControl = handleAuthProofLimiterControl(request);
	if (limiterControl !== null) return limiterControl;
	const drain = handleCaptchaObservationDrain(request);
	if (drain !== null) return drain;
	const captchaProof = await handleCaptchaProviderProof(request, bindings);
	if (captchaProof !== null) return captchaProof;
	const introspectionFixture = await handleIntrospectionClientFixture(request, () =>
		signInWorkerConfiguration({ ...bindings, DB: recordingD1Database(bindings.DB) }),
	);
	if (introspectionFixture !== null) return introspectionFixture;
	const negativeControl = await handleAuthProofTokenRequest(request, bindings);
	if (negativeControl !== null) return negativeControl;
	const keyChange = await handleOrganizationKeyChangeProofRequest(request, () =>
		signInWorkerConfiguration({ ...bindings, DB: recordingD1Database(bindings.DB) }),
	);
	if (keyChange !== null) return keyChange;
	let hold: DatabaseReadHold = { kind: 'none' };
	const organizationRead = readOrganizationReadProbe(request);
	if (organizationRead !== null)
		hold = { kind: 'organization-read', bindings, probe: organizationRead };
	const fleetSnapshot = readFleetSnapshotProbe(request);
	if (fleetSnapshot !== null)
		hold = {
			kind: 'fleet-snapshot',
			bindings,
			probe: fleetSnapshot,
			clock: { now: readControlledWorkerTime, advance: setControlledWorkerTime },
		};
	const confirmation = readPersonConfirmationProbe(request);
	if (confirmation !== null)
		hold = {
			kind: 'confirmation',
			bindings,
			probe: confirmation,
			clock: { now: readControlledWorkerTime, advance: setControlledWorkerTime },
		};
	const url = new URL(request.url);
	if (url.pathname === '/api/auth/oauth2/token' && request.method === 'POST') {
		const body = new URLSearchParams(await request.clone().text());
		if (body.get('grant_type') === 'client_credentials') {
			let clientId = body.get('client_id');
			if (clientId === null) {
				const basic = request.headers.get('authorization')?.match(/^Basic ([^\s]+)$/iu)?.[1];
				try {
					clientId = basic === undefined ? null : (atob(basic).split(':')[0] ?? null);
				} catch {
					clientId = null;
				}
			}
			if (clientId !== null && clientId.length > 0) {
				const status = await callAuthProofBarrier({
					bindings,
					channel: 'hold',
					operation: 'status',
					key: clientId,
				});
				if (z.object({ armed: z.boolean() }).parse(await status.json()).armed)
					hold = {
						kind: 'token',
						bindings,
						clientId,
					};
			}
		}
	}
	// D7 host-path proof: while a renewal barrier is set, the relay runs the production handler
	// with the request-local deadline source and the barrier-gated provisioning client.
	if (
		proofRenewalDeadlineActive() &&
		new URL(request.url).pathname.startsWith('/api/auth/organization-admin/')
	)
		return createSignInHttpHandler(
			withProofRenewalDeadline(
				signInWorkerConfiguration({ ...bindings, DB: recordingD1Database(bindings.DB) }),
				async (key, event) => {
					await callAuthProofBarrier({
						bindings,
						channel: 'hold',
						operation: 'arrive',
						key,
						event,
					});
				},
				{ fetch: async (link: Request): Promise<Response> => bindings.CENTRAL.fetch(link) },
			),
			{ deferAfterResponse: (work: Promise<unknown>): void => context.waitUntil(work) },
		)(new Request(request, { headers: workerClientAddressHeaders(request.headers) }));
	const invokeProduction = (): Promise<Response> =>
		productionSignInWorker.fetch(
			request,
			{
				...bindings,
				DB: recordingD1Database(bindings.DB, hold),
			},
			context,
		);
	return hold.kind === 'token'
		? withNativeSigningObservation(hold.clientId, invokeProduction)
		: invokeProduction();
}
