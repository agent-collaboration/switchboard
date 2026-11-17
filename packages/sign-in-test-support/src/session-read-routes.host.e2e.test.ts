import { session } from '@agent-collaboration/sign-in-core';
import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { z } from 'zod';

import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import { controlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-sign-in-clock';
import { startLocalAuthHarness } from '#sign-in-test-support/test-fixtures/local-auth-harness';
import { signInPeopleBrowser } from '#sign-in-test-support/test-fixtures/people-browser-login';

useControlledSignInClock();
type Harness = Awaited<ReturnType<typeof startLocalAuthHarness>>;
const personEmail = 'owner@example.invalid';
const sessionReadSchema = z.object({
	session: z.looseObject({ id: z.uuidv7(), userId: z.uuidv7() }),
	user: z.looseObject({ email: z.string() }),
});
const dayMilliseconds = 24 * 60 * 60 * 1000;

function sessionCookiePair(harness: Harness): string {
	const pair = harness
		.cookie()
		.split('; ')
		.find((candidate) => candidate.split('=')[0]?.endsWith('session_token') === true);
	if (pair === undefined) throw new Error('The signed-in browser holds no session cookie');
	return pair;
}

async function storedSessionToken(harness: Harness, sessionId: string): Promise<string> {
	const [stored] = await harness.database
		.select({ token: session.token })
		.from(session)
		.where(eq(session.id, sessionId));
	if (stored === undefined) throw new Error('The read session is not stored');
	return stored.token;
}

/** Reads the session and proves the response carries no token, in field or text. */
async function readSessionWithoutToken(
	harness: Harness,
	personId: string,
): Promise<{ readonly sessionId: string; readonly response: Response }> {
	const response = await harness.auth('/api/auth/get-session');
	expect(response.status).toBe(200);
	const text = await response.clone().text();
	const read = sessionReadSchema.parse(JSON.parse(text));
	expect(read.session.userId).toBe(personId);
	expect(read.user.email).toBe(personEmail);
	expect(read.session).not.toHaveProperty('token');
	expect(text).not.toContain(await storedSessionToken(harness, read.session.id));
	return { sessionId: read.session.id, response };
}

it('reads the session without its token, stored and after a refresh, with an httpOnly same-site cookie', async () => {
	const harness = await startLocalAuthHarness();
	try {
		const personId = await signInPeopleBrowser({ harness, email: personEmail });
		const stored = await readSessionWithoutToken(harness, personId);
		expect(stored.response.headers.getSetCookie()).toEqual([]);

		// Past Better Auth's one-day update age, get-session refreshes the session.
		const moved = await harness.auth('/__auth-proof/set-clock', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				milliseconds: controlledSignInClock.now() + dayMilliseconds + 60_000,
			}),
		});
		expect(moved.status).toBe(200);
		const refreshed = await readSessionWithoutToken(harness, personId);
		expect(refreshed.sessionId).toBe(stored.sessionId);
		const refreshedCookie = refreshed.response.headers
			.getSetCookie()
			.find((header) => header.split('=')[0]?.endsWith('session_token') === true);
		expect(refreshedCookie).toBeDefined();
		expect(refreshedCookie).toMatch(/;\s*HttpOnly(?:;|$)/iu);
		expect(refreshedCookie).toMatch(/;\s*SameSite=Lax(?:;|$)/iu);
	} finally {
		await harness.close();
	}
});

it('gives cross-site and bearer reads no session and no cross-origin grant', async () => {
	const harness = await startLocalAuthHarness();
	try {
		const personId = await signInPeopleBrowser({ harness, email: personEmail });
		const { sessionId } = await readSessionWithoutToken(harness, personId);
		// The issuer is 127.0.0.1; localhost is another site that local workerd still admits.
		const crossSiteHeaders = { origin: 'http://localhost:9', 'sec-fetch-site': 'cross-site' };

		// A cross-site page's request carries no Lax cookie, so it reads no session.
		const withoutCookie = await harness.auth('/api/auth/get-session', {
			headers: { ...crossSiteHeaders, cookie: '' },
		});
		expect(withoutCookie.status).toBe(200);
		expect(await withoutCookie.json()).toBeNull();
		// Even a cookie-bearing cross-site request is never granted to the other origin.
		const withCookie = await harness.auth('/api/auth/get-session', { headers: crossSiteHeaders });
		expect(withCookie.headers.get('access-control-allow-origin')).toBeNull();
		expect(withCookie.headers.get('access-control-allow-credentials')).toBeNull();

		// The bearer plugin is off: neither the cookie's signed value nor the stored token authenticates.
		const signedCookieValue = decodeURIComponent(
			sessionCookiePair(harness).split('=').slice(1).join('='),
		);
		for (const bearer of [signedCookieValue, await storedSessionToken(harness, sessionId)]) {
			const read = await harness.auth('/api/auth/get-session', {
				headers: { cookie: '', authorization: `Bearer ${bearer}` },
			});
			expect(read.status).toBe(200);
			expect(await read.json()).toBeNull();
		}
	} finally {
		await harness.close();
	}
});

it('offers list-accounts as a read and keeps writes and neighbouring routes closed', async () => {
	const harness = await startLocalAuthHarness();
	try {
		await signInPeopleBrowser({ harness, email: personEmail });
		const accounts = await harness.auth('/api/auth/list-accounts');
		expect(accounts.status).toBe(200);
		expect(
			z
				.array(z.looseObject({ providerId: z.string() }))
				.parse(await accounts.json())
				.map((account) => account.providerId),
		).toEqual(['google']);

		for (const [pathname, method] of [
			['/api/auth/get-session', 'POST'],
			['/api/auth/list-accounts', 'POST'],
			['/api/auth/list-sessions', 'GET'],
			['/api/auth/get-access-token', 'POST'],
		] as const) {
			const closed = await harness.auth(pathname, { method });
			expect(closed.status).toBe(404);
			expect(await closed.json()).toEqual({ error: 'not-found' });
		}
	} finally {
		await harness.close();
	}
});
