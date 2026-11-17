import {
	account,
	personIdSchema,
	signInSchema,
	user,
	type PersonId,
} from '@agent-collaboration/sign-in-core';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import {
	storageCaseTime,
	type StorageCaseContext,
} from '#sign-in-test-support/storage-cases/storage-case-context';

export async function resetStorageCase(context: StorageCaseContext): Promise<void> {
	context.setTime(storageCaseTime);
	context.setFault(null);
	context.beforeAtomic(null);
	const statements = Object.values(signInSchema)
		.toReversed()
		.map((table) => context.openDatabase().delete(table).returning());
	const [first, ...remaining] = statements;
	if (first === undefined) throw new Error('Storage schema has no tables');
	const outcome = await context.platform.runAtomically([first, ...remaining]);
	if (outcome.kind !== 'committed') throw new Error('Storage fixture reset failed');
}

export async function createStoragePerson(
	context: StorageCaseContext,
	email = 'member@example.invalid',
): Promise<PersonId> {
	const personId = personIdSchema.parse(context.platform.ids.nextId());
	const createdAt = new Date(context.platform.clock.now());
	await context.openDatabase().insert(user).values({
		id: personId,
		name: 'Storage case person',
		email,
		emailVerified: true,
		image: null,
		createdAt,
		updatedAt: createdAt,
	});
	await context
		.openDatabase()
		.insert(account)
		.values({
			id: context.platform.ids.nextId(),
			accountId: `provider:${personId}`,
			providerId: 'google',
			userId: personId,
			createdAt,
			updatedAt: createdAt,
		});
	return personId;
}

export async function personAccountCounts(
	context: StorageCaseContext,
	personId: string,
): Promise<{ readonly users: number; readonly accounts: number }> {
	const [users, accounts] = await Promise.all([
		context.openDatabase().select({ id: user.id }).from(user).where(eq(user.id, personId)),
		context
			.openDatabase()
			.select({ id: account.id })
			.from(account)
			.where(eq(account.userId, personId)),
	]);
	const rowSchema = z.array(z.object({ id: z.string() }));
	return { users: rowSchema.parse(users).length, accounts: rowSchema.parse(accounts).length };
}

/** Fixture rows establish an existing organization; native creation is exercised by the people HTTP cases. */
export async function createStorageMembership(
	context: StorageCaseContext,
	personId: PersonId,
	role: 'owner' | 'member' = 'owner',
): Promise<import('@agent-collaboration/sign-in-core').OrganizationId> {
	const { organization, member, organizationIdSchema } =
		await import('@agent-collaboration/sign-in-core');
	const organizationId = organizationIdSchema.parse(context.platform.ids.nextId());
	await context
		.openDatabase()
		.insert(organization)
		.values({
			id: organizationId,
			name: 'Storage organization',
			slug: organizationId,
			createdAt: new Date(context.platform.clock.now()),
		});
	await context
		.openDatabase()
		.insert(member)
		.values({
			id: context.platform.ids.nextId(),
			organizationId,
			userId: personId,
			role,
			createdAt: new Date(context.platform.clock.now()),
		});
	// Raw seeded rows are a populated store: give them their fences the way a deployment would.
	const { backfillAuthorizationRevisions } = await import('@agent-collaboration/sign-in-core');
	const backfill = await backfillAuthorizationRevisions({
		openDatabase: context.openDatabase,
		platform: context.platform,
	});
	if (backfill.kind !== 'available') throw new Error('Seeded membership backfill failed');
	return organizationId;
}
