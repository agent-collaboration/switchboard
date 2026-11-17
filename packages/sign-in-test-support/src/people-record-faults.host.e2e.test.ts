import {
	invitation,
	member,
	organization,
	personOrganizationAuthorizationRevisions as personFence,
	signInAudit,
} from '@agent-collaboration/sign-in-core';
import { and, eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { z } from 'zod';

import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import { startLocalAuthHarness } from '#sign-in-test-support/test-fixtures/local-auth-harness';
import { ensureLocalOwnerOrganization } from '#sign-in-test-support/test-fixtures/local-owner-organization';
import {
	peoplePost,
	signInConfirmedPeopleBrowser,
} from '#sign-in-test-support/test-fixtures/people-browser-login';

useControlledSignInClock();
type Harness = Awaited<ReturnType<typeof startLocalAuthHarness>>;
type Change = 'invited' | 'invitation-accepted' | 'invitation-cancelled' | 'member-removed';

async function prepareChange(
	harness: Harness,
	change: Change,
): Promise<{
	readonly targetId: string;
	readonly actorId: string;
	readonly organizationId: string;
	readonly attempt: () => Promise<Response>;
	readonly changed: () => Promise<boolean>;
}> {
	const ownerId = await signInConfirmedPeopleBrowser({ harness, email: 'owner@example.invalid' });
	const organizationId = await ensureLocalOwnerOrganization({
		auth: harness.auth,
		database: harness.database,
	});
	const ownerCookie = harness.cookie();
	const email = 'target@example.invalid';
	if (change === 'invited')
		return {
			targetId: email,
			actorId: ownerId,
			organizationId,
			attempt: () =>
				peoplePost(
					harness,
					'invite-member',
					{ organizationId, email, role: 'member' },
					ownerCookie,
				),
			changed: async () =>
				(await harness.database.select().from(invitation).where(eq(invitation.email, email)))
					.length === 1,
		};
	const invited = await peoplePost(
		harness,
		'invite-member',
		{ organizationId, email, role: 'member' },
		ownerCookie,
	);
	if (!invited.ok) throw new Error('Fault precondition invitation refused');
	const invitationId = z.object({ id: z.uuidv7() }).parse(await invited.json()).id;
	if (change === 'invitation-cancelled')
		return {
			targetId: invitationId,
			actorId: ownerId,
			organizationId,
			attempt: () => peoplePost(harness, 'cancel-invitation', { invitationId }, ownerCookie),
			changed: async () =>
				(
					await harness.database
						.select({ status: invitation.status })
						.from(invitation)
						.where(eq(invitation.id, invitationId))
				)[0]?.status === 'canceled',
		};
	const personId = await signInConfirmedPeopleBrowser({ harness, email });
	const memberCookie = harness.cookie();
	if (change === 'invitation-accepted')
		return {
			targetId: invitationId,
			actorId: personId,
			organizationId,
			attempt: () => peoplePost(harness, 'accept-invitation', { invitationId }, memberCookie),
			changed: async () =>
				(
					await harness.database
						.select()
						.from(member)
						.where(and(eq(member.userId, personId), eq(member.organizationId, organizationId)))
				).length === 1,
		};
	const accepted = await peoplePost(harness, 'accept-invitation', { invitationId }, memberCookie);
	if (!accepted.ok) throw new Error('Fault precondition acceptance refused');
	return {
		targetId: personId,
		actorId: ownerId,
		organizationId,
		attempt: () =>
			peoplePost(harness, 'remove-member', { organizationId, memberIdOrEmail: email }, ownerCookie),
		changed: async () =>
			(await harness.database.select().from(member).where(eq(member.userId, personId))).length ===
			0,
	};
}
async function authoritySnapshot(harness: Harness): Promise<unknown> {
	return {
		organizations: await harness.database.select().from(organization),
		members: await harness.database.select().from(member),
		invitations: await harness.database.select().from(invitation),
		audit: await harness.database.select().from(signInAudit).orderBy(signInAudit.id),
	};
}

for (const change of [
	'invited',
	'invitation-accepted',
	'invitation-cancelled',
	'member-removed',
] satisfies readonly Change[]) {
	it(`people: ${change} refuses before its native effect when the intent record is unwritable`, async () => {
		const harness = await startLocalAuthHarness();
		try {
			const prepared = await prepareChange(harness, change);
			const before = await authoritySnapshot(harness);
			await harness.setDatabaseFault({
				operation: 'insert',
				table: 'sign_in_audit',
				key: prepared.targetId,
				phase: 'intent',
				changeKind: change,
			});
			expect((await prepared.attempt()).status).toBe(503);
			await harness.setDatabaseFault(null);
			expect(await authoritySnapshot(harness)).toEqual(before);
		} finally {
			await harness.close();
		}
	});
	it(`people: ${change} keeps an unconfirmed intent when its native effect succeeds but the outcome record is lost`, async () => {
		const harness = await startLocalAuthHarness();
		try {
			const prepared = await prepareChange(harness, change);
			await harness.setDatabaseFault({
				operation: 'insert',
				table: 'sign_in_audit',
				key: prepared.targetId,
				phase: 'outcome',
				changeKind: change,
			});
			expect((await prepared.attempt()).status).toBe(503);
			await harness.setDatabaseFault(null);
			expect(await prepared.changed()).toBe(true);
			// r3 section 9, after-hook crash: the fence committed in the native row's own batch.
			// The fenced person is the removed member, or the person who accepted.
			const fencedPersonId = change === 'member-removed' ? prepared.targetId : prepared.actorId;
			if (change === 'member-removed' || change === 'invitation-accepted')
				expect(
					await harness.database
						.select({ revision: personFence.revision, state: personFence.state })
						.from(personFence)
						.where(
							and(
								eq(personFence.organizationId, prepared.organizationId),
								eq(personFence.personId, fencedPersonId),
							),
						),
				).toEqual([
					change === 'member-removed'
						? { revision: 2, state: 'inactive' }
						: { revision: 1, state: 'active' },
				]);
			const rows = await harness.database
				.select()
				.from(signInAudit)
				.where(
					and(eq(signInAudit.changeKind, change), eq(signInAudit.targetId, prepared.targetId)),
				);
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({
				phase: 'intent',
				actorUserId: prepared.actorId,
				organizationId: prepared.organizationId,
			});
			// A later real request must not settle history from current membership or invitation status.
			await harness.auth('/owner-ready');
			expect(
				await harness.database
					.select()
					.from(signInAudit)
					.where(
						and(eq(signInAudit.changeKind, change), eq(signInAudit.targetId, prepared.targetId)),
					),
			).toEqual(rows);
		} finally {
			await harness.close();
		}
	});
}

it('people: resend with a pending invitation and unavailable audit preserves expiry, status and every recorded field', async () => {
	const harness = await startLocalAuthHarness();
	try {
		await signInConfirmedPeopleBrowser({ harness, email: 'owner@example.invalid' });
		const organizationId = await ensureLocalOwnerOrganization({
			auth: harness.auth,
			database: harness.database,
		});
		const email = 'pending@example.invalid';
		expect(
			(await peoplePost(harness, 'invite-member', { organizationId, email, role: 'member' }))
				.status,
		).toBe(200);
		const before = await authoritySnapshot(harness);
		await harness.setDatabaseFault({ operation: 'insert', table: 'sign_in_audit', key: email });
		const refused = await peoplePost(harness, 'invite-member', {
			organizationId,
			email,
			role: 'member',
			resend: true,
		});
		expect(refused.status).toBe(400);
		expect(await refused.json()).toEqual({ error: 'invitation-resend-not-allowed' });
		await harness.setDatabaseFault(null);
		expect(await authoritySnapshot(harness)).toEqual(before);
	} finally {
		await harness.close();
	}
});
