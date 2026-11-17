import { expect, it } from 'vitest';

import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import { readCurrentBrowserSession } from '#sign-in-test-support/test-fixtures/current-browser-session';
import { startLocalAuthHarness } from '#sign-in-test-support/test-fixtures/local-auth-harness';
import { signInPeopleBrowser } from '#sign-in-test-support/test-fixtures/people-browser-login';
import { allSignInRowFingerprints } from '#sign-in-test-support/test-fixtures/stored-row-fingerprints';

useControlledSignInClock();

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
