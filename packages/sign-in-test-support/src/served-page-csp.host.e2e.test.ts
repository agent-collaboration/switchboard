import { expect, it } from 'vitest';

import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import { startLocalAuthHarness } from '#sign-in-test-support/test-fixtures/local-auth-harness';
import { signInPeopleBrowser } from '#sign-in-test-support/test-fixtures/people-browser-login';

useControlledSignInClock();
const turnstileOrigin = 'challenges.cloudflare.com';

/** Owner decisions: only the sign-in page may load Turnstile (12 Nov); signed-in
 * pages, which can read get-session, name no third party, and frame only blob:
 * documents, for Better Auth UI's recovery-code print (13 Nov). */
it('names Turnstile only in the sign-in page policy; signed-in pages frame only blob:', async () => {
	const harness = await startLocalAuthHarness();
	try {
		const signIn = await harness.auth('/sign-in');
		expect(signIn.status).toBe(200);
		const signInPolicy = signIn.headers.get('content-security-policy') ?? '';
		expect(signInPolicy).toMatch(
			/script-src 'nonce-[a-f0-9]+' https:\/\/challenges\.cloudflare\.com;/u,
		);
		expect(signInPolicy.replace(/'nonce-[a-f0-9]+'/u, "'nonce'")).toBe(
			`default-src 'none'; script-src 'nonce' https://${turnstileOrigin}; style-src 'self'; img-src 'self' data:; connect-src 'self' https://${turnstileOrigin}; frame-src https://${turnstileOrigin}; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
		);
		expect(await signIn.text()).toContain(`https://${turnstileOrigin}/turnstile/v0/api.js`);

		await signInPeopleBrowser({ harness, email: 'owner@example.invalid' });
		const ownerReady = await harness.auth('/owner-ready');
		expect(ownerReady.status).toBe(200);
		const factorPage = await harness.auth('/api/auth/two-factor/enable', {
			method: 'POST',
			headers: { 'content-type': 'application/json', accept: 'text/html' },
			body: JSON.stringify({ method: 'totp' }),
		});
		expect(factorPage.headers.get('content-type')).toContain('text/html');
		for (const page of [ownerReady, factorPage]) {
			const policy = page.headers.get('content-security-policy') ?? '';
			expect(policy.replace(/'nonce-[a-f0-9]+'/u, "'nonce'")).toBe(
				"default-src 'none'; script-src 'nonce'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src blob:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
			);
			expect(await page.text()).not.toContain(turnstileOrigin);
		}
	} finally {
		await harness.close();
	}
});
