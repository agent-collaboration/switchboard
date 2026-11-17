import { expect, it } from 'vitest';
import { z } from 'zod';

import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import {
	agentAudience,
	registrationRequestId,
	startLocalAuthHarness,
	workspaceOne,
} from '#sign-in-test-support/test-fixtures/local-auth-harness';
import { allSignInRowFingerprints } from '#sign-in-test-support/test-fixtures/stored-row-fingerprints';

useControlledSignInClock();

it('refuses an undecodable Basic client credential as the native invalid_client', async () => {
	// Arrange: no form client_id, so the only client named is the undecodable Basic header.
	const harness = await startLocalAuthHarness();
	try {
		const tokenRequest = (headers: Readonly<Record<string, string>>): Promise<Response> =>
			harness.auth('/api/auth/oauth2/token', {
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
				body: new URLSearchParams({ grant_type: 'authorization_code' }).toString(),
			});
		// The provider seeds its configured resources on first resource access
		// (oauth-provider 1.7.11 `dist/introspect-B-5vOvYK.mjs:830-870`); a credential-free
		// refusal does that first, so the baseline holds only the malformed request's own effects.
		expect((await tokenRequest({})).status).toBeLessThan(500);
		const before = await allSignInRowFingerprints(harness);
		// Act
		const response = await tokenRequest({ authorization: 'Basic !!!' });
		// Assert: oauth-provider 1.7.11 `dist/utils-vIo_wPv5.mjs:607-621`.
		expect(response.status).toBe(401);
		expect(response.headers.get('www-authenticate')).toBe('Basic');
		expect(await response.json()).toEqual({
			error: 'invalid_client',
			error_description: 'invalid authorization header format',
		});
		expect(response.headers.has('set-cookie')).toBe(false);
		expect(await allSignInRowFingerprints(harness)).toEqual(before);
	} finally {
		await harness.close();
	}
});

/**
 * A Basic credential for real client credentials that the provider's decoder accepts and `atob`
 * refuses: standard base64 followed by extra `=` padding. `@better-auth/utils` base64 stops at the
 * first `=`, while `atob` refuses `=` anywhere but canonical end padding. Each half is
 * form-url-encoded first, as RFC 6749 section 2.3.1 and the provider's own encoder do.
 */
function extraPaddedBasic(credentials: {
	readonly clientId: string;
	readonly clientSecret: string;
}): string {
	const formEncoded = (value: string): string =>
		new URLSearchParams({ v: value }).toString().slice(2);
	return `Basic ${btoa(`${formEncoded(credentials.clientId)}:${formEncoded(credentials.clientSecret)}`)}==`;
}

it('names the client of a Basic credential the provider decodes but atob refuses, so its token is issued', async () => {
	// Arrange: a real registered agent client.
	const harness = await startLocalAuthHarness();
	try {
		const registration = await harness.gateway(`/management/workspaces/${workspaceOne}/agents`, {
			method: 'POST',
			headers: {
				authorization: `Bearer ${await harness.ownerToken()}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify({ requestId: registrationRequestId, persona: 'operator' }),
		});
		expect(registration.status).toBe(200);
		const credentials = z
			.object({ clientId: z.string(), clientSecret: z.string() })
			.parse(await registration.json());
		// Act
		const response = await harness.auth('/api/auth/oauth2/token', {
			method: 'POST',
			headers: {
				authorization: extraPaddedBasic(credentials),
				'content-type': 'application/x-www-form-urlencoded',
			},
			body: new URLSearchParams({
				grant_type: 'client_credentials',
				scope: 'tool-portal:agent',
				resource: agentAudience,
			}).toString(),
		});
		// Assert: the provider authenticates this client, and the wrapper names the same one.
		expect(response.status).toBe(200);
		expect(
			z.object({ access_token: z.string().min(1) }).safeParse(await response.json()).success,
		).toBe(true);
	} finally {
		await harness.close();
	}
});
