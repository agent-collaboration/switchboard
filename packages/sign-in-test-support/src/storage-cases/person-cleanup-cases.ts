import { invitation, session } from '@agent-collaboration/sign-in-core';

import {
	storageCaseOwnerEmail,
	type StorageCaseContext,
} from '#sign-in-test-support/storage-cases/storage-case-context';
import type { StorageCaseDefinition } from '#sign-in-test-support/storage-cases/storage-case-registry';
import {
	createStorageMembership,
	createStoragePerson,
	personAccountCounts,
} from '#sign-in-test-support/storage-cases/storage-case-utilities';

type Protection = 'none' | 'member' | 'pending-invitation' | 'expired-invitation' | 'session';
async function addPendingInvitation(
	context: StorageCaseContext,
	personEmail: string,
): Promise<void> {
	const ownerId = await createStoragePerson(context, storageCaseOwnerEmail);
	const organizationId = await createStorageMembership(context, ownerId);
	await context
		.openDatabase()
		.insert(invitation)
		.values({
			id: context.platform.ids.nextId(),
			organizationId,
			inviterId: ownerId,
			email: personEmail,
			role: 'member',
			createdAt: new Date(context.platform.clock.now()),
			expiresAt: new Date(context.platform.clock.now() + 60_000),
		});
}
async function cleanupWithProtection(
	context: StorageCaseContext,
	protection: Protection,
): Promise<unknown> {
	const email = 'cleanup-target@example.invalid';
	const personId = await createStoragePerson(context, email);
	if (protection === 'member') await createStorageMembership(context, personId, 'member');
	if (protection === 'pending-invitation' || protection === 'expired-invitation') {
		await addPendingInvitation(context, email);
		if (protection === 'expired-invitation') context.setTime(context.platform.clock.now() + 60_001);
	}
	if (protection === 'session')
		await context
			.openDatabase()
			.insert(session)
			.values({
				id: context.platform.ids.nextId(),
				token: 'cleanup-live-session',
				userId: personId,
				createdAt: new Date(context.platform.clock.now()),
				updatedAt: new Date(context.platform.clock.now()),
				expiresAt: new Date(context.platform.clock.now() + 60_000),
			});
	const result = await context.store.persons.cleanupUnboundPerson(personId);
	return { result: result.kind, rows: await personAccountCounts(context, personId) };
}
async function delayedCleanup(
	context: StorageCaseContext,
	protection: 'member' | 'pending-invitation',
): Promise<unknown> {
	const email = 'cleanup-target@example.invalid';
	const personId = await createStoragePerson(context, email);
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	context.beforeAtomic(async () => {
		context.beforeAtomic(null);
		entered.resolve();
		await release.promise;
	});
	const cleanup = context.store.persons.cleanupUnboundPerson(personId);
	await entered.promise;
	try {
		if (protection === 'member') await createStorageMembership(context, personId, 'member');
		else await addPendingInvitation(context, email);
	} finally {
		release.resolve();
	}
	return { result: (await cleanup).kind, rows: await personAccountCounts(context, personId) };
}
async function cleanupWriteFailure(context: StorageCaseContext): Promise<unknown> {
	const personId = await createStoragePerson(context);
	context.setFault({ operation: 'delete', table: 'user', key: personId, additionalKeys: [] });
	const result = await context.store.persons.cleanupUnboundPerson(personId);
	const afterFailure = await personAccountCounts(context, personId);
	context.setFault(null);
	const retry = await context.store.persons.cleanupUnboundPerson(personId);
	return {
		failure: result.kind,
		afterFailure,
		retry: retry.kind,
		afterRetry: await personAccountCounts(context, personId),
	};
}
export const personCleanupCases: readonly StorageCaseDefinition[] = [
	...(
		[
			'none',
			'member',
			'pending-invitation',
			'expired-invitation',
			'session',
		] satisfies readonly Protection[]
	).map((protection): StorageCaseDefinition => ({
		name: `people: cleanup uses current ${protection} protection and preserves native account cascading`,
		expected: {
			result: 'available',
			rows:
				protection === 'none' || protection === 'expired-invitation'
					? { users: 0, accounts: 0 }
					: { users: 1, accounts: 1 },
		},
		run: (context) => cleanupWithProtection(context, protection),
	})),
	...(['member', 'pending-invitation'] as const).map((protection): StorageCaseDefinition => ({
		name: `people: delayed cleanup rechecks a newly committed ${protection} at atomic execution`,
		expected: { result: 'available', rows: { users: 1, accounts: 1 } },
		run: (context) => delayedCleanup(context, protection),
	})),
	{
		name: 'people: failed conditional user cleanup preserves the account and retry removes both through native cascading',
		expected: {
			failure: 'store-unavailable',
			afterFailure: { users: 1, accounts: 1 },
			retry: 'available',
			afterRetry: { users: 0, accounts: 0 },
		},
		run: cleanupWriteFailure,
	},
];
