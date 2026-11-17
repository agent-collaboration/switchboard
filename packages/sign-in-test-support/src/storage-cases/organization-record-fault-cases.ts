import {
	signInAudit,
	user,
	type OrganizationPeopleChange,
} from '@agent-collaboration/sign-in-core';
import { eq } from 'drizzle-orm';

import type { StorageCaseContext } from '#sign-in-test-support/storage-cases/storage-case-context';
import type { StorageCaseDefinition } from '#sign-in-test-support/storage-cases/storage-case-registry';
import {
	createStoragePerson,
	createStorageMembership,
	personAccountCounts,
} from '#sign-in-test-support/storage-cases/storage-case-utilities';

async function auditFault(
	context: StorageCaseContext,
	phase: 'intent' | 'outcome',
): Promise<unknown> {
	const actorUserId = await createStoragePerson(context);
	const organizationId = await createStorageMembership(context, actorUserId);
	const change: OrganizationPeopleChange = {
		requestId: context.platform.ids.nextId(),
		actorUserId,
		organizationId,
		change: 'invited',
		targetId: 'invited@example.invalid',
	};
	if (phase === 'outcome') {
		const intent = await context.store.peopleChanges.record(change, 'intent');
		if (intent.kind !== 'available') throw new Error('Fault fixture intent unavailable');
	}
	context.setFault({
		operation: 'insert',
		table: 'sign_in_audit',
		key: `${change.requestId}:invited:${phase}`,
		additionalKeys: [],
	});
	const failure = await context.store.peopleChanges.record(change, phase);
	const afterFailure = await context.store.peopleChanges.read(change);
	context.setFault(null);
	const retry = await context.store.peopleChanges.record(change, phase);
	const afterRetry = await context.store.peopleChanges.read(change);
	if (afterFailure.kind !== 'available' || afterRetry.kind !== 'available')
		throw new Error('Fault readback unavailable');
	return {
		failure: failure.kind,
		phasesAfterFailure: afterFailure.value.map((row) => row.phase).toSorted(),
		retry: retry.kind,
		phasesAfterRetry: afterRetry.value.map((row) => row.phase).toSorted(),
	};
}
async function realStatementTwoFailure(context: StorageCaseContext): Promise<unknown> {
	const personId = await createStoragePerson(context);
	const id = context.platform.ids.nextId();
	const result = await context.platform.runAtomically([
		context
			.openDatabase()
			.insert(signInAudit)
			.values({
				id,
				kind: 'rollback-control',
				actorUserId: personId,
				requestId: id,
				phase: 'intent',
				changeKind: 'control',
				targetId: personId,
				at: context.platform.clock.now(),
			})
			.returning({ id: signInAudit.id }),
		context
			.openDatabase()
			.insert(user)
			.values({
				id: personId,
				name: 'Duplicate',
				email: 'duplicate@example.invalid',
				emailVerified: true,
				createdAt: new Date(context.platform.clock.now()),
				updatedAt: new Date(context.platform.clock.now()),
			})
			.returning({ id: user.id }),
	]);
	const rows = await context
		.openDatabase()
		.select({ id: signInAudit.id })
		.from(signInAudit)
		.where(eq(signInAudit.id, id));
	return {
		outcome: result,
		firstWriteAbsent: rows.length === 0,
		originalRows: await personAccountCounts(context, personId),
	};
}
export const organizationRecordFaultCases: readonly StorageCaseDefinition[] = [
	...(['intent', 'outcome'] as const).map((phase): StorageCaseDefinition => ({
		name: `people: failed ${phase} audit write leaves no partial row and a same-identity retry is explicit`,
		expected: {
			failure: 'store-unavailable',
			phasesAfterFailure: phase === 'intent' ? [] : ['intent'],
			retry: 'available',
			phasesAfterRetry: phase === 'intent' ? ['intent'] : ['intent', 'outcome'],
		},
		run: (context) => auditFault(context, phase),
	})),
	{
		name: 'a real SQLite rejection in statement two rolls back statement one',
		expected: {
			outcome: { kind: 'failed', reason: 'database-error' },
			firstWriteAbsent: true,
			originalRows: { users: 1, accounts: 1 },
		},
		run: realStatementTwoFailure,
	},
];
