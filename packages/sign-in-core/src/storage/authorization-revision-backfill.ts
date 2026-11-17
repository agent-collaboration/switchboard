import { and, eq, inArray, notExists, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { AtomicStatement, SignInPlatform } from '#sign-in-core/contracts/sign-in-platform';
import { fleetPermissionPolicyDigest } from '#sign-in-core/organizations/fleet-permission-policy-digest';
import type {
	SignInDatabaseFactory,
	SignInStoreResult,
} from '#sign-in-core/storage/models/sign-in-database';
import {
	member,
	organization,
	organizationAuthorizationRevisions as organizationFence,
	personOrganizationAuthorizationRevisions as personFence,
} from '#sign-in-core/storage/sign-in-schema';
import { availableStoreValue, readStoreValue } from '#sign-in-core/storage/store-query-results';

export interface AuthorizationRevisionBackfill {
	readonly organizationFencesAdded: number;
	readonly personPairsAdded: number;
}

/**
 * Option D (Lead, 8 Nov; owner decision pending): give rows that predate the fence tables
 * their retained fences. Insert-or-ignore throughout, so it never touches an existing fence,
 * concurrent runs converge on one row per pair, and a losing run's injected ID is discarded.
 * Until it completes, fenced writes for those rows keep failing closed.
 */
export async function backfillAuthorizationRevisions(props: {
	readonly openDatabase: SignInDatabaseFactory;
	readonly platform: Pick<SignInPlatform, 'runAtomically' | 'clock' | 'ids'>;
	/** WS3 recovery: only these organizations; absent means every organization (deploy, startup). */
	readonly organizationIds?: readonly string[];
}): Promise<SignInStoreResult<AuthorizationRevisionBackfill>> {
	const database = props.openDatabase();
	const now = props.platform.clock.now();
	const scope = props.organizationIds;
	if (scope !== undefined && scope.length === 0)
		return availableStoreValue({ organizationFencesAdded: 0, personPairsAdded: 0 });
	// Pairs need one injected ID each, so read the candidates first; each insert below
	// re-checks its member row inside the batch, so a membership gone since is not created.
	const candidates = await readStoreValue(
		async () =>
			database
				.select({ organizationId: member.organizationId, personId: member.userId })
				.from(member)
				.where(
					and(
						scope === undefined ? undefined : inArray(member.organizationId, [...scope]),
						notExists(
							database
								.select({ id: personFence.id })
								.from(personFence)
								.where(
									and(
										eq(personFence.organizationId, member.organizationId),
										eq(personFence.personId, member.userId),
									),
								),
						),
					),
				),
		z.array(z.strictObject({ organizationId: z.string(), personId: z.string() })),
	);
	if (candidates.kind === 'store-unavailable') return candidates;
	// The organization's own ID names its fence, so no new identifier is needed.
	const organizationFences = database
		.insert(organizationFence)
		.select(
			database
				.select({
					id: organization.id,
					revision: sql<number>`${1}`.as('revision'),
					state: sql<'active'>`${'active'}`.as('state'),
					permissionPolicyDigest: sql<string>`${fleetPermissionPolicyDigest}`.as(
						'permission_policy_digest',
					),
					acknowledgedRevision: sql<number>`${0}`.as('acknowledged_revision'),
					acknowledgedAt: sql<null>`${null}`.as('acknowledged_at'),
					nextAttemptAt: sql<number>`${now}`.as('next_attempt_at'),
					createdAt: sql<number>`${now}`.as('created_at'),
					updatedAt: sql<number>`${now}`.as('updated_at'),
				})
				.from(organization)
				// SQLite needs a WHERE before an upsert clause on INSERT ... SELECT.
				.where(
					and(
						scope === undefined ? undefined : inArray(organization.id, [...scope]),
						notExists(
							database
								.select({ id: organizationFence.id })
								.from(organizationFence)
								.where(eq(organizationFence.id, organization.id)),
						),
					),
				),
		)
		.onConflictDoNothing({ target: organizationFence.id })
		.returning({ id: organizationFence.id });
	const personPairs = candidates.value.map((candidate): AtomicStatement =>
		database
			.insert(personFence)
			.select(
				database
					.select({
						id: sql<string>`${props.platform.ids.nextId()}`.as('id'),
						organizationId: member.organizationId,
						personId: member.userId,
						revision: sql<number>`${1}`.as('revision'),
						state: sql<'active'>`${'active'}`.as('state'),
						acknowledgedRevision: sql<number>`${0}`.as('acknowledged_revision'),
						acknowledgedAt: sql<null>`${null}`.as('acknowledged_at'),
						nextAttemptAt: sql<number>`${now}`.as('next_attempt_at'),
						createdAt: sql<number>`${now}`.as('created_at'),
						updatedAt: sql<number>`${now}`.as('updated_at'),
					})
					.from(member)
					.where(
						and(
							eq(member.organizationId, candidate.organizationId),
							eq(member.userId, candidate.personId),
						),
					)
					.limit(1),
			)
			.onConflictDoNothing({ target: [personFence.organizationId, personFence.personId] })
			.returning({ id: personFence.id }),
	);
	const outcome = await props.platform.runAtomically([organizationFences, ...personPairs]);
	if (outcome.kind === 'failed') return { kind: 'store-unavailable', reason: outcome.reason };
	const [organizationRows = [], ...pairRows] = outcome.rows;
	return availableStoreValue({
		organizationFencesAdded: organizationRows.length,
		personPairsAdded: pairRows.reduce((total, rows) => total + rows.length, 0),
	});
}

/** The hosts' entry point: one bounded run whose outcome is observable, never thrown. */
export async function runAuthorizationRevisionBackfill(props: {
	readonly openDatabase: SignInDatabaseFactory;
	readonly platform: Pick<SignInPlatform, 'runAtomically' | 'clock' | 'ids' | 'log'>;
}): Promise<SignInStoreResult<AuthorizationRevisionBackfill>> {
	const result = await backfillAuthorizationRevisions(props);
	props.platform.log(
		result.kind === 'available'
			? { kind: 'authorization-backfill-complete', ...result.value }
			: { kind: 'authorization-backfill-unavailable', reason: result.reason },
	);
	return result;
}
