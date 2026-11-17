import { session } from '@agent-collaboration/sign-in-core';
import { expect, it } from 'vitest';
import { z } from 'zod';

import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import { controlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-sign-in-clock';
import { expectNoIssuedCredentials } from '#sign-in-test-support/test-fixtures/credential-free-refusal';
import { startLocalAuthHarness } from '#sign-in-test-support/test-fixtures/local-auth-harness';

useControlledSignInClock();

it('Better Auth computes a real session expiry from the mocked runtime clock and refuses it after an explicit clock move', async () => {
	const harness = await startLocalAuthHarness();
	try {
		await harness.ownerToken();
		const sessions = await harness.database.select().from(session);
		expect(sessions).toHaveLength(1);
		const stored = z.object({ createdAt: z.date(), expiresAt: z.date() }).parse(sessions[0]);
		expect(stored.createdAt.getTime()).toBe(controlledSignInClock.now());
		expect(stored.expiresAt.getTime()).toBeGreaterThan(stored.createdAt.getTime());
		const before = await harness.auth('/api/auth/owner/bootstrap', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{}',
		});
		expect(before.status).toBe(200);
		const advanced = stored.expiresAt.getTime() + 1;
		const clock = await harness.auth('/__auth-proof/set-clock', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ milliseconds: advanced }),
		});
		expect(clock.status).toBe(200);
		expect(await clock.json()).toEqual({ controlledMilliseconds: advanced });
		const expired = await harness.auth('/api/auth/owner/bootstrap', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{}',
		});
		// Better Auth's sessionMiddleware rejects the expired session before our
		// owner callback runs; its existing protocol response is 401.
		expect(expired.status).toBe(401);
		expectNoIssuedCredentials(await expired.json());
		// Better Auth getSession itself removes its expired row; no fixture edits it.
		expect(await harness.database.select().from(session)).toEqual([]);
		expect(harness.effects).toHaveLength(0);
	} finally {
		await harness.close();
	}
});
