import { session, type OrganizationPeopleChange } from '@agent-collaboration/sign-in-core';

import {
	storageCaseOwnerEmail,
	storageCaseTime,
	type StorageCaseContext,
} from '#sign-in-test-support/storage-cases/storage-case-context';
import {
	createStoragePerson,
	createStorageMembership,
} from '#sign-in-test-support/storage-cases/storage-case-utilities';

export async function recordingCapabilitiesDriveStorage(
	context: StorageCaseContext,
): Promise<unknown> {
	try {
		const personId = await createStoragePerson(context, storageCaseOwnerEmail);
		const organizationId = await createStorageMembership(context, personId);
		const sessionId = context.platform.ids.nextId();
		const expiresAt = storageCaseTime + 1000;
		await context
			.openDatabase()
			.insert(session)
			.values({
				id: sessionId,
				userId: personId,
				activeOrganizationId: organizationId,
				token: btoa(String.fromCodePoint(...crypto.getRandomValues(new Uint8Array(32)))),
				createdAt: new Date(storageCaseTime),
				updatedAt: new Date(storageCaseTime),
				expiresAt: new Date(expiresAt),
			});
		const before = context.openCount();
		const first = await context.store.persons.readOwnerSession(personId, sessionId);
		const middle = context.openCount();
		const second = await context.store.persons.readOwnerSession(personId, sessionId);
		const after = context.openCount();
		const requestId = context.platform.ids.nextId();
		const change: OrganizationPeopleChange = {
			requestId,
			actorUserId: personId,
			organizationId,
			change: 'invited',
			targetId: 'invited@example.invalid',
		};
		context.setTime(storageCaseTime + 100);
		const intent = await context.store.peopleChanges.record(change, 'intent');
		context.setTime(storageCaseTime + 200);
		const outcome = await context.store.peopleChanges.record(change, 'outcome');
		const audit = await context.store.peopleChanges.read(change);
		if (intent.kind !== 'available' || outcome.kind !== 'available' || audit.kind !== 'available')
			throw new Error('Recording capability audit unavailable');
		context.setTime(expiresAt + 1);
		const expired = await context.store.persons.readOwnerSession(personId, sessionId);
		return {
			clockUsed: context.clockReadCount() > 0,
			freshOwnerViews: middle > before && after > middle,
			liveBeforeExpiry:
				first.kind === 'available' &&
				first.value !== null &&
				second.kind === 'available' &&
				second.value !== null,
			expiredAfterClockMove: expired.kind === 'available' && expired.value === null,
			requestFromKnownIds: context.issuedIds.includes(requestId),
			intentTime: audit.value.find((row) => row.phase === 'intent')?.at,
			outcomeTime: audit.value.find((row) => row.phase === 'outcome')?.at,
		};
	} finally {
		context.setTime(storageCaseTime);
	}
}
