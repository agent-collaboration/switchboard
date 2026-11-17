import {
	organizationAuthorizationRevisions as organizationFence,
	personOrganizationAuthorizationRevisions as personFence,
	type PersonId,
} from '@agent-collaboration/sign-in-core';
import { and, eq } from 'drizzle-orm';

import type { StorageCaseContext } from '#sign-in-test-support/storage-cases/storage-case-context';
import type { StorageCaseDefinition } from '#sign-in-test-support/storage-cases/storage-case-registry';
import {
	createStorageMembership,
	createStoragePerson,
} from '#sign-in-test-support/storage-cases/storage-case-utilities';

async function pair(
	context: StorageCaseContext,
	personId: PersonId,
	organizationId: string,
): Promise<{
	readonly id: string;
	readonly revision: number;
	readonly acknowledgedRevision: number;
}> {
	const row = (
		await context
			.openDatabase()
			.select({
				id: personFence.id,
				revision: personFence.revision,
				acknowledgedRevision: personFence.acknowledgedRevision,
			})
			.from(personFence)
			.where(
				and(eq(personFence.personId, personId), eq(personFence.organizationId, organizationId)),
			)
	)[0];
	if (row === undefined) throw new Error('Retained pair missing');
	return row;
}

async function setPairRevision(
	context: StorageCaseContext,
	subjectId: string,
	revision: number,
): Promise<void> {
	await context
		.openDatabase()
		.update(personFence)
		.set({ revision })
		.where(eq(personFence.id, subjectId));
}

/** Storage-case results are compared as data; an unavailable store fails the case loudly. */
function unwrap<TValue>(
	result:
		| { readonly kind: 'available'; readonly value: TValue }
		| { readonly kind: 'store-unavailable' },
): TValue {
	if (result.kind !== 'available') throw new Error('Store unavailable in a delivery case');
	return result.value;
}

async function conditionalAcknowledgement(context: StorageCaseContext): Promise<unknown> {
	// Arrange: a pair at revision 3 whose ACK is behind.
	const personId = await createStoragePerson(context, 'delivery-ack@example.invalid');
	const organizationId = await createStorageMembership(context, personId, 'member');
	const subject = await pair(context, personId, organizationId);
	await setPairRevision(context, subject.id, 3);
	const ack = (
		acknowledgedRevision: number,
	): ReturnType<StorageCaseContext['store']['revisionDelivery']['recordPersonAcknowledgement']> =>
		context.store.revisionDelivery.recordPersonAcknowledgement({
			subjectId: subject.id,
			organizationId,
			personId,
			acknowledgedRevision,
		});
	const isPending = async (): Promise<boolean> =>
		unwrap(await context.store.revisionDelivery.readPending({ limit: 100 })).persons.some(
			(row) => row.subjectId === subject.id,
		);
	// Act / Assert, in order: N while the row is at N+1, an older ACK, one above current, the current one.
	const ackTwo = unwrap(await ack(2));
	const afterTwo = {
		ack: (await pair(context, personId, organizationId)).acknowledgedRevision,
		pending: await isPending(),
	};
	const ackOne = unwrap(await ack(1));
	const afterOne = (await pair(context, personId, organizationId)).acknowledgedRevision;
	const ackFour = unwrap(await ack(4));
	const afterFour = (await pair(context, personId, organizationId)).acknowledgedRevision;
	const ackThree = unwrap(await ack(3));
	return {
		ackTwo,
		afterTwo,
		ackOne,
		afterOne,
		ackFour,
		afterFour,
		ackThree,
		finallyPending: await isPending(),
	};
}

async function retrySchedule(context: StorageCaseContext): Promise<unknown> {
	const personId = await createStoragePerson(context, 'delivery-retry@example.invalid');
	const organizationId = await createStorageMembership(context, personId, 'member');
	const subject = await pair(context, personId, organizationId);
	await setPairRevision(context, subject.id, 2);
	const pendingIds = async (): Promise<readonly string[]> =>
		unwrap(await context.store.revisionDelivery.readPending({ limit: 100 })).persons.map(
			(row) => row.subjectId,
		);
	const later = context.platform.clock.now() + 60_000;
	// A defer naming an older pushed revision must not delay the current one.
	await context.store.revisionDelivery.deferPerson({
		subjectId: subject.id,
		pushedRevision: 1,
		nextAttemptAt: later,
	});
	const afterStaleDefer = (await pendingIds()).includes(subject.id);
	await context.store.revisionDelivery.deferPerson({
		subjectId: subject.id,
		pushedRevision: 2,
		nextAttemptAt: later,
	});
	const afterDefer = (await pendingIds()).includes(subject.id);
	context.setTime(later);
	const atRetryTime = (await pendingIds()).includes(subject.id);
	return { afterStaleDefer, afterDefer, atRetryTime };
}

async function synchronizationScopes(context: StorageCaseContext): Promise<unknown> {
	// Arrange: one person in two organizations; nothing ACKed yet.
	const personId = await createStoragePerson(context, 'delivery-sync@example.invalid');
	const first = await createStorageMembership(context, personId, 'member');
	const second = await createStorageMembership(context, personId, 'member');
	const read = async (
		scope: Parameters<StorageCaseContext['store']['revisionDelivery']['readSynchronization']>[0],
	): Promise<unknown> => unwrap(await context.store.revisionDelivery.readSynchronization(scope));
	const acknowledgeOrganization = async (organizationId: string): Promise<void> => {
		await context.store.revisionDelivery.recordOrganizationAcknowledgement({
			organizationId,
			acknowledgedRevision: 1,
		});
	};
	const acknowledgePair = async (organizationId: string): Promise<void> => {
		const subject = await pair(context, personId, organizationId);
		await context.store.revisionDelivery.recordPersonAcknowledgement({
			subjectId: subject.id,
			organizationId,
			personId,
			acknowledgedRevision: subject.revision,
		});
	};
	const missingAcks = await read({ kind: 'personInOrganization', organizationId: first, personId });
	await acknowledgePair(first);
	const pairOnly = await read({ kind: 'personInOrganization', organizationId: first, personId });
	await acknowledgeOrganization(first);
	const bothAcked = await read({ kind: 'personInOrganization', organizationId: first, personId });
	const everywhereOneLagging = await read({ kind: 'personEverywhere', personId });
	await acknowledgePair(second);
	// Every pair's organization floor counts for personEverywhere.
	const everywhereFloorLagging = await read({ kind: 'personEverywhere', personId });
	const organizationLagging = await read({ kind: 'organization', organizationId: second });
	await acknowledgeOrganization(second);
	const organizationSynced = await read({ kind: 'organization', organizationId: second });
	const everywhereSynced = await read({ kind: 'personEverywhere', personId });
	// With every other fence caught up, a pair whose floor row is gone keeps it pending.
	await context.openDatabase().delete(organizationFence).where(eq(organizationFence.id, second));
	const everywhereFloorMissing = await read({ kind: 'personEverywhere', personId });
	// The N/N+1 case: a later bump keeps the scope pending until its own ACK.
	await setPairRevision(context, (await pair(context, personId, first)).id, 2);
	const afterBump = await read({ kind: 'personInOrganization', organizationId: first, personId });
	const unknownPerson = await read({
		kind: 'personEverywhere',
		personId: context.platform.ids.nextId(),
	});
	const unknownOrganization = await read({
		kind: 'organization',
		organizationId: context.platform.ids.nextId(),
	});
	return {
		missingAcks,
		pairOnly,
		bothAcked,
		everywhereOneLagging,
		everywhereFloorLagging,
		organizationLagging,
		organizationSynced,
		everywhereSynced,
		afterBump,
		everywhereFloorMissing,
		unknownPerson,
		unknownOrganization,
	};
}

const isPairFenceRead = (query: string): boolean =>
	/^select\b/iu.test(query) && query.includes('from "person_organization_authorization_revisions"');

/**
 * The Verifier's interleaving: right after the status read has its pair rows, a
 * concurrent writer bumps an ACKed pair to N+1 and ACKs the lagging organization. At no instant
 * was the scope synced, so a read that sees one snapshot answers pending; reads taken apart see
 * the old pair and the new ACK and answer synced. The writer runs in both builds, never on a timer.
 */
async function interleavedSynchronization(context: StorageCaseContext): Promise<unknown> {
	const delivery = context.store.revisionDelivery;
	const acknowledgePair = async (personId: PersonId, organizationId: string): Promise<void> => {
		const subject = await pair(context, personId, organizationId);
		unwrap(
			await delivery.recordPersonAcknowledgement({
				subjectId: subject.id,
				organizationId,
				personId,
				acknowledgedRevision: subject.revision,
			}),
		);
	};
	const acknowledgeOrganization = async (organizationId: string): Promise<void> => {
		unwrap(
			await delivery.recordOrganizationAcknowledgement({ organizationId, acknowledgedRevision: 1 }),
		);
	};
	/** One atomic write, so on SQLite it lands whole in the first gap the reader leaves. */
	const bumpPairAndAcknowledgeOrganization = async (props: {
		readonly bumped: { readonly id: string; readonly revision: number };
		readonly organizationId: string;
	}): Promise<void> => {
		const database = context.openDatabase();
		const outcome = await context.platform.runAtomically([
			database
				.update(personFence)
				.set({ revision: props.bumped.revision + 1 })
				.where(eq(personFence.id, props.bumped.id))
				.returning({ id: personFence.id }),
			database
				.update(organizationFence)
				.set({ acknowledgedRevision: 1 })
				.where(eq(organizationFence.id, props.organizationId))
				.returning({ id: organizationFence.id }),
		]);
		if (outcome.kind !== 'committed' || outcome.rows.some((rows) => rows.length !== 1))
			throw new Error('Interleaved writer did not land');
	};

	// Arrange: the pair is ACKed at its revision; its organization floor is not.
	const member = await createStoragePerson(context, 'delivery-interleave-one@example.invalid');
	const organizationId = await createStorageMembership(context, member, 'member');
	await acknowledgePair(member, organizationId);
	const bumped = await pair(context, member, organizationId);
	context.interleaveAfterRead({
		followsRead: isPairFenceRead,
		write: () => bumpPairAndAcknowledgeOrganization({ bumped, organizationId }),
	});
	// Act
	const inOrganization = unwrap(
		await delivery.readSynchronization({
			kind: 'personInOrganization',
			organizationId,
			personId: member,
		}),
	);
	const inOrganizationWriter = await context.interleavedWrite();
	const inOrganizationAfter = unwrap(
		await delivery.readSynchronization({
			kind: 'personInOrganization',
			organizationId,
			personId: member,
		}),
	);
	await acknowledgePair(member, organizationId);
	const inOrganizationOncePairAcked = unwrap(
		await delivery.readSynchronization({
			kind: 'personInOrganization',
			organizationId,
			personId: member,
		}),
	);

	// Arrange: two organizations; both pairs and the first floor ACKed, the second floor not.
	const everywhere = await createStoragePerson(context, 'delivery-interleave-two@example.invalid');
	const first = await createStorageMembership(context, everywhere, 'member');
	const second = await createStorageMembership(context, everywhere, 'member');
	await acknowledgePair(everywhere, first);
	await acknowledgePair(everywhere, second);
	await acknowledgeOrganization(first);
	const firstPair = await pair(context, everywhere, first);
	context.interleaveAfterRead({
		followsRead: isPairFenceRead,
		write: () => bumpPairAndAcknowledgeOrganization({ bumped: firstPair, organizationId: second }),
	});
	// Act
	const personEverywhere = unwrap(
		await delivery.readSynchronization({ kind: 'personEverywhere', personId: everywhere }),
	);
	const everywhereWriter = await context.interleavedWrite();
	await acknowledgePair(everywhere, first);
	const everywhereOncePairAcked = unwrap(
		await delivery.readSynchronization({ kind: 'personEverywhere', personId: everywhere }),
	);
	return {
		inOrganization,
		inOrganizationWriter,
		inOrganizationAfter,
		inOrganizationOncePairAcked,
		personEverywhere,
		everywhereWriter,
		everywhereOncePairAcked,
	};
}

export const authorizationRevisionDeliveryCases: readonly StorageCaseDefinition[] = [
	{
		name: 'authorization delivery: an ACK is recorded only when newer than the stored one and not above the current revision',
		// r3 section 6, source ACK rule; the N/N+1 race leaves N+1 pending.
		expected: {
			ackTwo: 'recorded',
			afterTwo: { ack: 2, pending: true },
			ackOne: 'not-recorded',
			afterOne: 2,
			ackFour: 'not-recorded',
			afterFour: 2,
			ackThree: 'recorded',
			finallyPending: false,
		},
		run: conditionalAcknowledgement,
	},
	{
		name: 'authorization delivery: a deferred push waits until its retry time, and a stale defer never delays a newer version',
		expected: { afterStaleDefer: true, afterDefer: false, atRetryTime: true },
		run: retrySchedule,
	},
	{
		name: 'authorization delivery: synchronization is synced only when every fence in the scope is ACKed at its current revision',
		// Three closed scopes, conservative, synced | pending.
		expected: {
			missingAcks: 'pending',
			pairOnly: 'pending',
			bothAcked: 'synced',
			everywhereOneLagging: 'pending',
			everywhereFloorLagging: 'pending',
			organizationLagging: 'pending',
			organizationSynced: 'synced',
			everywhereSynced: 'synced',
			afterBump: 'pending',
			everywhereFloorMissing: 'pending',
			unknownPerson: 'pending',
			unknownOrganization: 'pending',
		},
		run: synchronizationScopes,
	},
	{
		name: 'authorization delivery: a synchronization read is one snapshot, so a bump and an ACK landing between its reads still read pending',
		// One coherent read, with the controlled interleaving on both storage legs.
		expected: {
			inOrganization: 'pending',
			inOrganizationWriter: 'written',
			inOrganizationAfter: 'pending',
			inOrganizationOncePairAcked: 'synced',
			personEverywhere: 'pending',
			everywhereWriter: 'written',
			everywhereOncePairAcked: 'synced',
		},
		run: interleavedSynchronization,
	},
];
