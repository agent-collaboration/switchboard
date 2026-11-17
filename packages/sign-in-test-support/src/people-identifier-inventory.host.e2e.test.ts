import {
	account,
	invitation,
	jwks,
	member,
	organization,
	session,
	signInAudit,
	twoFactor,
	user,
} from '@agent-collaboration/sign-in-core';
import { expect, it } from 'vitest';
import { z } from 'zod';

import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import { controlledSignInIds } from '#sign-in-test-support/test-fixtures/controlled-sign-in-clock';
import { startLocalAuthHarness } from '#sign-in-test-support/test-fixtures/local-auth-harness';
import { ensureLocalOwnerOrganization } from '#sign-in-test-support/test-fixtures/local-owner-organization';
import {
	peoplePost,
	signInConfirmedPeopleBrowser,
} from '#sign-in-test-support/test-fixtures/people-browser-login';
import { readStoredUuidInventory } from '#sign-in-test-support/test-fixtures/stored-uuid-inventory';

useControlledSignInClock();
type Harness = Awaited<ReturnType<typeof startLocalAuthHarness>>;

// The harness picks the host the same way: Cloudflare (local workerd, D1) unless
// SIGN_IN_TEST_HOST=node (Node with better-sqlite3). Run once per host.
const signInHost = z
	.enum(['cloudflare', 'node'])
	.parse(process.env.SIGN_IN_TEST_HOST ?? 'cloudflare');
const ownerEmail = 'owner@example.invalid';
const memberEmail = 'member@example.invalid';

const isUuid = (value: string): boolean => z.uuid().safeParse(value).success;

/** S10: a secret or code is never a UUID of any version, which the inventory alone can't see. */
async function expectStoredSecretsAreNotUuids(harness: Harness): Promise<void> {
	const factors = await harness.database
		.select({ secret: twoFactor.secret, backupCodes: twoFactor.backupCodes })
		.from(twoFactor);
	expect(factors.length).toBeGreaterThan(0);
	for (const factor of factors) {
		expect(isUuid(factor.secret)).toBe(false);
		expect(isUuid(factor.backupCodes)).toBe(false);
	}
	const signingKeys = await harness.database.select({ privateKey: jwks.privateKey }).from(jwks);
	expect(signingKeys.length).toBeGreaterThan(0);
	for (const signingKey of signingKeys) expect(isUuid(signingKey.privateKey)).toBe(false);
	const sessions = await harness.database.select({ token: session.token }).from(session);
	expect(sessions.length).toBeGreaterThan(0);
	for (const stored of sessions) expect(isUuid(stored.token)).toBe(false);
}

it(`people journey on ${signInHost}: every stored UUID is v7 before the member's removal and after it, and no secret is a UUID`, async () => {
	const harness = await startLocalAuthHarness({ turnstileSecret: 'published-test' });
	try {
		// Arrange: the owner signs in, enrols the app (recovery codes), creates the organization
		// and runs the bootstrap that admin forwarding needs.
		const ownerId = await signInConfirmedPeopleBrowser({ harness, email: ownerEmail });
		const organizationId = await ensureLocalOwnerOrganization({
			auth: harness.auth,
			database: harness.database,
		});
		const bootstrap = await harness.auth('/api/auth/owner/bootstrap', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{}',
		});
		expect(bootstrap.status).toBe(200);
		await harness.settleDeferredWork();
		const ownerCookie = harness.cookie();

		// Act: one admin forwarding, an invitation, its acceptance.
		const forwarded = await harness.auth('/api/auth/organization-admin/create-workspace', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				origin: new URL(harness.issuer).origin,
				cookie: ownerCookie,
			},
			body: JSON.stringify({
				organizationId,
				operationId: controlledSignInIds.nextId(),
				name: 'research',
				description: '',
			}),
		});
		expect(forwarded.status).toBe(200);
		const invited = await peoplePost(
			harness,
			'invite-member',
			{ organizationId, email: memberEmail, role: 'member' },
			ownerCookie,
		);
		expect(invited.status).toBe(200);
		const invitationId = z.object({ id: z.uuidv7() }).parse(await invited.json()).id;
		const memberId = await signInConfirmedPeopleBrowser({ harness, email: memberEmail });
		expect((await peoplePost(harness, 'accept-invitation', { invitationId })).status).toBe(200);

		// Assert, before the removal: the tables this journey fills hold rows, so the inventory
		// can't pass by inspecting empty tables; then only v7 UUIDs anywhere.
		const filled = {
			user: (await harness.database.select({ id: user.id }).from(user)).length,
			session: (await harness.database.select({ id: session.id }).from(session)).length,
			account: (await harness.database.select({ id: account.id }).from(account)).length,
			organization: (await harness.database.select({ id: organization.id }).from(organization))
				.length,
			member: (await harness.database.select({ id: member.id }).from(member)).length,
			invitation: (await harness.database.select({ id: invitation.id }).from(invitation)).length,
			twoFactor: (await harness.database.select({ id: twoFactor.id }).from(twoFactor)).length,
			signInAudit: (await harness.database.select({ id: signInAudit.id }).from(signInAudit)).length,
		};
		for (const [table, rows] of Object.entries(filled))
			expect({ table, filled: rows > 0 }).toEqual({ table, filled: true });
		const beforeRemoval = await readStoredUuidInventory(harness.database);
		expect(beforeRemoval.uuidValues).toBeGreaterThan(0);
		expect(beforeRemoval.nonV7Locations).toEqual([]);
		await expectStoredSecretsAreNotUuids(harness);

		// Act: the owner removes the member.
		expect(
			(
				await peoplePost(
					harness,
					'remove-member',
					{ organizationId, memberIdOrEmail: memberEmail },
					ownerCookie,
				)
			).status,
		).toBe(200);

		// Assert, at the end: IDs the removal wrote are v7 too.
		const atEnd = await readStoredUuidInventory(harness.database);
		expect(atEnd.uuidValues).toBeGreaterThan(0);
		expect(atEnd.nonV7Locations).toEqual([]);
		await expectStoredSecretsAreNotUuids(harness);
		// Every recovery code each person was shown at enrolment is not a UUID.
		for (const email of [ownerEmail, memberEmail]) {
			const count = harness.totpAuthenticator.recoveryCodeCount(email);
			expect(count).toBeGreaterThan(0);
			for (let index = 0; index < count; index += 1)
				expect(isUuid(harness.totpAuthenticator.recoveryCode(email, index))).toBe(false);
		}
		expect([ownerId, memberId].every((id) => z.uuidv7().safeParse(id).success)).toBe(true);
	} finally {
		await harness.close();
	}
});
