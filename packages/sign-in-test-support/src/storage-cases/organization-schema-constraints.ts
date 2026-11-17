import { member, organization, signInAudit, user } from '@agent-collaboration/sign-in-core';
import { sql } from 'drizzle-orm';

import type { StorageCaseContext } from '#sign-in-test-support/storage-cases/storage-case-context';
import {
	createStoragePerson,
	createStorageMembership,
} from '#sign-in-test-support/storage-cases/storage-case-utilities';

async function rejectsConstraint(
	operation: () => Promise<unknown>,
	expected: string,
): Promise<boolean> {
	try {
		await operation();
		return false;
	} catch (error) {
		let current: unknown = error;
		while (current instanceof Error) {
			if (current.message.toUpperCase().includes(expected)) return true;
			current = current.cause;
		}
		return false;
	}
}
export async function exerciseOrganizationConstraints(
	context: StorageCaseContext,
): Promise<unknown> {
	const personId = await createStoragePerson(context);
	const organizationId = await createStorageMembership(context, personId);
	const at = new Date(context.platform.clock.now());
	const duplicateSlug = await rejectsConstraint(
		async () =>
			context.openDatabase().insert(organization).values({
				id: context.platform.ids.nextId(),
				name: 'Duplicate',
				slug: organizationId,
				createdAt: at,
			}),
		'UNIQUE',
	);
	const invalidPerson = await rejectsConstraint(
		async () =>
			context.openDatabase().insert(member).values({
				id: context.platform.ids.nextId(),
				organizationId,
				userId: context.platform.ids.nextId(),
				role: 'member',
				createdAt: at,
			}),
		'FOREIGN KEY',
	);
	const invalidOrganization = await rejectsConstraint(
		async () =>
			context.openDatabase().insert(member).values({
				id: context.platform.ids.nextId(),
				organizationId: context.platform.ids.nextId(),
				userId: personId,
				role: 'member',
				createdAt: at,
			}),
		'FOREIGN KEY',
	);
	const requiredEmail = await rejectsConstraint(
		async () =>
			context
				.openDatabase()
				.insert(user)
				.values({
					id: context.platform.ids.nextId(),
					name: 'Missing email',
					email: sql`${null}`,
					createdAt: at,
					updatedAt: at,
				}),
		'NOT NULL',
	);
	// The approved ALTER preserves the pre-existing nullable TEXT audit primary key shape.
	const audit = {
		id: null,
		kind: 'sign-in',
		actorUserId: personId,
		requestId: 'nullable-audit-identity',
		phase: 'outcome',
		changeKind: 'failed',
		targetId: 'management',
		at: context.platform.clock.now(),
	};
	await context.openDatabase().insert(signInAudit).values([audit, audit]);
	return {
		duplicateSlug,
		invalidPerson,
		invalidOrganization,
		requiredEmail,
		nullableAuditIdentities: (await context.openDatabase().select().from(signInAudit)).filter(
			(row) => row.id === null,
		).length,
	};
}
