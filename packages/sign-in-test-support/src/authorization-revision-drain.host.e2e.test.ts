import {
	organizationAuthorizationRevisions as organizationFence,
	personOrganizationAuthorizationRevisions as personFence,
} from '@agent-collaboration/sign-in-core';
import { and, eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { z } from 'zod';

import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import { controlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-sign-in-clock';
import { startLocalAuthHarness } from '#sign-in-test-support/test-fixtures/local-auth-harness';
import { ensureLocalOwnerOrganization } from '#sign-in-test-support/test-fixtures/local-owner-organization';
import {
	peoplePost,
	signInConfirmedPeopleBrowser,
} from '#sign-in-test-support/test-fixtures/people-browser-login';

// The recording peer stands in for central: it models only the wire's
// floor ordering and retained ACK. Central's own floor apply and ACK-after-commit are its proof.
useControlledSignInClock();
type Harness = Awaited<ReturnType<typeof startLocalAuthHarness>>;
const host = process.env.SIGN_IN_TEST_HOST ?? 'cloudflare';

interface Fixture {
	readonly harness: Harness;
	readonly ownerId: string;
	readonly memberId: string;
	readonly organizationId: string;
	readonly ownerCookie: string;
}

/** Owner creates an organization and a member joins, all through production routes. */
async function setup(): Promise<Fixture> {
	const harness = await startLocalAuthHarness();
	try {
		harness.centralProvisioning.replyWith('provisioned');
		const ownerId = await signInConfirmedPeopleBrowser({ harness, email: 'owner@example.invalid' });
		const organizationId = await ensureLocalOwnerOrganization({
			auth: harness.auth,
			database: harness.database,
		});
		const ownerCookie = harness.cookie();
		const invited = await peoplePost(
			harness,
			'invite-member',
			{ organizationId, email: 'member@example.invalid', role: 'member' },
			ownerCookie,
		);
		const invitationId = z.object({ id: z.uuidv7() }).parse(await invited.json()).id;
		const memberId = await signInConfirmedPeopleBrowser({
			harness,
			email: 'member@example.invalid',
		});
		expect((await peoplePost(harness, 'accept-invitation', { invitationId })).status).toBe(200);
		await harness.settleDeferredWork();
		return { harness, ownerId, memberId, organizationId, ownerCookie };
	} catch (error) {
		await harness.close();
		throw error;
	}
}

async function pairOf(
	harness: Harness,
	organizationId: string,
	personId: string,
): Promise<{
	readonly id: string;
	readonly revision: number;
	readonly acknowledgedRevision: number;
	readonly state: string;
}> {
	const row = (
		await harness.database
			.select({
				id: personFence.id,
				revision: personFence.revision,
				acknowledgedRevision: personFence.acknowledgedRevision,
				state: personFence.state,
			})
			.from(personFence)
			.where(
				and(eq(personFence.organizationId, organizationId), eq(personFence.personId, personId)),
			)
	)[0];
	if (row === undefined) throw new Error('Retained pair missing');
	return row;
}

async function synchronization(
	harness: Harness,
	scope: Readonly<Record<string, unknown>>,
): Promise<unknown> {
	const response = await harness.auth('/__auth-proof/authorization-sync', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(scope),
	});
	return z.object({ kind: z.literal('available'), value: z.string() }).parse(await response.json())
		.value;
}

async function removeMember(fixture: Fixture): Promise<void> {
	expect(
		(
			await peoplePost(
				fixture.harness,
				'remove-member',
				{ organizationId: fixture.organizationId, memberIdOrEmail: 'member@example.invalid' },
				fixture.ownerCookie,
			)
		).status,
	).toBe(200);
}

/** What a lost hint's after-response drain runs on either host; no timer runs it (WS3). */
async function hintDrain(harness: Harness): Promise<void> {
	expect((await harness.auth('/__auth-proof/authorization-drain', { method: 'POST' })).status).toBe(
		200,
	);
}

/** The guard run every sign-in to Fleet call makes for this organization before it goes out. */
async function nextFleetCall(harness: Harness, organizationId: string): Promise<unknown> {
	const response = await harness.auth('/__auth-proof/organization-fleet-call', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ organizationId }),
	});
	expect(response.status).toBe(200);
	return response.json();
}

async function setHostClock(harness: Harness, milliseconds: number): Promise<void> {
	const response = await harness.auth('/__auth-proof/set-clock', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ milliseconds }),
	});
	expect(response.status).toBe(200);
}

it('drain: setup pushed the organization row before any person row, and each ACK was recorded', async () => {
	const { harness, ownerId, memberId, organizationId } = await setup();
	try {
		const kinds = harness.centralProvisioning.pushes
			.filter((push) => push.organizationId === organizationId)
			.map((push) => push.kind);
		expect(kinds[0]).toBe('organization');
		expect(kinds.slice(1).every((kind) => kind === 'person')).toBe(true);
		const fence = (
			await harness.database
				.select()
				.from(organizationFence)
				.where(eq(organizationFence.id, organizationId))
		)[0];
		expect(fence).toMatchObject({ revision: 1, acknowledgedRevision: 1 });
		for (const personId of [ownerId, memberId])
			expect(await pairOf(harness, organizationId, personId)).toMatchObject({
				revision: 1,
				acknowledgedRevision: 1,
			});
	} finally {
		await harness.close();
	}
});

it('drain: a production removal is pushed by its after-response hint alone, then ACKed and synced', async () => {
	// Arrange: no cron fires and no timer runs in this harness, so only the hint can drain.
	const fixture = await setup();
	const { harness, memberId, organizationId } = fixture;
	try {
		const pushesBefore = harness.centralProvisioning.pushes.length;
		// Act
		await removeMember(fixture);
		await harness.settleDeferredWork();
		// Assert: the peer saw exactly the removed pair's new version.
		const pair = await pairOf(harness, organizationId, memberId);
		expect(harness.centralProvisioning.pushes.slice(pushesBefore)).toEqual([
			{
				kind: 'person',
				organizationId,
				personId: memberId,
				subjectId: pair.id,
				revision: 2,
				state: 'inactive',
			},
		]);
		expect(pair).toMatchObject({ revision: 2, acknowledgedRevision: 2, state: 'inactive' });
		expect(
			await synchronization(harness, {
				kind: 'personInOrganization',
				organizationId,
				personId: memberId,
			}),
		).toBe('synced');
	} finally {
		await fixture.harness.close();
	}
});

it("drain: a lost ACK leaves the pair pending and unsynced until the organization's next Fleet call delivers it, with no timer and no retry wait", async () => {
	const fixture = await setup();
	const { harness, memberId, organizationId } = fixture;
	try {
		// Arrange: central applies the floor but its reply is lost.
		harness.centralProvisioning.replyToPushesWith('lost-reply');
		await removeMember(fixture);
		await harness.settleDeferredWork();
		expect(await pairOf(harness, organizationId, memberId)).toMatchObject({
			revision: 2,
			acknowledgedRevision: 1,
		});
		expect(
			await synchronization(harness, {
				kind: 'personInOrganization',
				organizationId,
				personId: memberId,
			}),
		).toBe('pending');
		// Another hint's drain before the retry time leaves it alone.
		harness.centralProvisioning.replyToPushesWith('acknowledge');
		const pushesBeforeRetry = harness.centralProvisioning.pushes.length;
		await hintDrain(harness);
		expect(harness.centralProvisioning.pushes.length).toBe(pushesBeforeRetry);
		// Act: the organization's next Fleet call delivers it first, before its retry time.
		try {
			expect(await nextFleetCall(harness, organizationId)).toMatchObject({
				kind: 'ready',
				revisions: { kind: 'delivered', acknowledged: 1 },
			});
			// Assert
			expect(harness.centralProvisioning.pushes.slice(pushesBeforeRetry)).toEqual([
				expect.objectContaining({
					kind: 'person',
					personId: memberId,
					revision: 2,
					state: 'inactive',
				}),
			]);
			expect(await pairOf(harness, organizationId, memberId)).toMatchObject({
				revision: 2,
				acknowledgedRevision: 2,
			});
			expect(
				await synchronization(harness, {
					kind: 'personInOrganization',
					organizationId,
					personId: memberId,
				}),
			).toBe('synced');
		} finally {
			await setHostClock(harness, controlledSignInClock.now());
		}
	} finally {
		await harness.close();
	}
});

it('drain: a recipient that lost its organization floor gets the organization resent, then the person', async () => {
	const fixture = await setup();
	const { harness, memberId, organizationId } = fixture;
	try {
		harness.centralProvisioning.forgetFloors();
		const pushesBefore = harness.centralProvisioning.pushes.length;
		await removeMember(fixture);
		await harness.settleDeferredWork();
		expect(harness.centralProvisioning.pushes.slice(pushesBefore).map((push) => push.kind)).toEqual(
			['person', 'organization', 'person'],
		);
		expect(await pairOf(harness, organizationId, memberId)).toMatchObject({
			revision: 2,
			acknowledgedRevision: 2,
		});
		// The source's organization ACK is neither lowered nor reset.
		expect(
			(
				await harness.database
					.select({ acknowledgedRevision: organizationFence.acknowledgedRevision })
					.from(organizationFence)
					.where(eq(organizationFence.id, organizationId))
			)[0],
		).toEqual({ acknowledgedRevision: 1 });
	} finally {
		await harness.close();
	}
});

it.runIf(host === 'cloudflare')(
	'drain: workerd has no scheduled handler, so no cron can run a drain, backfill or renewal (owner, 12 Nov)',
	async () => {
		const fixture = await setup();
		try {
			for (const cron of ['*/5 * * * *', '0 0 * * *'])
				// oxlint-disable-next-line no-await-in-loop -- each former cron, in turn.
				await expect(fixture.harness.fireCron(cron)).rejects.toThrow();
		} finally {
			await fixture.harness.close();
		}
	},
);
