import { expect, it } from 'vitest';

import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import { startLocalAuthHarness } from '#sign-in-test-support/test-fixtures/local-auth-harness';
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
