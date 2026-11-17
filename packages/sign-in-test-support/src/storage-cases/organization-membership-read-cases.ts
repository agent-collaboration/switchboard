import {
	invitation,
	member,
	organizationIdSchema,
	signInSchema,
	user,
	type OrganizationId,
	type PersonId,
} from '@agent-collaboration/sign-in-core';
import { eq } from 'drizzle-orm';

import type { StorageCaseContext } from '#sign-in-test-support/storage-cases/storage-case-context';
import type { StorageCaseDefinition } from '#sign-in-test-support/storage-cases/storage-case-registry';
import {
	createStorageMembership,
	createStoragePerson,
} from '#sign-in-test-support/storage-cases/storage-case-utilities';
import type { DatabaseFault } from '#sign-in-test-support/test-fixtures/database-fault-identity';

async function seedReadOrganization(context: StorageCaseContext): Promise<{
	readonly organizationId: OrganizationId;
	readonly ownerId: PersonId;
}> {
	const ownerId = await createStoragePerson(context, 'owner@example.invalid');
	const organizationId = await createStorageMembership(context, ownerId);
	return { organizationId, ownerId };
}

async function seedReadInvitation(props: {
	readonly context: StorageCaseContext;
	readonly organizationId: OrganizationId;
	readonly ownerId: PersonId;
	readonly email: string;
	readonly status?: string;
	readonly role?: string;
	readonly expiresAt?: number;
}): Promise<string> {
	const id = props.context.platform.ids.nextId();
	await props.context
		.openDatabase()
		.insert(invitation)
		.values({
			id,
			organizationId: props.organizationId,
			inviterId: props.ownerId,
			email: props.email,
			role: props.role ?? 'member',
			status: props.status ?? 'pending',
			expiresAt: new Date(props.expiresAt ?? props.context.platform.clock.now() + 60_000),
			createdAt: new Date(props.context.platform.clock.now()),
		});
	return id;
}

async function snapshotReadTables(context: StorageCaseContext): Promise<string> {
	return JSON.stringify(
		await Promise.all(
			Object.values(signInSchema).map((table) => context.openDatabase().select().from(table)),
		),
	);
}

async function membershipReadFacts(context: StorageCaseContext): Promise<unknown> {
	const seeded = await seedReadOrganization(context);
	const otherPerson = await createStoragePerson(context, 'elsewhere@example.invalid');
	const otherOrganization = await createStorageMembership(context, otherPerson);
	await Promise.all(
		['canceled', 'pending', 'accepted', 'rejected'].map((status) =>
			seedReadInvitation({ context, ...seeded, email: 'invited@example.invalid', status }),
		),
	);
	await seedReadInvitation({
		context,
		...seeded,
		email: 'owner@example.invalid',
		status: 'unrecognized-status',
	});
	await seedReadInvitation({
		context,
		...seeded,
		organizationId: otherOrganization,
		email: 'foreign-invite@example.invalid',
	});
	const before = await snapshotReadTables(context);
	const read = (
		email: string,
	): ReturnType<typeof context.store.organizations.readPersonMembershipFacts> =>
		context.store.organizations.readPersonMembershipFacts({
			organizationId: seeded.organizationId,
			email,
		});
	const own = await read('owner@example.invalid');
	const absent = await read('missing@example.invalid');
	const elsewhere = await read('elsewhere@example.invalid');
	const foreignInvitation = await read('foreign-invite@example.invalid');
	const invited = await read('invited@example.invalid');
	return {
		own,
		absent,
		elsewhere,
		foreignInvitation,
		invitationRows:
			invited.kind === 'available' && invited.value.kind === 'invitations'
				? invited.value.rows.map(({ status, expiresAt }) => ({ status, expiresAt }))
				: invited,
		unchanged: before === (await snapshotReadTables(context)),
	};
}

async function organizationReadPages(context: StorageCaseContext): Promise<unknown> {
	const seeded = await seedReadOrganization(context);
	const otherPerson = await createStoragePerson(context, 'foreign@example.invalid');
	const otherOrganization = await createStorageMembership(context, otherPerson);
	const now = context.platform.clock.now();
	await Promise.all(
		Array.from({ length: 50 }, async (_, index): Promise<void> => {
			const personId = await createStoragePerson(context, `person-${index}@example.invalid`);
			await context
				.openDatabase()
				.insert(member)
				.values({
					id: context.platform.ids.nextId(),
					organizationId: seeded.organizationId,
					userId: personId,
					role: 'member',
					createdAt: new Date(now + index + 1),
				});
		}),
	);
	await Promise.all(
		['pending', 'canceled', 'rejected', 'accepted'].map((status) =>
			seedReadInvitation({ context, ...seeded, email: `${status}@example.invalid`, status }),
		),
	);
	await seedReadInvitation({
		context,
		...seeded,
		email: 'owner@example.invalid',
		status: 'unrecognized-status',
	});
	await seedReadInvitation({ context, ...seeded, email: 'at-now@example.invalid', expiresAt: now });
	await seedReadInvitation({
		context,
		...seeded,
		organizationId: otherOrganization,
		email: 'foreign-invitation@example.invalid',
	});
	const before = await snapshotReadTables(context);
	const first = await context.store.organizations.listOrganizationPeople({
		organizationId: seeded.organizationId,
		offset: 0,
	});
	const second = await context.store.organizations.listOrganizationPeople({
		organizationId: seeded.organizationId,
		offset: 50,
	});
	const empty = await context.store.organizations.listOrganizationPeople({
		organizationId: organizationIdSchema.parse(context.platform.ids.nextId()),
		offset: 0,
	});
	return {
		first:
			first.kind === 'available'
				? {
						memberTotal: first.value.memberTotal,
						offset: first.value.offset,
						emails: first.value.members.map(({ email }) => email),
						invitations: first.value.invitations.map(({ email, role, status, expiresAt }) => ({
							email,
							role,
							status,
							expiresAt,
						})),
					}
				: first,
		second: second.kind === 'available' ? second.value.members : second,
		empty,
		unchanged: before === (await snapshotReadTables(context)),
	};
}

const malformedTargets = [
	'lookup-role',
	'lookup-status',
	'lookup-expiry',
	'list-role',
	'list-status',
	'list-expiry',
	'list-invitation-role',
	'list-invitation-email',
	'list-member-email',
] as const;
type MalformedTarget = (typeof malformedTargets)[number];
async function malformedOrganizationRead(
	context: StorageCaseContext,
	target: MalformedTarget,
): Promise<unknown> {
	const seeded = await seedReadOrganization(context);
	const invitationId = await seedReadInvitation({
		context,
		...seeded,
		email: 'invited@example.invalid',
	});
	if (target.endsWith('-role') && !target.includes('invitation'))
		await context
			.openDatabase()
			.update(member)
			.set({ role: 'unrecognized-role' })
			.where(eq(member.organizationId, seeded.organizationId));
	if (target.endsWith('-status'))
		await context
			.openDatabase()
			.update(invitation)
			.set({ status: 'unrecognized-status' })
			.where(eq(invitation.id, invitationId));
	if (target.endsWith('-expiry'))
		await context
			.openDatabase()
			.update(invitation)
			.set({ expiresAt: new Date(-1) })
			.where(eq(invitation.id, invitationId));
	if (target === 'list-invitation-role')
		await context
			.openDatabase()
			.update(invitation)
			.set({ role: 'unrecognized-role' })
			.where(eq(invitation.id, invitationId));
	if (target === 'list-invitation-email')
		await context
			.openDatabase()
			.update(invitation)
			.set({ email: 'invalid-email' })
			.where(eq(invitation.id, invitationId));
	if (target === 'list-member-email')
		await context
			.openDatabase()
			.update(user)
			.set({ email: 'invalid-email' })
			.where(eq(user.id, seeded.ownerId));
	return target.startsWith('lookup')
		? context.store.organizations.readPersonMembershipFacts({
				organizationId: seeded.organizationId,
				email: target === 'lookup-role' ? 'owner@example.invalid' : 'invited@example.invalid',
			})
		: context.store.organizations.listOrganizationPeople({
				organizationId: seeded.organizationId,
				offset: 0,
			});
}

const faultProjections = [
	'membership-facts',
	'membership-invitations',
	'people-members',
	'people-count',
	'people-invitations',
	'memberships',
] as const;
async function faultedOrganizationRead(
	context: StorageCaseContext,
	projection: (typeof faultProjections)[number],
): Promise<unknown> {
	const seeded = await seedReadOrganization(context);
	const fault = {
		operation: 'select',
		table: projection.includes('invitations') ? 'invitation' : 'member',
		key: projection === 'memberships' ? seeded.ownerId : seeded.organizationId,
		additionalKeys: [],
		projection,
	} satisfies DatabaseFault;
	context.setFault(fault);
	try {
		if (projection === 'memberships')
			return await context.store.organizations.membershipsForPerson(seeded.ownerId);
		if (projection.startsWith('people-'))
			return await context.store.organizations.listOrganizationPeople({
				organizationId: seeded.organizationId,
				offset: 0,
			});
		return await context.store.organizations.readPersonMembershipFacts({
			organizationId: seeded.organizationId,
			email: 'absent@example.invalid',
		});
	} finally {
		context.setFault(null);
	}
}

export const organizationMembershipReadCases: readonly StorageCaseDefinition[] = [
	{
		name: 'organization reads: scoped member-first facts keep every invitation status and change no rows',
		expected: {
			own: { kind: 'available', value: { kind: 'member', role: 'owner' } },
			absent: { kind: 'available', value: { kind: 'invitations', rows: [] } },
			elsewhere: { kind: 'available', value: { kind: 'invitations', rows: [] } },
			foreignInvitation: { kind: 'available', value: { kind: 'invitations', rows: [] } },
			invitationRows: ['canceled', 'pending', 'accepted', 'rejected'].map((status) => ({
				status,
				expiresAt: 2_208_988_860_000,
			})),
			unchanged: true,
		},
		run: membershipReadFacts,
	},
	{
		name: 'organization reads: scoped ordered pages count all members and exclude member invitations without filtering status',
		expected: {
			first: {
				memberTotal: 51,
				offset: 0,
				emails: [
					'owner@example.invalid',
					...Array.from({ length: 49 }, (_, index) => `person-${index}@example.invalid`),
				],
				invitations: [
					...['pending', 'canceled', 'rejected', 'accepted'].map((status) => ({
						email: `${status}@example.invalid`,
						role: 'member',
						status,
						expiresAt: 2_208_988_860_000,
					})),
					{
						email: 'at-now@example.invalid',
						role: 'member',
						status: 'pending',
						expiresAt: 2_208_988_800_000,
					},
				],
			},
			second: [{ name: 'Storage case person', email: 'person-49@example.invalid', role: 'member' }],
			empty: {
				kind: 'available',
				value: { members: [], memberTotal: 0, offset: 0, invitations: [] },
			},
			unchanged: true,
		},
		run: organizationReadPages,
	},
	...malformedTargets.map((target): StorageCaseDefinition => ({
		name: `organization reads: malformed ${target} makes the complete read unavailable`,
		expected: { kind: 'store-unavailable', reason: 'row-unparseable' },
		run: (context) => malformedOrganizationRead(context, target),
	})),
	...faultProjections.map((projection): StorageCaseDefinition => ({
		name: `organization reads: real driver ${projection} failure propagates`,
		expected: { kind: 'store-unavailable', reason: 'database-error' },
		run: (context) => faultedOrganizationRead(context, projection),
	})),
];
