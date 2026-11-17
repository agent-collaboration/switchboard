import { account, member, session, signInAudit, user } from '@agent-collaboration/sign-in-core';
import type { SocialLoginProvider } from '@agent-collaboration/sign-in-core/better-auth';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import { startLocalAuthHarness } from '#sign-in-test-support/test-fixtures/local-auth-harness';
import { ensureLocalOwnerOrganization } from '#sign-in-test-support/test-fixtures/local-owner-organization';

useControlledSignInClock();
type Harness = Awaited<ReturnType<typeof startLocalAuthHarness>>;
const ownerEmail = 'owner@example.invalid';

async function startProviderRedirect(
	harness: Harness,
	provider: SocialLoginProvider,
	linking: boolean,
): Promise<URL> {
	const initiated = await harness.auth(
		linking ? '/api/auth/link-social' : '/api/auth/sign-in/social',
		{
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				...(!linking
					? {
							'x-captcha-response': harness.turnstile.issueToken({
								action: 'sign_in_social',
								hostname: new URL(harness.issuer).hostname,
								verdict: 'accepted',
							}),
						}
					: {}),
			},
			body: JSON.stringify({
				provider,
				callbackURL: new URL('/owner-ready', harness.issuer).toString(),
			}),
		},
	);
	expect(initiated.status).toBe(200);
	return new URL(z.object({ url: z.url() }).parse(await initiated.json()).url);
}

async function finishProviderRedirect(
	harness: Harness,
	provider: SocialLoginProvider,
	providerUrl: URL,
	verified = true,
): Promise<Response> {
	const callback = harness.providerCallback(provider, providerUrl, ownerEmail, verified);
	return harness.auth(callback.toString(), {
		headers: { 'sec-fetch-mode': 'navigate', accept: 'text/html' },
	});
}

async function signIn(harness: Harness, provider: SocialLoginProvider): Promise<void> {
	const response = await finishProviderRedirect(
		harness,
		provider,
		await startProviderRedirect(harness, provider, false),
	);
	expect(response.status).toBe(302);
	expect(new URL(response.headers.get('location') ?? 'invalid:').searchParams.has('error')).toBe(
		false,
	);
	expect(await harness.database.select().from(user)).toHaveLength(1);
	expect(await harness.database.select().from(account)).toHaveLength(1);
	expect(await harness.database.select().from(session)).toHaveLength(1);
	await harness.totpAuthenticator.ensureConfirmed(ownerEmail, harness.auth);
	await ensureLocalOwnerOrganization({ auth: harness.auth, database: harness.database });
}

async function identitySnapshot(harness: Harness): Promise<unknown> {
	const [people, accounts, sessions] = await Promise.all([
		harness.database.select().from(user).orderBy(user.id),
		harness.database.select().from(account).orderBy(account.id),
		harness.database.select().from(session).orderBy(session.id),
	]);
	return { people, accounts, sessions };
}

function expectCallbackRefused(response: Response): void {
	expect(response.status).toBe(302);
	expect(new URL(response.headers.get('location') ?? 'invalid:').searchParams.has('error')).toBe(
		true,
	);
}

describe('explicit redirect login linking with real provider and storage', () => {
	it.each([
		{ first: 'google', second: 'github' },
		{ first: 'github', second: 'google' },
	] satisfies readonly {
		readonly first: SocialLoginProvider;
		readonly second: SocialLoginProvider;
	}[])(
		'refuses signed-out $first to $second email-match linking without creating a Person, account or session',
		async ({ first, second }) => {
			const harness = await startLocalAuthHarness();
			try {
				await signIn(harness, first);
				const before = await identitySnapshot(harness);
				harness.clearBrowserSession();
				const refused = await finishProviderRedirect(
					harness,
					second,
					await startProviderRedirect(harness, second, false),
				);
				expectCallbackRefused(refused);
				expect(await identitySnapshot(harness)).toEqual(before);
			} finally {
				await harness.close();
			}
		},
	);

	it('links exactly one provider account to the signed-in Person and reads back the before/outcome audit', async () => {
		const harness = await startLocalAuthHarness();
		try {
			await signIn(harness, 'google');
			const person = z
				.object({ id: z.uuidv7() })
				.parse((await harness.database.select().from(user))[0]);
			const response = await finishProviderRedirect(
				harness,
				'github',
				await startProviderRedirect(harness, 'github', true),
			);
			expect(response.status).toBe(302);
			expect(
				new URL(response.headers.get('location') ?? 'invalid:').searchParams.has('error'),
			).toBe(false);
			const accounts = await harness.database.select().from(account);
			expect(accounts).toHaveLength(2);
			expect(accounts.map((entry) => entry.providerId).toSorted()).toEqual(['github', 'google']);
			expect(
				accounts.every(
					(entry) =>
						entry.userId === person.id &&
						entry.accessToken === null &&
						entry.refreshToken === null &&
						entry.idToken === null,
				),
			).toBe(true);
			expect(await harness.database.select().from(user)).toHaveLength(1);
			expect(await harness.database.select().from(session)).toHaveLength(1);
			const audit = await harness.database
				.select()
				.from(signInAudit)
				.where(eq(signInAudit.kind, 'login-linked'));
			expect(audit.map((entry) => entry.phase).toSorted()).toEqual(['intent', 'outcome']);
			expect(
				audit.every(
					(entry) =>
						entry.actorUserId === person.id &&
						entry.targetId === 'github' &&
						entry.changeKind === 'linked',
				),
			).toBe(true);
			expect(new Set(audit.map((entry) => entry.requestId)).size).toBe(1);
		} finally {
			await harness.close();
		}
	});

	it.each([
		{ first: 'google', second: 'github' },
		{ first: 'github', second: 'google' },
	] satisfies readonly {
		readonly first: SocialLoginProvider;
		readonly second: SocialLoginProvider;
	}[])(
		'refuses ordinary $first to $second email-match linking while the Person is already signed in',
		async ({ first, second }) => {
			const harness = await startLocalAuthHarness();
			try {
				await signIn(harness, first);
				const before = await identitySnapshot(harness);
				// Keeping the real cookie distinguishes normal sign-in from the explicit link step.
				const refused = await finishProviderRedirect(
					harness,
					second,
					await startProviderRedirect(harness, second, false),
				);
				expectCallbackRefused(refused);
				expect(await identitySnapshot(harness)).toEqual(before);
				expect(
					await harness.database
						.select()
						.from(signInAudit)
						.where(eq(signInAudit.kind, 'login-linked')),
				).toEqual([]);
			} finally {
				await harness.close();
			}
		},
	);

	it('refuses an unverified provider email during an explicit link without changing identities', async () => {
		const harness = await startLocalAuthHarness();
		try {
			await signIn(harness, 'google');
			const before = await identitySnapshot(harness);
			const refused = await finishProviderRedirect(
				harness,
				'github',
				await startProviderRedirect(harness, 'github', true),
				false,
			);
			expectCallbackRefused(refused);
			expect(await identitySnapshot(harness)).toEqual(before);
			expect(
				await harness.database
					.select()
					.from(signInAudit)
					.where(eq(signInAudit.kind, 'login-linked')),
			).toEqual([]);
		} finally {
			await harness.close();
		}
	});

	it('refuses the ID-token linking form before Better Auth or identity writes', async () => {
		const harness = await startLocalAuthHarness();
		try {
			await signIn(harness, 'google');
			const before = await identitySnapshot(harness);
			await Promise.all(
				[null, { token: 'untrusted-provider-token' }].map(async (idToken) => {
					const refused = await harness.auth('/api/auth/link-social', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ provider: 'github', idToken }),
					});
					expect(refused.status).toBe(400);
					expect(await refused.json()).toEqual({ error: 'redirect-linking-required' });
				}),
			);
			expect(await identitySnapshot(harness)).toEqual(before);
			expect(
				await harness.database
					.select()
					.from(signInAudit)
					.where(eq(signInAudit.kind, 'login-linked')),
			).toEqual([]);
		} finally {
			await harness.close();
		}
	});

	it('creates no linked account when the before-change audit write fails at the driver', async () => {
		const harness = await startLocalAuthHarness();
		try {
			await signIn(harness, 'google');
			const person = z
				.object({ id: z.uuidv7() })
				.parse((await harness.database.select().from(user))[0]);
			const before = await identitySnapshot(harness);
			const providerUrl = await startProviderRedirect(harness, 'github', true);
			await harness.setDatabaseFault({
				operation: 'insert',
				table: 'sign_in_audit',
				key: person.id,
				phase: 'intent',
				auditKind: 'login-linked',
			});
			const refused = await finishProviderRedirect(harness, 'github', providerUrl);
			expect([302, 503]).toContain(refused.status);
			if (refused.status === 302) expectCallbackRefused(refused);
			await harness.setDatabaseFault(null);
			expect(await identitySnapshot(harness)).toEqual(before);
			expect(
				await harness.database
					.select()
					.from(signInAudit)
					.where(eq(signInAudit.kind, 'login-linked')),
			).toEqual([]);
		} finally {
			await harness.close();
		}
	});

	it.each(['revoked-session', 'removed-standing'])(
		'requires current %s at initiation and again at the link callback',
		async (revocation) => {
			const harness = await startLocalAuthHarness();
			try {
				const signedOut = await harness.auth('/api/auth/link-social', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ provider: 'github' }),
				});
				expect(signedOut.status).toBe(403);
				await signIn(harness, 'google');
				const providerUrl = await startProviderRedirect(harness, 'github', true);
				const person = z
					.object({ id: z.uuidv7() })
					.parse((await harness.database.select().from(user))[0]);
				if (revocation === 'revoked-session')
					await harness.database.delete(session).where(eq(session.userId, person.id));
				else await harness.database.delete(member).where(eq(member.userId, person.id));
				const before = await identitySnapshot(harness);
				const refusedInitiation = await harness.auth('/api/auth/link-social', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ provider: 'github' }),
				});
				expect(refusedInitiation.status).toBe(403);
				const refused = await finishProviderRedirect(harness, 'github', providerUrl);
				expectCallbackRefused(refused);
				expect(await identitySnapshot(harness)).toEqual(before);
				expect(
					await harness.database
						.select()
						.from(signInAudit)
						.where(eq(signInAudit.kind, 'login-linked')),
				).toEqual([]);
			} finally {
				await harness.close();
			}
		},
	);
});
