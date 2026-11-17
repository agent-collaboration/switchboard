import { expect, it } from 'vitest';

import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import { startLocalAuthHarness } from '#sign-in-test-support/test-fixtures/local-auth-harness';
import { signInPeopleBrowser } from '#sign-in-test-support/test-fixtures/people-browser-login';
import { allSignInRowFingerprints } from '#sign-in-test-support/test-fixtures/stored-row-fingerprints';

useControlledSignInClock();

type Harness = Awaited<ReturnType<typeof startLocalAuthHarness>>;

/** The one continuation the owner CLI may resume: its fixed client, loopback callback and scope. */
function ownerCliAuthorization(
	harness: Harness,
	overrides: Readonly<Record<string, string>> = {},
): string {
	const authorization = new URL('/api/auth/oauth2/authorize', harness.issuer);
	authorization.search = new URLSearchParams({
		client_id: harness.target.ownerCliClientId,
		redirect_uri: harness.target.ownerCliRedirectUri,
		response_type: 'code',
		scope: 'tool-portal:management',
		resource: harness.target.managementAudience,
		code_challenge_method: 'S256',
		code_challenge: 'owner-resume-regression',
		...overrides,
	}).toString();
	return authorization.toString();
}

function refusedContinuations(harness: Harness): readonly string[] {
	return [
		'not an authorization address',
		ownerCliAuthorization(harness, { client_id: 'another-client' }),
		ownerCliAuthorization(harness, { redirect_uri: 'https://elsewhere.example.invalid/callback' }),
	];
}

/** Both handler call sites: the owner pages, and a factor POST before any native factor mutation. */
function requestsWith(continuation: string): readonly [string, RequestInit][] {
	const authorize = new URLSearchParams({ authorize: continuation }).toString();
	return [
		[`/sign-in?${authorize}`, {}],
		[`/owner-ready?${authorize}`, {}],
		[
			`/api/auth/two-factor/enable?${authorize}`,
			{
				method: 'POST',
				headers: { 'content-type': 'application/json', accept: 'text/html' },
				body: '{}',
			},
		],
	];
}

it('refuses a malformed owner CLI continuation with the generic 400 before any effect', async () => {
	// Arrange: signed in, so each page and factor route would otherwise read and mutate state.
	const harness = await startLocalAuthHarness();
	try {
		await signInPeopleBrowser({ harness, email: 'owner@example.invalid' });
		const before = await allSignInRowFingerprints(harness);
		const requests = [
			...refusedContinuations(harness).flatMap(requestsWith),
			// The page also derives a continuation from a bare authorization query.
			[`/sign-in?client_id=another-client`, {}] as const,
		];
		// Act
		const observed: unknown[] = [];
		for (const [pathname, init] of requests) {
			const response = await harness.auth(pathname, init);
			observed.push({
				pathname,
				status: response.status,
				body: await response.json(),
				cacheControl: response.headers.get('cache-control'),
				setCookie: response.headers.has('set-cookie'),
			});
		}
		// Assert: the handler's generic input refusal (`fleet-admin-forwarding.ts`).
		expect(observed).toEqual(
			requests.map(([pathname]) => ({
				pathname,
				status: 400,
				body: { error: 'invalid-request' },
				cacheControl: 'no-store',
				setCookie: false,
			})),
		);
		expect(await allSignInRowFingerprints(harness)).toEqual(before);
	} finally {
		await harness.close();
	}
});

it('still resumes a valid owner CLI continuation at both call sites', async () => {
	// Arrange
	const harness = await startLocalAuthHarness();
	try {
		await signInPeopleBrowser({ harness, email: 'owner@example.invalid' });
		const continuation = ownerCliAuthorization(harness);
		const carried = new URLSearchParams({ authorize: continuation }).toString();
		// Act
		const responses = await Promise.all(
			requestsWith(continuation).map(([pathname, init]) => harness.auth(pathname, init)),
		);
		// Assert: each page or factor response carries the validated continuation onward.
		for (const response of responses) {
			expect(response.status).not.toBe(400);
			expect(response.status).toBeLessThan(500);
			expect(await response.text()).toContain(carried);
		}
	} finally {
		await harness.close();
	}
});
