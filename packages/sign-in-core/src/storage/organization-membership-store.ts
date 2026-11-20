import { and, asc, count, eq, notExists } from 'drizzle-orm';
import { z } from 'zod';

import {
	organizationMembershipSchema,
	PEOPLE_PAGE_SIZE,
	type OrganizationMembership,
} from '#sign-in-core/contracts/organization-membership';
import {
	personMembershipFactsSchema,
	organizationPeoplePageSchema,
	type PersonMembershipFacts,
	type OrganizationPeoplePage,
} from '#sign-in-core/organizations/checked-read-transitions';
import type {
	OrganizationProvisioningStore,
	OrganizationFleetState,
} from '#sign-in-core/organizations/organization-provisioning';
import type {
	SignInDatabaseFactory,
	SignInStoreResult,
} from '#sign-in-core/storage/models/sign-in-database';
import {
	organizationIdSchema,
	type OrganizationId,
	type PersonId,
} from '#sign-in-core/storage/models/sign-in-store';
import { invitation, member, organization, user } from '#sign-in-core/storage/sign-in-schema';
import {
	availableStoreValue,
	readStoreValue,
	storeFailure,
} from '#sign-in-core/storage/store-query-results';

export interface OrganizationMembershipRecords extends OrganizationProvisioningStore {
	readonly readPersonMembershipFacts: (request: {
		readonly organizationId: OrganizationId;
		readonly email: string;
	}) => Promise<SignInStoreResult<PersonMembershipFacts>>;
	readonly listOrganizationPeople: (request: {
		readonly organizationId: OrganizationId;
		readonly offset: number;
	}) => Promise<SignInStoreResult<OrganizationPeoplePage>>;
	readonly readyOrganizationIds: () => Promise<SignInStoreResult<readonly OrganizationId[]>>;
	readonly readMemberRole: (request: {
		readonly organizationId: OrganizationId;
		readonly personId: PersonId;
	}) => Promise<SignInStoreResult<string | null>>;
	readonly membershipsForPerson: (
		personId: string,
	) => Promise<SignInStoreResult<readonly OrganizationMembership[]>>;
}

/** Each method opens a fresh view; activeOrganizationId is never a permission cache. */
export function createOrganizationMembershipStore(
	openDatabase: SignInDatabaseFactory,
): OrganizationMembershipRecords {
	return {
		async readPersonMembershipFacts(request): Promise<SignInStoreResult<PersonMembershipFacts>> {
			const membership = await readStoreValue(
				async () =>
					(
						await openDatabase()
							.select({ role: member.role })
							.from(member)
							.innerJoin(user, eq(member.userId, user.id))
							.where(
								and(
									eq(member.organizationId, request.organizationId),
									eq(user.email, request.email),
								),
							)
							.limit(1)
					)[0] ?? null,
				organizationMembershipSchema.pick({ role: true }).nullable(),
			);
			if (membership.kind === 'store-unavailable') return membership;
			if (membership.value !== null)
				return availableStoreValue({ kind: 'member', role: membership.value.role });
			return readStoreValue(async () => {
				const rows = await openDatabase()
					.select({ id: invitation.id, status: invitation.status, expiresAt: invitation.expiresAt })
					.from(invitation)
					.where(
						and(
							eq(invitation.organizationId, request.organizationId),
							eq(invitation.email, request.email),
						),
					)
					.orderBy(asc(invitation.id));
				return {
					kind: 'invitations',
					rows: rows.map(({ id, status, expiresAt }) => ({
						id,
						status,
						expiresAt: expiresAt.getTime(),
					})),
				};
			}, personMembershipFactsSchema);
		},
		async listOrganizationPeople(request): Promise<SignInStoreResult<OrganizationPeoplePage>> {
			const members = await readStoreValue(
				async () =>
					openDatabase()
						.select({ name: user.name, email: user.email, role: member.role })
						.from(member)
						.innerJoin(user, eq(member.userId, user.id))
						.where(eq(member.organizationId, request.organizationId))
						.orderBy(asc(member.createdAt), asc(member.id))
						.limit(PEOPLE_PAGE_SIZE)
						.offset(request.offset),
				organizationPeoplePageSchema.shape.members,
			);
			if (members.kind === 'store-unavailable') return members;
			const total = await readStoreValue(
				async () =>
					(
						await openDatabase()
							.select({ total: count() })
							.from(member)
							.where(eq(member.organizationId, request.organizationId))
					)[0],
				z.strictObject({ total: organizationPeoplePageSchema.shape.memberTotal }),
			);
			if (total.kind === 'store-unavailable') return total;
			return readStoreValue(async () => {
				const database = openDatabase();
				const rows = await database
					.select({
						id: invitation.id,
						status: invitation.status,
						expiresAt: invitation.expiresAt,
						email: invitation.email,
						role: invitation.role,
					})
					.from(invitation)
					.where(
						and(
							eq(invitation.organizationId, request.organizationId),
							notExists(
								database
									.select({ id: member.id })
									.from(member)
									.innerJoin(user, eq(member.userId, user.id))
									.where(
										and(
											eq(member.organizationId, request.organizationId),
											eq(user.email, invitation.email),
										),
									),
							),
						),
					)
					.orderBy(asc(invitation.id));
				return {
					members: members.value,
					memberTotal: total.value.total,
					offset: request.offset,
					invitations: rows.map(({ id, status, expiresAt, email, role }) => ({
						id,
						status,
						expiresAt: expiresAt.getTime(),
						email,
						role,
					})),
				};
			}, organizationPeoplePageSchema);
		},
		async readyOrganizationIds(): Promise<SignInStoreResult<readonly OrganizationId[]>> {
			const rows = await readStoreValue(
				async () =>
					openDatabase()
						.select({ id: organization.id })
						.from(organization)
						.where(eq(organization.fleetState, 'ready')),
				z.array(z.strictObject({ id: organizationIdSchema })),
			);
			return rows.kind === 'available' ? availableStoreValue(rows.value.map(({ id }) => id)) : rows;
		},
		async readMemberRole(request): Promise<SignInStoreResult<string | null>> {
			const result = await readStoreValue(
				async () =>
					(
						await openDatabase()
							.select({ role: member.role })
							.from(member)
							.where(
								and(
									eq(member.organizationId, request.organizationId),
									eq(member.userId, request.personId),
								),
							)
							.limit(1)
					)[0] ?? null,
				z.strictObject({ role: z.string() }).nullable(),
			);
			return result.kind === 'available' ? availableStoreValue(result.value?.role ?? null) : result;
		},
		membershipsForPerson(personId): Promise<SignInStoreResult<readonly OrganizationMembership[]>> {
			return readStoreValue(
				async () =>
					openDatabase()
						.select({
							organizationId: member.organizationId,
							organizationName: organization.name,
							personId: member.userId,
							role: member.role,
						})
						.from(member)
						.innerJoin(organization, eq(member.organizationId, organization.id))
						.where(eq(member.userId, personId)),
				z.array(organizationMembershipSchema),
			);
		},
		async readFleetState(
			organizationId,
		): Promise<SignInStoreResult<OrganizationFleetState | null>> {
			const result = await readStoreValue(
				async () =>
					(
						await openDatabase()
							.select({ state: organization.fleetState })
							.from(organization)
							.where(eq(organization.id, organizationId))
							.limit(1)
					)[0] ?? null,
				z.strictObject({ state: z.enum(['settingUp', 'ready']) }).nullable(),
			);
			return result.kind === 'available'
				? availableStoreValue(result.value?.state ?? null)
				: result;
		},
		async markFleetReady(organizationId): Promise<SignInStoreResult<void>> {
			try {
				const updated = await readStoreValue(
					async () =>
						openDatabase()
							.update(organization)
							.set({ fleetState: 'ready' })
							.where(eq(organization.id, organizationId))
							.returning({ id: organization.id }),
					z.array(z.strictObject({ id: organizationIdSchema })),
				);
				if (updated.kind === 'store-unavailable') return updated;
				return updated.value.length === 1
					? availableStoreValue(undefined)
					: { kind: 'store-unavailable', reason: 'database-error' };
			} catch (error) {
				return storeFailure(error);
			}
		},
	};
}
