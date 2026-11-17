import {
	passkey,
	session,
	signInAudit,
	verification,
	member,
} from '@agent-collaboration/sign-in-core';
import { getSessionCookie } from 'better-auth/cookies';
import { and, eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { z } from 'zod';

import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import { controlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-sign-in-clock';
import { readCurrentBrowserSession } from '#sign-in-test-support/test-fixtures/current-browser-session';
import { startLocalAuthHarness } from '#sign-in-test-support/test-fixtures/local-auth-harness';
import {
	ensureLocalOwnerOrganization,
	inviteLocalPerson,
	acceptLocalInvitations,
} from '#sign-in-test-support/test-fixtures/local-owner-organization';
import {
	registerBrowserPasskey,
	passkeyPost,
} from '#sign-in-test-support/test-fixtures/passkey-browser-ceremonies';
import {
	signInConfirmedPeopleBrowser,
	peoplePost,
} from '#sign-in-test-support/test-fixtures/people-browser-login';
import { createSoftwarePasskeyAuthenticator } from '#sign-in-test-support/test-fixtures/software-passkey-authenticator';

useControlledSignInClock();
type Harness = Awaited<ReturnType<typeof startLocalAuthHarness>>;
const email = 'owner@example.invalid';
const challengeSchema = z.object({ challenge: z.string().min(1), rpId: z.string() });
function token(harness: Harness): string {
	return harness.turnstile.issueToken({
		action: 'passkey_sign_in',
		hostname: new URL(harness.issuer).hostname,
		verdict: 'accepted',
	});
}
function challenge(harness: Harness, captcha: string = token(harness)): Promise<Response> {
	return harness.auth('/api/auth/passkey/generate-authenticate-options', {
		headers: { 'x-captcha-response': captcha },
	});
}
async function registered(harness: Harness): Promise<{
	readonly authenticator: Awaited<ReturnType<typeof createSoftwarePasskeyAuthenticator>>;
	readonly personId: string;
	readonly organizationId: string;
}> {
	const personId = await signInConfirmedPeopleBrowser({ harness, email });
	const organizationId = await ensureLocalOwnerOrganization(harness);
	const authenticator = await createSoftwarePasskeyAuthenticator();
	expect((await registerBrowserPasskey({ harness, authenticator })).status).toBe(200);
	// Signed-out test setup clears only the browser jar; baseline session rows remain observable.
	harness.clearBrowserSession();
	return { authenticator, personId, organizationId };
}
async function assertion(
	harness: Harness,
	authenticator: Awaited<ReturnType<typeof createSoftwarePasskeyAuthenticator>>,
	userVerified = true,
): Promise<Readonly<Record<string, unknown>>> {
	const response = await challenge(harness);
	expect(response.status).toBe(200);
	const options = challengeSchema.parse(await response.json());
	return {
		response: authenticator.authenticationResponse({
			challenge: options.challenge,
			rpId: options.rpId,
			origin: harness.issuer,
			userVerified,
		}),
	};
}
async function audit(harness: Harness): Promise<readonly unknown[]> {
	return harness.database
		.select({
			kind: signInAudit.kind,
			actor: signInAudit.actorUserId,
			outcome: signInAudit.changeKind,
			method: signInAudit.targetId,
		})
		.from(signInAudit)
		.where(and(eq(signInAudit.kind, 'sign-in'), eq(signInAudit.targetId, 'passkey')));
}
function expectSessionCookieAbsent(response: Response): void {
	expect(
		getSessionCookie(
			new Headers({
				cookie: response.headers
					.getSetCookie()
					.map((cookie) => cookie.split(';')[0])
					.join('; '),
			}),
		),
	).toBeNull();
}
function expectConfirmedInsert(
	insert: Awaited<ReturnType<Harness['lastSessionInsert']>>,
	milliseconds: number,
): void {
	const columns =
		/insert into "session" \(([^)]+)\)/iu
			.exec(insert.query)?.[1]
			?.split(',')
			.map((column) => column.trim().replaceAll('"', '')) ?? [];
	expect(columns).toContain('secondFactorAt');
	expect(columns).toContain('secondFactorMethod');
	const values =
		/\bvalues\s*\(([^)]+)\)/iu
			.exec(insert.query)?.[1]
			?.split(',')
			.map((value) => value.trim()) ?? [];
	for (const [column, expected] of [
		['secondFactorAt', milliseconds],
		['secondFactorMethod', 'passkey'],
	] as const) {
		const columnIndex = columns.indexOf(column);
		expect(values[columnIndex]).toBe('?');
		const parameterIndex = values.slice(0, columnIndex).filter((value) => value === '?').length;
		expect(insert.parameters[parameterIndex]).toBe(expected);
	}
}

it.each(['missing', 'rejected', 'wrong-action', 'duplicate', 'unavailable'] as const)(
	'people: public passkey challenge refuses %s without storing a challenge',
	async (reason) => {
		const harness = await startLocalAuthHarness({
			turnstileSecret: 'published-test',
			...(reason === 'unavailable' ? { siteVerify: 'connection-refused' as const } : {}),
		});
		try {
			expect((await harness.auth('/api/auth/jwks')).status).toBe(200);
			const captcha =
				reason === 'missing'
					? undefined
					: harness.turnstile.issueToken({
							action: reason === 'wrong-action' ? 'sign_in_social' : 'passkey_sign_in',
							hostname: new URL(harness.issuer).hostname,
							verdict: reason === 'rejected' ? 'rejected' : 'accepted',
						});
			if (reason === 'duplicate') expect((await challenge(harness, captcha)).status).toBe(200);
			expect((await harness.auth('/api/auth/jwks')).status).toBe(200);
			const before = await harness.database.select().from(verification);
			const response = await harness.auth('/api/auth/passkey/generate-authenticate-options', {
				headers: captcha === undefined ? {} : { 'x-captcha-response': captcha },
			});
			expect(response.status).toBe(
				reason === 'missing' ? 400 : reason === 'unavailable' ? 500 : 403,
			);
			expect(await harness.database.select().from(verification)).toEqual(before);
			expect(response.headers.getSetCookie()).toEqual([]);
			expect(await harness.captchaObservations()).toContainEqual({
				kind: 'captcha-refused',
				action: 'passkey_sign_in',
				reason,
			});
		} finally {
			await harness.close();
		}
	},
);
it('people: an accepted public passkey challenge stores exactly one challenge and its cookie', async () => {
	const harness = await startLocalAuthHarness();
	try {
		const before = await harness.database.select().from(verification);
		const response = await challenge(harness);
		expect(response.status).toBe(200);
		expect(challengeSchema.safeParse(await response.json()).success).toBe(true);
		expect(await harness.database.select().from(verification)).toHaveLength(before.length + 1);
		expect(response.headers.getSetCookie().some((cookie) => cookie.includes('passkey'))).toBe(true);
	} finally {
		await harness.close();
	}
});
it('people: a no-UV sign-in consumes its challenge, keeps the counter and sessions unchanged, and records refusal', async () => {
	const harness = await startLocalAuthHarness();
	try {
		const { authenticator } = await registered(harness);
		const body = await assertion(harness, authenticator, false);
		const sessions = await harness.database.select().from(session);
		const credentials = await harness.database.select().from(passkey);
		const response = await passkeyPost(harness, 'verify-authentication', body);
		expect(response.status).toBe(401);
		expect(await response.json()).toMatchObject({ code: 'USER_VERIFICATION_REQUIRED' });
		expectSessionCookieAbsent(response);
		expect(await harness.database.select().from(session)).toEqual(sessions);
		expect(await harness.database.select().from(passkey)).toEqual(credentials);
		expect(await audit(harness)).toEqual([
			{ kind: 'sign-in', actor: 'anonymous', outcome: 'failed', method: 'passkey' },
		]);
		const replay = await passkeyPost(harness, 'verify-authentication', body);
		expect(replay.status).toBe(400);
		expect(await replay.json()).toMatchObject({ code: 'CHALLENGE_NOT_FOUND' });
	} finally {
		await harness.close();
	}
});
it('people: a user-verified sign-in is born confirmed, releases no body token, and its 15-minute window expires', async () => {
	const harness = await startLocalAuthHarness();
	try {
		const { authenticator, personId, organizationId } = await registered(harness);
		const at = controlledSignInClock.now();
		const response = await passkeyPost(
			harness,
			'verify-authentication',
			await assertion(harness, authenticator),
		);
		expect(response.status).toBe(200);
		const current = await readCurrentBrowserSession({
			database: harness.database,
			cookie: harness.cookie(),
		});
		expect(current).toMatchObject({ personId, secondFactorAt: at, secondFactorMethod: 'passkey' });
		const rows = await harness.database.select().from(session).where(eq(session.id, current.id));
		const row = rows[0];
		if (row === undefined) throw new Error('Issued session missing');
		expect(row.activeOrganizationId).toBe(organizationId);
		expect(await response.text()).not.toContain(row.token);
		expectConfirmedInsert(await harness.lastSessionInsert(), at);
		expect(await audit(harness)).toEqual([
			{ kind: 'sign-in', actor: personId, outcome: 'succeeded', method: 'passkey' },
		]);
		expect(
			(
				await peoplePost(harness, 'invite-member', {
					email: 'fresh@example.invalid',
					role: 'member',
					organizationId,
				})
			).status,
		).toBe(200);
		expect(
			(
				await harness.auth('/__auth-proof/set-clock', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ milliseconds: at + 900_001 }),
				})
			).status,
		).toBe(200);
		const expired = await peoplePost(harness, 'invite-member', {
			email: 'late@example.invalid',
			role: 'member',
			organizationId,
		});
		expect(expired.status).toBe(403);
		expect(await expired.json()).toMatchObject({ code: 'SECOND_FACTOR_REQUIRED' });
	} finally {
		await harness.close();
	}
});
it('people: failure after the confirmed insert discards the cookie and deletes the issued session', async () => {
	const harness = await startLocalAuthHarness();
	try {
		const { authenticator } = await registered(harness);
		const body = await assertion(harness, authenticator);
		const before = await harness.database.select().from(session);
		await harness.failNextPasskeyUserRead();
		const response = await passkeyPost(harness, 'verify-authentication', body);
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({ error: 'sign-in-unavailable' });
		expectSessionCookieAbsent(response);
		expectConfirmedInsert(await harness.lastSessionInsert(), controlledSignInClock.now());
		expect(await harness.database.select().from(session)).toEqual(before);
		expect(await (await harness.auth('/api/auth/get-session')).json()).toBeNull();
		expect(await audit(harness)).toEqual([
			{ kind: 'sign-in', actor: 'anonymous', outcome: 'failed', method: 'passkey' },
		]);
	} finally {
		await harness.close();
	}
});
it('people: an unknown credential is refused and recorded without creating a session', async () => {
	const harness = await startLocalAuthHarness();
	try {
		expect((await harness.auth('/api/auth/jwks')).status).toBe(200);
		const authenticator = await createSoftwarePasskeyAuthenticator();
		const before = await harness.database.select().from(session);
		const response = await passkeyPost(
			harness,
			'verify-authentication',
			await assertion(harness, authenticator),
		);
		expect(response.status).toBe(401);
		expectSessionCookieAbsent(response);
		expect(await harness.database.select().from(session)).toEqual(before);
		expect(await audit(harness)).toEqual([
			{ kind: 'sign-in', actor: 'anonymous', outcome: 'failed', method: 'passkey' },
		]);
	} finally {
		await harness.close();
	}
});
it('people: a removed member cannot sign in with their registered user-verified passkey', async () => {
	const harness = await startLocalAuthHarness();
	try {
		await signInConfirmedPeopleBrowser({ harness, email });
		const organizationId = await ensureLocalOwnerOrganization(harness);
		const ownerCookie = harness.cookie();
		const invitedEmail = 'member@example.invalid';
		await inviteLocalPerson({ ...harness, email: invitedEmail });
		const personId = await signInConfirmedPeopleBrowser({ harness, email: invitedEmail });
		await acceptLocalInvitations({ ...harness, email: invitedEmail });
		const authenticator = await createSoftwarePasskeyAuthenticator();
		expect((await registerBrowserPasskey({ harness, authenticator })).status).toBe(200);
		harness.useBrowser(email);
		const membership = (
			await harness.database
				.select()
				.from(member)
				.where(and(eq(member.userId, personId), eq(member.organizationId, organizationId)))
		)[0];
		if (membership === undefined) throw new Error('Member setup missing');
		expect(
			(
				await peoplePost(
					harness,
					'remove-member',
					{
						organizationId,
						memberIdOrEmail: membership.id,
					},
					ownerCookie,
				)
			).status,
		).toBe(200);
		harness.useBrowser(invitedEmail);
		harness.clearBrowserSession();
		const before = await harness.database.select().from(session);
		const response = await passkeyPost(
			harness,
			'verify-authentication',
			await assertion(harness, authenticator),
		);
		expect(response.status).toBe(403);
		expectSessionCookieAbsent(response);
		expect(await harness.database.select().from(session)).toEqual(before);
		expect(await audit(harness)).toEqual([
			{ kind: 'sign-in', actor: 'anonymous', outcome: 'failed', method: 'passkey' },
		]);
	} finally {
		await harness.close();
	}
});
it('people: the public sign-in page carries the passkey island, action and nonced bootstrap with its CLI continuation', async () => {
	const harness = await startLocalAuthHarness();
	try {
		expect((await harness.auth('/api/auth/jwks')).status).toBe(200);
		const authorization = new URL('/api/auth/oauth2/authorize', harness.issuer);
		authorization.search = new URLSearchParams({
			client_id: harness.target.ownerCliClientId,
			response_type: 'code',
			scope: 'tool-portal:management',
			resource: harness.target.managementAudience,
			code_challenge_method: 'S256',
			code_challenge: 'test-only-challenge',
			redirect_uri: harness.target.ownerCliRedirectUri,
		}).toString();
		await Promise.all(
			[null, authorization.toString()].map(async (resume): Promise<void> => {
				const page = await harness.auth(
					'/sign-in' + (resume === null ? '' : `?authorize=${encodeURIComponent(resume)}`),
				);
				expect(page.status).toBe(200);
				const html = await page.text();
				expect(html).toContain('passkey-sign-in');
				expect(html).toContain('id="sign-in-passkey-captcha"');
				expect(html).toContain('data-action="passkey_sign_in"');
				const expected =
					'/owner-ready' + (resume === null ? '' : `?authorize=${encodeURIComponent(resume)}`);
				expect(html).toContain(expected.replaceAll('&', '&amp;'));
				expect(html).toMatch(
					/<script[^>]*nonce="[^"]+"[^>]*type="module"|<script[^>]*type="module"[^>]*nonce="[^"]+"/u,
				);
			}),
		);
	} finally {
		await harness.close();
	}
});

it('people: an unavailable sign-in audit write refuses the confirmed session and cleans it up', async () => {
	const harness = await startLocalAuthHarness();
	try {
		const { authenticator, personId } = await registered(harness);
		const body = await assertion(harness, authenticator);
		const before = await harness.database.select().from(session);
		await harness.setDatabaseFault({
			operation: 'insert',
			table: 'sign_in_audit',
			key: personId,
			auditKind: 'sign-in',
		});
		const response = await passkeyPost(harness, 'verify-authentication', body);
		expect(response.status).toBe(503);
		expectSessionCookieAbsent(response);
		expect(await response.json()).toEqual({ error: 'sign-in-unavailable' });
		expect(await harness.database.select().from(session)).toEqual(before);
		expect(await (await harness.auth('/api/auth/get-session')).json()).toBeNull();
	} finally {
		await harness.close();
	}
});
