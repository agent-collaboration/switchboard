import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

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
	personIdSchema,
	type OrganizationId,
	type PersonId,
} from '#sign-in-core/storage/models/sign-in-store';
import { member, organization } from '#sign-in-core/storage/sign-in-schema';
import {
	availableStoreValue,
	readStoreValue,
	storeFailure,
} from '#sign-in-core/storage/store-query-results';

export const organizationMembershipSchema = z.strictObject({
	organizationId: organizationIdSchema,
	organizationName: z.string(),
	personId: personIdSchema,
	role: z.enum(['owner', 'member']),
});
export type OrganizationMembership = z.infer<typeof organizationMembershipSchema>;
export interface OrganizationMembershipRecords extends OrganizationProvisioningStore {
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
