import { mock } from 'node:test';

import { recordAuthProofPhase } from '#sign-in-test-support/test-fixtures/auth-proof-phase-recording';
import { controlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-sign-in-clock';
import { createClockFreeProofJwksFetch } from '#sign-in-test-support/test-fixtures/jwks-fetch-observation';
import { readNativeOwnerCliProfile } from '#sign-in-test-support/test-fixtures/native-owner-cli-profile';

const profile = await readNativeOwnerCliProfile();
// Only the test child preloads this clock and optional external-response profile.
mock.timers.enable({
	apis: ['Date', 'setTimeout', 'setInterval'],
	now: profile?.nowMilliseconds ?? controlledSignInClock.now(),
});

const originalFetch = globalThis.fetch;
const observedJwksFetch = createClockFreeProofJwksFetch({
	caller: 'native-owner-person',
	fetch: (input, init) => originalFetch(input, init),
	observe: (event) => {
		void recordAuthProofPhase({ ...event, kind: 'jwks-fetch-ended' }).catch(() => {
			// Evidence retention cannot write to or change the delivered CLI's output.
		});
	},
});
globalThis.fetch = async (
	input: Parameters<typeof fetch>[0],
	init?: RequestInit,
): Promise<Response> => {
	const url = new URL(
		typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
	);
	if (url.pathname === '/api/auth/jwks') return observedJwksFetch(input, init);
	const response = await originalFetch(input, init);
	if (profile?.kind !== 'token-response') return response;
	if (url.origin !== profile.issuer || url.pathname !== '/api/auth/oauth2/token' || !response.ok)
		return response;
	const body: unknown = await response.json();
	if (body === null || typeof body !== 'object' || !Object.hasOwn(body, 'access_token'))
		throw new Error('Negative CLI profile did not receive a real token response');
	return Response.json({ ...body, access_token: profile.accessToken });
};
