import { expect, it } from 'vitest';
import { z } from 'zod';

import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import { controlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-sign-in-clock';
import { readCurrentBrowserSession } from '#sign-in-test-support/test-fixtures/current-browser-session';
import { startLocalAuthHarness } from '#sign-in-test-support/test-fixtures/local-auth-harness';
import { signInConfirmedPeopleBrowser } from '#sign-in-test-support/test-fixtures/people-browser-login';
import { allSignInRowFingerprints } from '#sign-in-test-support/test-fixtures/stored-row-fingerprints';

useControlledSignInClock();
type Harness = Awaited<ReturnType<typeof startLocalAuthHarness>>;

async function readyForLimitProof(harness: Harness): Promise<void> {
	// An actual JWKS fetch/import is the readiness witness for these signed-out
	// flood cases; no receipt is marked ready because a listener merely exists.
	expect((await harness.auth('/api/auth/jwks')).status).toBe(200);
}

function socialAttemptInit(
	harness: Harness,
	additionalHeaders: Readonly<Record<string, string>> = {},
): RequestInit {
	return {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-captcha-response': harness.turnstile.issueToken({
				action: 'sign_in_social',
				hostname: new URL(harness.issuer).hostname,
				verdict: 'accepted',
			}),
			...additionalHeaders,
		},
		body: JSON.stringify({
			provider: 'google',
			callbackURL: new URL('/owner-ready', harness.issuer).toString(),
		}),
	};
}

function socialAttempt(
	harness: Harness,
	additionalHeaders: Readonly<Record<string, string>> = {},
): Promise<Response> {
	return harness.auth('/api/auth/sign-in/social', socialAttemptInit(harness, additionalHeaders));
}

/** The same start from another fixture browser, which the harness gives its own stable address. */
function socialAttemptFromSecondAddress(harness: Harness): Promise<Response> {
	return harness.authAsBrowser(
		'second-address',
		'/api/auth/sign-in/social',
		socialAttemptInit(harness),
	);
}

it('people: an unavailable outer backing call returns 503 before native captcha or state effects', async () => {
	const harness = await startLocalAuthHarness();
	try {
		await readyForLimitProof(harness);
		// Positive control: this same valid request reaches native captcha and
		// OAuth state normally before the backing failure is armed.
		expect((await socialAttempt(harness)).status).toBe(200);
		const before = await allSignInRowFingerprints(harness);
		const nativeAttempts = harness.siteVerifyAttempts();
		expect(nativeAttempts).toBe(1);
		await harness.makeLimiterUnavailable();
		const response = await socialAttempt(harness);
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({ error: 'sign-in-unavailable' });
		expect(harness.siteVerifyAttempts()).toBe(nativeAttempts);
		expect(await allSignInRowFingerprints(harness)).toEqual(before);
		expect(await harness.captchaObservations()).toContainEqual({
			kind: 'request-limit-unavailable',
			requestClass: 'sign-in',
		});
	} finally {
		await harness.close();
	}
});

it('people: changing spoofed XFF leaves native counting on the trusted host address', async () => {
	const harness = await startLocalAuthHarness();
	try {
		await readyForLimitProof(harness);
		const address = harness.browserAddress();
		const started = await Promise.all(
			[1, 2, 3].map((suffix) =>
				socialAttempt(harness, { 'x-forwarded-for': `198.51.100.${suffix}` }),
			),
		);
		expect(started.map((response) => response.status)).toEqual([200, 200, 200]);
		const before = await allSignInRowFingerprints(harness);
		const refused = await socialAttempt(harness, { 'x-forwarded-for': '198.51.100.4' });
		expect(refused.status).toBe(429);
		expectRetryAfter(refused);
		expect(harness.browserAddress()).toBe(address);
		expect(await allSignInRowFingerprints(harness)).toEqual(before);
		// Four starts stay below the real CF outer budget: this is trusted-input
		// and native keying proof, not vendor throttle/reset proof.
	} finally {
		await harness.close();
	}
});
function expectRetryAfter(response: Response): void {
	expect(
		z.coerce.number().int().positive().safeParse(response.headers.get('retry-after')).success,
	).toBe(true);
}

it('people: social starts hit the native limit and the real outer counter (Miniflare binding, Node counter) without more stored effects, and another address still passes', async () => {
	const harness = await startLocalAuthHarness({ turnstileSecret: 'published-test' });
	try {
		await readyForLimitProof(harness);
		const address = harness.browserAddress();
		const first = await Promise.all(Array.from({ length: 3 }, () => socialAttempt(harness)));
		expect(first.map((response) => response.status)).toEqual([200, 200, 200]);
		const beforeLimit = await allSignInRowFingerprints(harness);
		const refused = await socialAttempt(harness);
		expect(refused.status).toBe(429);
		expectRetryAfter(refused);
		expect(await allSignInRowFingerprints(harness)).toEqual(beforeLimit);
		// Node counts in its real host map; Cloudflare counts in Miniflare's real
		// rate-limit binding. Neither is the hosted vendor counter.
		const continued = await Promise.all(Array.from({ length: 12 }, () => socialAttempt(harness)));
		expect(continued.every((response) => response.status === 429)).toBe(true);
		expect(harness.browserAddress()).toBe(address);
		expect(await allSignInRowFingerprints(harness)).toEqual(beforeLimit);
		const observations = await harness.captchaObservations();
		expect(
			observations.filter((observation) => observation.kind === 'request-limited'),
		).toHaveLength(13);
		expect(observations).toContainEqual({
			kind: 'request-limited',
			requestClass: 'sign-in',
			layer: 'provider',
		});
		expect(observations).toContainEqual({
			kind: 'request-limited',
			requestClass: 'sign-in',
			layer: 'outer',
		});
		// R52: the count is per address, so a second address is not limited.
		expect((await socialAttemptFromSecondAddress(harness)).status).toBe(200);
	} finally {
		await harness.close();
	}
});

async function firstLimitedPage(props: {
	readonly harness: Harness;
	readonly attempt?: number;
}): Promise<{ readonly attempt: number; readonly response: Response }> {
	const attempt = props.attempt ?? 1;
	const response = await props.harness.auth('/owner-ready');
	if (response.status === 429) return { attempt, response };
	expect(response.status).toBe(200);
	if (attempt >= 601) throw new Error('The service page never reached its outer limit');
	// Await the real response event, not a sleep or an injected clock jump.
	return firstLimitedPage({ harness: props.harness, attempt: attempt + 1 });
}

it('people: the service own page reaches the real outer counter (Miniflare binding, Node counter) without a write, and another address still passes', async () => {
	const harness = await startLocalAuthHarness({ turnstileSecret: 'published-test' });
	try {
		await readyForLimitProof(harness);
		const before = await allSignInRowFingerprints(harness);
		const limited = await firstLimitedPage({ harness });
		expectRetryAfter(limited.response);
		expect(limited.attempt).toBe(301);
		// Real Node counting and Miniflare's real binding. The hosted vendor's
		// reset and cross-location counting are checked on the private stack.
		expect(await allSignInRowFingerprints(harness)).toEqual(before);
		expect(await harness.captchaObservations()).toContainEqual({
			kind: 'request-limited',
			requestClass: 'service-page',
			layer: 'outer',
		});
		// R52: the count is per address, so a second address is not limited.
		expect((await harness.authAsBrowser('second-address', '/owner-ready')).status).toBe(200);
	} finally {
		await harness.close();
	}
});

it('people: five failed recovery codes reach native verification and the sixth is limited without another intent or stamp', async () => {
	const harness = await startLocalAuthHarness();
	try {
		await readyForLimitProof(harness);
		await signInConfirmedPeopleBrowser({ harness, email: 'owner@example.invalid' });
		const session = await readCurrentBrowserSession({
			cookie: harness.cookie(),
			database: harness.database,
		});
		function attempt(): Promise<Response> {
			return harness.auth('/api/auth/two-factor/verify-backup-code', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ code: 'never-issued-recovery-code' }),
			});
		}
		const failed = await Promise.all(Array.from({ length: 5 }, () => attempt()));
		expect(failed.map((response) => response.status)).toEqual([401, 401, 401, 401, 401]);
		const beforeLimit = await allSignInRowFingerprints(harness);
		const limited = await attempt();
		expect(limited.status).toBe(429);
		expectRetryAfter(limited);
		expect(await allSignInRowFingerprints(harness)).toEqual(beforeLimit);
		expect(
			await readCurrentBrowserSession({ cookie: harness.cookie(), database: harness.database }),
		).toEqual(session);
		expect(await harness.captchaObservations()).toContainEqual({
			kind: 'request-limited',
			requestClass: 'second-factor-code',
			layer: 'provider',
		});
		const nextWindow = controlledSignInClock.now() + 60_000;
		expect(
			(
				await harness.auth('/__auth-proof/set-clock', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ milliseconds: nextWindow }),
				})
			).status,
		).toBe(200);
		const recovered = await harness.auth('/api/auth/two-factor/verify-backup-code', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				code: harness.totpAuthenticator.recoveryCode('owner@example.invalid'),
			}),
		});
		expect(recovered.status).toBe(200);
		expect(
			await readCurrentBrowserSession({ cookie: harness.cookie(), database: harness.database }),
		).toMatchObject({
			id: session.id,
			secondFactorAt: nextWindow,
			secondFactorMethod: 'recoveryCode',
		});
	} finally {
		await harness.close();
	}
});

it('people: the token endpoint counts refused clients and limits the thirty-first request without minting or storing anything', async () => {
	const harness = await startLocalAuthHarness();
	try {
		await readyForLimitProof(harness);
		const before = await allSignInRowFingerprints(harness);
		function attempt(): Promise<Response> {
			return harness.auth('/api/auth/oauth2/token', {
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({
					grant_type: 'client_credentials',
					client_id: 'not-an-enrolled-client',
					client_secret: 'test-only-unknown-client-secret',
				}).toString(),
			});
		}
		const failed = await Promise.all(Array.from({ length: 30 }, () => attempt()));
		expect(failed.every((response) => response.status === 400 || response.status === 401)).toBe(
			true,
		);
		const limited = await attempt();
		expect(limited.status).toBe(429);
		expectRetryAfter(limited);
		expect(await allSignInRowFingerprints(harness)).toEqual(before);
		expect(await harness.captchaObservations()).toContainEqual({
			kind: 'request-limited',
			requestClass: 'oauth-token',
			layer: 'provider',
		});
		expect(
			(
				await harness.auth('/__auth-proof/set-clock', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ milliseconds: controlledSignInClock.now() + 60_000 }),
				})
			).status,
		).toBe(200);
		const nextWindow = await attempt();
		expect(nextWindow.status === 400 || nextWindow.status === 401).toBe(true);
		expect(await allSignInRowFingerprints(harness)).toEqual(before);
	} finally {
		await harness.close();
	}
});
