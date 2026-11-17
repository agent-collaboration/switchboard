import {
	member,
	personOrganizationAuthorizationRevisions as personFence,
	session,
	user,
	type PersonId,
} from '@agent-collaboration/sign-in-core';
import { and, eq } from 'drizzle-orm';

import type { StorageCaseContext } from '#sign-in-test-support/storage-cases/storage-case-context';
import type { StorageCaseDefinition } from '#sign-in-test-support/storage-cases/storage-case-registry';
import {
	createStorageMembership,
	createStoragePerson,
} from '#sign-in-test-support/storage-cases/storage-case-utilities';

async function pairsOf(
	context: StorageCaseContext,
	personId: PersonId,
): Promise<
	readonly { readonly organizationId: string; readonly revision: number; readonly state: string }[]
> {
	return context
		.openDatabase()
		.select({
			organizationId: personFence.organizationId,
			revision: personFence.revision,
			state: personFence.state,
		})
		.from(personFence)
		.where(eq(personFence.personId, personId))
		.orderBy(personFence.organizationId);
}

async function insertSession(context: StorageCaseContext, personId: PersonId): Promise<string> {
	const id = context.platform.ids.nextId();
	await context
		.openDatabase()
		.insert(session)
		.values({
			id,
			token: `fence-session-${id}`,
			userId: personId,
			createdAt: new Date(context.platform.clock.now()),
			updatedAt: new Date(context.platform.clock.now()),
			expiresAt: new Date(context.platform.clock.now() + 60_000),
		});
	return id;
}

/** Leave a retained, removed pair behind, as a native removal would. */
async function removeMembershipKeepingPair(
	context: StorageCaseContext,
	personId: PersonId,
	organizationId: string,
): Promise<void> {
	await context
		.openDatabase()
		.delete(member)
		.where(and(eq(member.organizationId, organizationId), eq(member.userId, personId)));
	await context
		.openDatabase()
		.update(personFence)
		.set({ revision: 2, state: 'inactive' })
		.where(and(eq(personFence.organizationId, organizationId), eq(personFence.personId, personId)));
}

async function sessionCleanupFansOut(context: StorageCaseContext): Promise<unknown> {
	// Arrange: one current membership and one removed organization's retained pair.
	const personId = await createStoragePerson(context, 'fence-session@example.invalid');
	const current = await createStorageMembership(context, personId, 'member');
	const removed = await createStorageMembership(context, personId, 'member');
	await removeMembershipKeepingPair(context, personId, removed);
	const sessionId = await insertSession(context, personId);
	// Act: the release fence's cleanup path.
	const deleted = await context.store.persons.deleteSession(sessionId);
	const afterDelete = {
		result: deleted.kind,
		sessionRows: (
			await context.openDatabase().select().from(session).where(eq(session.id, sessionId))
		).length,
		pairs: await pairsOf(context, personId),
	};
	// Arrange again: a required retained pair goes missing.
	await context
		.openDatabase()
		.delete(personFence)
		.where(and(eq(personFence.organizationId, current), eq(personFence.personId, personId)));
	const heldSessionId = await insertSession(context, personId);
	const refused = await context.store.persons.deleteSession(heldSessionId);
	return {
		afterDelete: {
			...afterDelete,
			pairs: afterDelete.pairs.map((pair) => ({
				...pair,
				organizationId: pair.organizationId === current ? 'current' : 'removed',
			})),
		},
		missingPair: {
			result: refused.kind,
			sessionRows: (
				await context.openDatabase().select().from(session).where(eq(session.id, heldSessionId))
			).length,
			pairs: (await pairsOf(context, personId)).map((pair) => ({
				...pair,
				organizationId: pair.organizationId === current ? 'current' : 'removed',
			})),
		},
	};
}

async function unboundPersonDeletionInactivatesPairs(
	context: StorageCaseContext,
): Promise<unknown> {
	// Arrange: a person whose only membership was removed, leaving a retained pair.
	const personId = await createStoragePerson(context, 'fence-cleanup@example.invalid');
	const removed = await createStorageMembership(context, personId, 'member');
	await removeMembershipKeepingPair(context, personId, removed);
	// A second person still holds a membership, so cleanup must leave them alone.
	const boundId = await createStoragePerson(context, 'fence-bound@example.invalid');
	await createStorageMembership(context, boundId, 'member');
	const boundBefore = await pairsOf(context, boundId);
	// Act
	const cleaned = await context.store.persons.cleanupUnboundPerson(personId);
	const protectedCleanup = await context.store.persons.cleanupUnboundPerson(boundId);
	// Assert data
	return {
		cleaned: cleaned.kind,
		deletedUserRows: (await context.openDatabase().select().from(user).where(eq(user.id, personId)))
			.length,
		retainedPairs: (await pairsOf(context, personId)).map(({ revision, state }) => ({
			revision,
			state,
		})),
		protectedCleanup: protectedCleanup.kind,
		boundUnchanged: JSON.stringify(await pairsOf(context, boundId)) === JSON.stringify(boundBefore),
	};
}

export const authorizationFenceStoreCases: readonly StorageCaseDefinition[] = [
	{
		name: 'authorization fence: release-fence session cleanup bumps every retained pair, including a removed organization, and aborts on a missing pair',
		// r3 section 3: session end bumps every retained pair of the person, preserving state;
		// a missing required pair aborts the batch and leaves the session in place.
		expected: {
			afterDelete: {
				result: 'available',
				sessionRows: 0,
				// Ordered by organization ID; the current organization's UUIDv7 was minted first.
				pairs: [
					{ organizationId: 'current', revision: 2, state: 'active' },
					{ organizationId: 'removed', revision: 3, state: 'inactive' },
				],
			},
			missingPair: {
				result: 'store-unavailable',
				sessionRows: 1,
				pairs: [{ organizationId: 'removed', revision: 3, state: 'inactive' }],
			},
		},
		run: sessionCleanupFansOut,
	},
	{
		name: 'authorization fence: deleting an unbound person inactivates and bumps its retained pairs in the same batch',
		// r3 section 3, user delete: increment all that person's retained pairs; inactive.
		expected: {
			cleaned: 'available',
			deletedUserRows: 0,
			retainedPairs: [{ revision: 3, state: 'inactive' }],
			protectedCleanup: 'available',
			boundUnchanged: true,
		},
		run: unboundPersonDeletionInactivatesPairs,
	},
];
