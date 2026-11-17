import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';

import { organizationStatementDigestSchema } from '#sign-in-core/contracts/organization-statement';
import {
	organizationStampTryOutcomes,
	type OrganizationStampFacts,
	type OrganizationStampTryOutcome,
	type OrganizationStampRecord,
	type OrganizationStampRecords,
	type OrganizationStampSettlement,
} from '#sign-in-core/organizations/organization-stamp-renewal';
import type {
	SignInDatabaseFactory,
	SignInStoreResult,
} from '#sign-in-core/storage/models/sign-in-database';
import { organizationIdSchema } from '#sign-in-core/storage/models/sign-in-store';
import { organization } from '#sign-in-core/storage/sign-in-schema';
import { availableStoreValue, readStoreValue } from '#sign-in-core/storage/store-query-results';

const stampRowSchema = z.strictObject({
	fleetState: z.enum(['settingUp', 'ready']),
	fleetStampDigest: organizationStatementDigestSchema.nullable(),
	fleetStampExpiresAt: z.number().int().nonnegative().nullable(),
	fleetStampSigningKeyId: z.string().min(1).nullable(),
	fleetStampSent: z.string().min(1).nullable(),
	fleetStampRenewedAt: z.date().nullable(),
	fleetStampUnansweredTries: z.number().int().nonnegative(),
	fleetStampRefusedTries: z.number().int().nonnegative(),
	fleetStampLastTryAt: z.date().nullable(),
	fleetStampLastTryOutcome: z.enum(organizationStampTryOutcomes).nullable(),
});
const updatedRowsSchema = z.array(z.strictObject({ id: organizationIdSchema }));

function confirmedFacts(row: z.infer<typeof stampRowSchema>): OrganizationStampFacts | null {
	return row.fleetStampDigest === null ||
		row.fleetStampExpiresAt === null ||
		row.fleetStampSigningKeyId === null
		? null
		: {
				digest: row.fleetStampDigest,
				expiresAt: row.fleetStampExpiresAt,
				signingKeyId: row.fleetStampSigningKeyId,
			};
}

function confirmedColumns(stamp: OrganizationStampFacts): {
	readonly fleetStampDigest: string;
	readonly fleetStampExpiresAt: number;
	readonly fleetStampSigningKeyId: string;
} {
	return {
		fleetStampDigest: stamp.digest,
		fleetStampExpiresAt: stamp.expiresAt,
		fleetStampSigningKeyId: stamp.signingKeyId,
	};
}

/** The confirmed-stamp and sent columns a settlement writes; absent columns stay as they are. */
interface SettlementColumns {
	readonly fleetStampDigest?: string | null;
	readonly fleetStampExpiresAt?: number | null;
	readonly fleetStampSigningKeyId?: string | null;
	readonly fleetStampSent?: null;
}

function settlementColumns(settlement: OrganizationStampSettlement): SettlementColumns {
	switch (settlement.kind) {
		case 'keep-sent':
			return {};
		case 'clear-sent':
			return { fleetStampSent: null };
		case 'adopt-central':
			return { ...confirmedColumns(settlement.stamp), fleetStampSent: null };
		case 'forget-central':
			return {
				fleetStampDigest: null,
				fleetStampExpiresAt: null,
				fleetStampSigningKeyId: null,
				fleetStampSent: null,
			};
		default:
			return unreachableSettlement(settlement);
	}
}

/** An unanswered try and a refused one are counted apart (D4). */
function tryCounter(
	outcome: OrganizationStampTryOutcome,
): { readonly fleetStampUnansweredTries: SQL } | { readonly fleetStampRefusedTries: SQL } {
	return outcome.startsWith('unanswered-')
		? { fleetStampUnansweredTries: sql`${organization.fleetStampUnansweredTries} + ${1}` }
		: { fleetStampRefusedTries: sql`${organization.fleetStampRefusedTries} + ${1}` };
}

/** One conditional update; true only when it matched the organization's guarded row. */
async function guardedUpdate(update: () => Promise<unknown>): Promise<SignInStoreResult<boolean>> {
	const rows = await readStoreValue(update, updatedRowsSchema);
	return rows.kind === 'available' ? availableStoreValue(rows.value.length === 1) : rows;
}

/** Each write is one conditional update, so every sign-in instance shares one guard (rule 2). */
export function createOrganizationStampStore(
	openDatabase: SignInDatabaseFactory,
): OrganizationStampRecords {
	return {
		async readStampRecord(
			organizationId,
		): Promise<SignInStoreResult<OrganizationStampRecord | null>> {
			const row = await readStoreValue(
				async () =>
					(
						await openDatabase()
							.select({
								fleetState: organization.fleetState,
								fleetStampDigest: organization.fleetStampDigest,
								fleetStampExpiresAt: organization.fleetStampExpiresAt,
								fleetStampSigningKeyId: organization.fleetStampSigningKeyId,
								fleetStampSent: organization.fleetStampSent,
								fleetStampRenewedAt: organization.fleetStampRenewedAt,
								fleetStampUnansweredTries: organization.fleetStampUnansweredTries,
								fleetStampRefusedTries: organization.fleetStampRefusedTries,
								fleetStampLastTryAt: organization.fleetStampLastTryAt,
								fleetStampLastTryOutcome: organization.fleetStampLastTryOutcome,
							})
							.from(organization)
							.where(eq(organization.id, organizationId))
							.limit(1)
					)[0] ?? null,
				stampRowSchema.nullable(),
			);
			if (row.kind === 'store-unavailable') return row;
			if (row.value === null) return availableStoreValue(null);
			const value = row.value;
			return availableStoreValue({
				fleetState: value.fleetState,
				confirmed: confirmedFacts(value),
				sent: value.fleetStampSent,
				renewedAt: value.fleetStampRenewedAt?.getTime() ?? null,
				unansweredTries: value.fleetStampUnansweredTries,
				refusedTries: value.fleetStampRefusedTries,
				lastTry:
					value.fleetStampLastTryAt === null || value.fleetStampLastTryOutcome === null
						? null
						: { at: value.fleetStampLastTryAt.getTime(), outcome: value.fleetStampLastTryOutcome },
			});
		},
		seedConfirmedStamp: async ({ organizationId, stamp }) =>
			guardedUpdate(async () =>
				openDatabase()
					.update(organization)
					.set(confirmedColumns(stamp))
					.where(and(eq(organization.id, organizationId), isNull(organization.fleetStampDigest)))
					.returning({ id: organization.id }),
			),
		recordUnsentTry: async ({ organizationId, outcome, now }) =>
			guardedUpdate(async () =>
				openDatabase()
					.update(organization)
					.set({
						...tryCounter(outcome),
						fleetStampLastTryAt: new Date(now),
						fleetStampLastTryOutcome: outcome,
					})
					.where(and(eq(organization.id, organizationId), isNull(organization.fleetStampDigest)))
					.returning({ id: organization.id }),
			),
		forgetConfirmedStamp: async ({ organizationId, digest }) =>
			guardedUpdate(async () =>
				openDatabase()
					.update(organization)
					.set(settlementColumns({ kind: 'forget-central' }))
					.where(
						and(
							eq(organization.id, organizationId),
							eq(organization.fleetStampDigest, digest),
							isNull(organization.fleetStampSent),
						),
					)
					.returning({ id: organization.id }),
			),
		claimSentStamp: async ({ organizationId, statement }) =>
			guardedUpdate(async () =>
				openDatabase()
					.update(organization)
					.set({ fleetStampSent: statement })
					.where(and(eq(organization.id, organizationId), isNull(organization.fleetStampSent)))
					.returning({ id: organization.id }),
			),
		confirmSentStamp: async ({ organizationId, statement, stamp, now }) =>
			guardedUpdate(async () =>
				openDatabase()
					.update(organization)
					.set({
						...confirmedColumns(stamp),
						fleetStampSent: null,
						fleetStampRenewedAt: new Date(now),
					})
					.where(
						and(eq(organization.id, organizationId), eq(organization.fleetStampSent, statement)),
					)
					.returning({ id: organization.id }),
			),
		recordStampTry: async ({ organizationId, statement, outcome, settlement, now }) =>
			guardedUpdate(async () =>
				openDatabase()
					.update(organization)
					.set({
						...settlementColumns(settlement),
						...tryCounter(outcome),
						fleetStampLastTryAt: new Date(now),
						fleetStampLastTryOutcome: outcome,
					})
					.where(
						and(eq(organization.id, organizationId), eq(organization.fleetStampSent, statement)),
					)
					.returning({ id: organization.id }),
			),
	};
}

function unreachableSettlement(_settlement: never): never {
	throw new Error('Unknown organization stamp settlement');
}
