import {
	member,
	invitation,
	type OrganizationPeopleChange,
	type SignInStoreResult,
} from '@agent-collaboration/sign-in-core';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import type { StorageCaseContext } from '#sign-in-test-support/storage-cases/storage-case-context';
import {
	createStoragePerson,
	createStorageMembership,
	resetStorageCase,
} from '#sign-in-test-support/storage-cases/storage-case-utilities';

export const recordHistoryStepSchema = z.enum(['intent', 'effect', 'outcome', 'unknown', 'read']);
export type RecordHistoryStep = z.infer<typeof recordHistoryStepSchema>;

export function modelRecordHistory(steps: readonly RecordHistoryStep[]): readonly unknown[] {
	let hasIntent = false;
	let effectApplied = false;
	let hasOutcome = false;
	return steps.map((step) => {
		if (step === 'intent') hasIntent = true;
		if (step === 'effect' && hasIntent) effectApplied = true;
		if (step === 'outcome' && effectApplied) hasOutcome = true;
		return {
			phase: hasOutcome ? 'confirmed' : hasIntent ? 'unconfirmed' : 'absent',
			effectApplied,
		};
	});
}

function requireWrite(result: SignInStoreResult<void>): void {
	if (result.kind !== 'available') throw new Error('Record-history fixture write unavailable');
}

export async function executeRecordHistory(
	context: StorageCaseContext,
	steps: readonly RecordHistoryStep[],
): Promise<readonly unknown[]> {
	await resetStorageCase(context);
	const actorUserId = await createStoragePerson(context, 'storage-owner@example.invalid');
	const organizationId = await createStorageMembership(context, actorUserId);
	const targetId = await createStoragePerson(context);
	const invitationId = context.platform.ids.nextId();
	await context
		.openDatabase()
		.insert(invitation)
		.values({
			id: invitationId,
			organizationId,
			email: 'member@example.invalid',
			role: 'member',
			inviterId: actorUserId,
			expiresAt: new Date(context.platform.clock.now() + 60_000),
			createdAt: new Date(context.platform.clock.now()),
		});
	const change: OrganizationPeopleChange = {
		requestId: context.platform.ids.nextId(),
		actorUserId,
		organizationId,
		change: 'invitation-accepted',
		targetId: invitationId,
	};
	let intentReturned = false;
	let effectReturned = false;
	const observations: unknown[] = [];
	const membershipId = context.platform.ids.nextId();
	await steps.reduce<Promise<void>>(async (previous, step) => {
		await previous;
		if (step === 'intent') {
			requireWrite(await context.store.peopleChanges.record(change, 'intent'));
			intentReturned = true;
		}
		if (step === 'effect' && intentReturned) {
			// A controlled effect models the native hook boundary; this is not plugin/authentication proof.
			await context
				.openDatabase()
				.insert(member)
				.values({
					id: membershipId,
					userId: targetId,
					organizationId,
					role: 'member',
					createdAt: new Date(context.platform.clock.now()),
				})
				.onConflictDoNothing();
			await context
				.openDatabase()
				.update(invitation)
				.set({ status: 'accepted' })
				.where(eq(invitation.id, invitationId));
			effectReturned = true;
		}
		if (step === 'outcome' && effectReturned)
			requireWrite(await context.store.peopleChanges.record(change, 'outcome'));
		const read = await context.store.peopleChanges.read(change);
		if (read.kind !== 'available') throw new Error('Record-history read unavailable');
		observations.push({
			phase: read.value.some((row) => row.phase === 'outcome')
				? 'confirmed'
				: read.value.some((row) => row.phase === 'intent')
					? 'unconfirmed'
					: 'absent',
			effectApplied: effectReturned,
		});
	}, Promise.resolve());
	return observations;
}
