import { expect, it } from 'vitest';

import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import { readCurrentBrowserSession } from '#sign-in-test-support/test-fixtures/current-browser-session';
import { startLocalAuthHarness } from '#sign-in-test-support/test-fixtures/local-auth-harness';
import { signInPeopleBrowser } from '#sign-in-test-support/test-fixtures/people-browser-login';
import { allSignInRowFingerprints } from '#sign-in-test-support/test-fixtures/stored-row-fingerprints';

useControlledSignInClock();

type Harness = Awaited<ReturnType<typeof startLocalAuthHarness>>;

it('refuses malformed link-social JSON with a generic 400 and no stored effects', async () => {
	// Arrange
	const harness = await startLocalAuthHarness();
	try {
		const before = await allSignInRowFingerprints(harness);
		// Act
		const response = await harness.auth('/api/auth/link-social', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{',
		});
		// Assert
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			code: 'BAD_REQUEST',
			message: 'Invalid JSON in request body',
		});
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(response.headers.has('set-cookie')).toBe(false);
		expect(await allSignInRowFingerprints(harness)).toEqual(before);
	} finally {
		await harness.close();
	}
});

/**
 * Bodies Better Call 1.4.2 `getBody` refuses at its media gate under Better Auth 1.7.11's
 * `allowedMediaTypes: ["application/json"]`, before any session check (`dist/utils.mjs:8-22`).
 * A `Uint8Array` body is sent so the transport adds no content type of its own.
 */
const unsupportedMediaCases = [
	{ contentType: 'text/plain', body: '{', allowed: 'Content-Type "text/plain" is not allowed' },
	{
		contentType: 'text/plain',
		body: JSON.stringify({ provider: 'github' }),
		allowed: 'Content-Type "text/plain" is not allowed',
	},
	{ contentType: null, body: '{', allowed: 'Content-Type is required' },
	{
		contentType: 'application/problem+json',
		body: '{',
		allowed: 'Content-Type "application/problem+json" is not allowed',
	},
] as const;

async function postUnsupportedMediaCases(harness: Harness): Promise<readonly unknown[]> {
	const observed: unknown[] = [];
	for (const { contentType, body } of unsupportedMediaCases) {
		const response = await harness.auth('/api/auth/link-social', {
			method: 'POST',
			headers: contentType === null ? {} : { 'content-type': contentType },
			body: new TextEncoder().encode(body),
		});
		observed.push({
			status: response.status,
			body: await response.json(),
			setCookie: response.headers.has('set-cookie'),
		});
	}
	return observed;
}

const expectedUnsupportedMedia = unsupportedMediaCases.map(({ allowed }) => ({
	status: 415,
	body: {
		code: 'UNSUPPORTED_MEDIA_TYPE',
		message: `${allowed}. Allowed types: application/json`,
	},
	setCookie: false,
}));

it('refuses unsupported link-social media types with the native 415 when signed out', async () => {
	// Arrange
	const harness = await startLocalAuthHarness();
	try {
		const before = await allSignInRowFingerprints(harness);
		// Act
		const observed = await postUnsupportedMediaCases(harness);
		// Assert: the media refusal precedes the wrapper's own signed-out 403, as natively.
		expect(observed).toEqual(expectedUnsupportedMedia);
		expect(await allSignInRowFingerprints(harness)).toEqual(before);
	} finally {
		await harness.close();
	}
});

it('refuses unsupported link-social media types with the native 415 when signed in', async () => {
	// Arrange
	const harness = await startLocalAuthHarness();
	try {
		await signInPeopleBrowser({ harness, email: 'owner@example.invalid' });
		const before = await allSignInRowFingerprints(harness);
		// Act
		const observed = await postUnsupportedMediaCases(harness);
		// Assert
		expect(observed).toEqual(expectedUnsupportedMedia);
		expect(await allSignInRowFingerprints(harness)).toEqual(before);
	} finally {
		await harness.close();
	}
});

it('keeps a real link-social session-store failure unavailable rather than a client refusal', async () => {
	// Arrange: establish the real provider session before arming a driver read fault.
	const harness = await startLocalAuthHarness();
	try {
		await signInPeopleBrowser({ harness, email: 'owner@example.invalid' });
		const current = await readCurrentBrowserSession({
			cookie: harness.cookie(),
			database: harness.database,
		});
		const request = {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ provider: 'github' }),
		};
		expect((await harness.auth('/api/auth/link-social', request)).status).toBe(200);
		const before = await allSignInRowFingerprints(harness);
		await harness.setDatabaseFault({ operation: 'select', table: 'session', key: current.id });
		// Act
		const response = await harness.auth('/api/auth/link-social', request);
		// Assert
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({ error: 'sign-in-unavailable' });
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(response.headers.has('set-cookie')).toBe(false);
		await harness.setDatabaseFault(null);
		expect(await allSignInRowFingerprints(harness)).toEqual(before);
	} finally {
		await harness.close();
	}
});
