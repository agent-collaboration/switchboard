import { and, asc, eq, gt, gte, inArray, lt, lte } from 'drizzle-orm';
import { z } from 'zod';

import type { SignInPlatform } from '#sign-in-core/contracts/sign-in-platform';
import { atomicStoreRows } from '#sign-in-core/storage/atomic-store-rows';
import type {
	SignInDatabaseFactory,
	SignInStoreResult,
} from '#sign-in-core/storage/models/sign-in-database';
import {
	organizationAuthorizationRevisions as organizationFence,
	personOrganizationAuthorizationRevisions as personFence,
} from '#sign-in-core/storage/sign-in-schema';
import {
	availableStoreValue,
	readStoreValue,
	storeFailure,
} from '#sign-in-core/storage/store-query-results';

export interface PendingOrganizationRevision {
	readonly organizationId: string;
	readonly revision: number;
	readonly state: 'active' | 'stopped' | 'deleted';
	readonly permissionPolicyDigest: string;
}
export interface PendingPersonRevision {
	readonly subjectId: string;
	readonly organizationId: string;
	readonly personId: string;
	readonly revision: number;
	readonly state: 'active' | 'inactive';
}
export interface PendingAuthorizationRevisions {
	readonly organizations: readonly PendingOrganizationRevision[];
	readonly persons: readonly PendingPersonRevision[];
}
/** Recorded, or not, because the row already holds that ACK or has not reached that revision. */
export type AcknowledgementRecord = 'recorded' | 'not-recorded';
/** What must central have caught up with? */
export type SynchronizationScope =
	| {
			readonly kind: 'personInOrganization';
			readonly organizationId: string;
			readonly personId: string;
	  }
	| { readonly kind: 'personEverywhere'; readonly personId: string }
	| { readonly kind: 'organization'; readonly organizationId: string };
/**
 * A conservative current fact, never a per-change receipt: `synced` only when every fence in
 * the scope has an ACK at or above its current revision. A later unrelated change, or a fence
 * with no row, keeps it `pending`.
 */
export type SynchronizationStatus = 'synced' | 'pending';

export interface AuthorizationRevisionDeliveryRecords {
	/**
	 * Rows past their retry time, or (WS3, on use) every unacknowledged row of one organization:
	 * a Fleet call needs them delivered now, whatever their backoff.
	 */
	readonly readPending: (props: {
		readonly limit: number;
		readonly organizationId?: string;
	}) => Promise<SignInStoreResult<PendingAuthorizationRevisions>>;
	/** The org fence's current version, ACKed or not: what a recipient missing it must be resent. */
	readonly readOrganization: (
		organizationId: string,
	) => Promise<SignInStoreResult<PendingOrganizationRevision | null>>;
	readonly recordOrganizationAcknowledgement: (props: {
		readonly organizationId: string;
		readonly acknowledgedRevision: number;
	}) => Promise<SignInStoreResult<AcknowledgementRecord>>;
	readonly recordPersonAcknowledgement: (props: {
		readonly subjectId: string;
		readonly organizationId: string;
		readonly personId: string;
		readonly acknowledgedRevision: number;
	}) => Promise<SignInStoreResult<AcknowledgementRecord>>;
	/** Defers only the version that was pushed; a newer local change keeps its own schedule. */
	readonly deferOrganization: (props: {
		readonly organizationId: string;
		readonly pushedRevision: number;
		readonly nextAttemptAt: number;
	}) => Promise<SignInStoreResult<void>>;
	readonly deferPerson: (props: {
		readonly subjectId: string;
		readonly pushedRevision: number;
		readonly nextAttemptAt: number;
	}) => Promise<SignInStoreResult<void>>;
	readonly readSynchronization: (
		scope: SynchronizationScope,
	) => Promise<SignInStoreResult<SynchronizationStatus>>;
	/**
	 * WS7 R-floors (Lead, 13 Nov), the one place an ACK lowers: central has answered that it holds
	 * nothing for this organization, so none of its ACKs is true. Every fence row of it (the
	 * organization row and each person pair) goes back to 0 in one write, and delivery then
	 * pushes their current revisions. Revisions themselves never change here.
	 */
	readonly forgetCentralAcknowledgements: (
		organizationId: string,
	) => Promise<SignInStoreResult<void>>;
}

const pendingOrganizationSchema = z.strictObject({
	organizationId: z.string(),
	revision: z.number().int(),
	state: z.enum(['active', 'stopped', 'deleted']),
	permissionPolicyDigest: z.string(),
});
const pendingPersonSchema = z.strictObject({
	subjectId: z.string(),
	organizationId: z.string(),
	personId: z.string(),
	revision: z.number().int(),
	state: z.enum(['active', 'inactive']),
});
const changedRowsSchema = z.array(z.object({ id: z.string() }));
const synchronizationFenceSchema = z.strictObject({
	organizationId: z.string(),
	revision: z.number().int(),
	acknowledgedRevision: z.number().int(),
});
type SynchronizationFenceRow = z.infer<typeof synchronizationFenceSchema>;

const isCaughtUp = (row: SynchronizationFenceRow): boolean =>
	row.acknowledgedRevision >= row.revision;

/**
 * Every fence the scope needs must exist and be
 * ACKed at its current revision. For a person, that is each retained pair and the organization
 * floor of each pair's organization; a missing row is pending, never skipped.
 */
function isPersonScopeSynchronized(
	pairs: readonly SynchronizationFenceRow[],
	organizations: readonly SynchronizationFenceRow[],
): boolean {
	if (pairs.length === 0 || !pairs.every(isCaughtUp)) return false;
	const floors = new Map(organizations.map((row) => [row.organizationId, row]));
	return pairs.every((pair) => {
		const floor = floors.get(pair.organizationId);
		return floor !== undefined && isCaughtUp(floor);
	});
}

export function createAuthorizationRevisionDeliveryStore(props: {
	readonly openDatabase: SignInDatabaseFactory;
	readonly platform: Pick<SignInPlatform, 'clock' | 'runAtomically'>;
}): AuthorizationRevisionDeliveryRecords {
	const database = props.openDatabase;
	async function changed(
		run: () => Promise<unknown>,
	): Promise<SignInStoreResult<AcknowledgementRecord>> {
		const rows = await readStoreValue(run, changedRowsSchema);
		if (rows.kind === 'store-unavailable') return rows;
		return availableStoreValue(rows.value.length === 1 ? 'recorded' : 'not-recorded');
	}
	return {
		async readPending({ limit, organizationId }) {
			const now = props.platform.clock.now();
			const organizations = await readStoreValue(
				async () =>
					database()
						.select({
							organizationId: organizationFence.id,
							revision: organizationFence.revision,
							state: organizationFence.state,
							permissionPolicyDigest: organizationFence.permissionPolicyDigest,
						})
						.from(organizationFence)
						.where(
							and(
								gt(organizationFence.revision, organizationFence.acknowledgedRevision),
								organizationId === undefined
									? lte(organizationFence.nextAttemptAt, now)
									: eq(organizationFence.id, organizationId),
							),
						)
						.orderBy(asc(organizationFence.nextAttemptAt), asc(organizationFence.id))
						.limit(limit),
				z.array(pendingOrganizationSchema),
			);
			if (organizations.kind === 'store-unavailable') return organizations;
			const persons = await readStoreValue(
				async () =>
					database()
						.select({
							subjectId: personFence.id,
							organizationId: personFence.organizationId,
							personId: personFence.personId,
							revision: personFence.revision,
							state: personFence.state,
						})
						.from(personFence)
						.where(
							and(
								gt(personFence.revision, personFence.acknowledgedRevision),
								organizationId === undefined
									? lte(personFence.nextAttemptAt, now)
									: eq(personFence.organizationId, organizationId),
							),
						)
						.orderBy(asc(personFence.nextAttemptAt), asc(personFence.id))
						.limit(limit),
				z.array(pendingPersonSchema),
			);
			if (persons.kind === 'store-unavailable') return persons;
			return availableStoreValue({
				organizations: organizations.value,
				persons: persons.value,
			});
		},
		async readOrganization(organizationId) {
			const rows = await readStoreValue(
				async () =>
					database()
						.select({
							organizationId: organizationFence.id,
							revision: organizationFence.revision,
							state: organizationFence.state,
							permissionPolicyDigest: organizationFence.permissionPolicyDigest,
						})
						.from(organizationFence)
						.where(eq(organizationFence.id, organizationId))
						.limit(1),
				z.array(pendingOrganizationSchema),
			);
			if (rows.kind === 'store-unavailable') return rows;
			return availableStoreValue(rows.value[0] ?? null);
		},
		async recordOrganizationAcknowledgement({ organizationId, acknowledgedRevision }) {
			const now = props.platform.clock.now();
			// r3 section 6: only a newer ACK, never above the current revision.
			return changed(async () =>
				database()
					.update(organizationFence)
					.set({ acknowledgedRevision, acknowledgedAt: now })
					.where(
						and(
							eq(organizationFence.id, organizationId),
							lt(organizationFence.acknowledgedRevision, acknowledgedRevision),
							gte(organizationFence.revision, acknowledgedRevision),
						),
					)
					.returning({ id: organizationFence.id }),
			);
		},
		async recordPersonAcknowledgement({
			subjectId,
			organizationId,
			personId,
			acknowledgedRevision,
		}) {
			const now = props.platform.clock.now();
			return changed(async () =>
				database()
					.update(personFence)
					.set({ acknowledgedRevision, acknowledgedAt: now })
					.where(
						and(
							eq(personFence.id, subjectId),
							eq(personFence.organizationId, organizationId),
							eq(personFence.personId, personId),
							lt(personFence.acknowledgedRevision, acknowledgedRevision),
							gte(personFence.revision, acknowledgedRevision),
						),
					)
					.returning({ id: personFence.id }),
			);
		},
		async deferOrganization({ organizationId, pushedRevision, nextAttemptAt }) {
			const result = await changed(async () =>
				database()
					.update(organizationFence)
					.set({ nextAttemptAt })
					.where(
						and(
							eq(organizationFence.id, organizationId),
							eq(organizationFence.revision, pushedRevision),
						),
					)
					.returning({ id: organizationFence.id }),
			);
			return result.kind === 'available' ? availableStoreValue(undefined) : result;
		},
		async deferPerson({ subjectId, pushedRevision, nextAttemptAt }) {
			const result = await changed(async () =>
				database()
					.update(personFence)
					.set({ nextAttemptAt })
					.where(and(eq(personFence.id, subjectId), eq(personFence.revision, pushedRevision)))
					.returning({ id: personFence.id }),
			);
			return result.kind === 'available' ? availableStoreValue(undefined) : result;
		},
		async forgetCentralAcknowledgements(organizationId) {
			try {
				const outcome = await props.platform.runAtomically([
					database()
						.update(organizationFence)
						.set({ acknowledgedRevision: 0 })
						.where(eq(organizationFence.id, organizationId))
						.returning({ id: organizationFence.id }),
					database()
						.update(personFence)
						.set({ acknowledgedRevision: 0 })
						.where(eq(personFence.organizationId, organizationId))
						.returning({ id: personFence.id }),
				]);
				const organizations = atomicStoreRows(outcome, 0, z.object({ id: z.string() }));
				return organizations.kind === 'store-unavailable'
					? organizations
					: availableStoreValue(undefined);
			} catch (error) {
				return storeFailure(error);
			}
		},
		async readSynchronization(scope) {
			// One snapshot (a D1 batch, one SQLite transaction): reads taken apart could pair a
			// pre-bump pair with a post-ACK organization and answer synced when it never was.
			try {
				const organizations = database()
					.select({
						organizationId: organizationFence.id,
						revision: organizationFence.revision,
						acknowledgedRevision: organizationFence.acknowledgedRevision,
					})
					.from(organizationFence)
					.where(
						scope.kind === 'personEverywhere'
							? inArray(
									organizationFence.id,
									database()
										.select({ organizationId: personFence.organizationId })
										.from(personFence)
										.where(eq(personFence.personId, scope.personId)),
								)
							: eq(organizationFence.id, scope.organizationId),
					);
				if (scope.kind === 'organization') {
					const outcome = await props.platform.runAtomically([organizations]);
					const rows = atomicStoreRows(outcome, 0, synchronizationFenceSchema);
					if (rows.kind === 'store-unavailable') return rows;
					return availableStoreValue(
						rows.value.length === 1 && rows.value.every(isCaughtUp) ? 'synced' : 'pending',
					);
				}
				const pairs = database()
					.select({
						organizationId: personFence.organizationId,
						revision: personFence.revision,
						acknowledgedRevision: personFence.acknowledgedRevision,
					})
					.from(personFence)
					.where(
						scope.kind === 'personEverywhere'
							? eq(personFence.personId, scope.personId)
							: and(
									eq(personFence.personId, scope.personId),
									eq(personFence.organizationId, scope.organizationId),
								),
					);
				const outcome = await props.platform.runAtomically([pairs, organizations]);
				const pairRows = atomicStoreRows(outcome, 0, synchronizationFenceSchema);
				if (pairRows.kind === 'store-unavailable') return pairRows;
				const organizationRows = atomicStoreRows(outcome, 1, synchronizationFenceSchema);
				if (organizationRows.kind === 'store-unavailable') return organizationRows;
				return availableStoreValue(
					isPersonScopeSynchronized(pairRows.value, organizationRows.value) ? 'synced' : 'pending',
				);
			} catch (error) {
				return storeFailure(error);
			}
		},
	};
}
