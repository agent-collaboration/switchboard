import { expect, it } from 'vitest';

import type {
	AuthorizationRevisionPush,
	AuthorizationRevisionPushAnswer,
} from '#sign-in-core/central-link/authorization-revision-push-client';
import { epochMillisecondsSchema } from '#sign-in-core/contracts/sign-in-platform';
import {
	deliverOrganizationRevisions,
	runAuthorizationRevisionDrain,
} from '#sign-in-core/organizations/authorization-revision-drainer';
import type {
	AuthorizationRevisionDeliveryRecords,
	PendingOrganizationRevision,
	PendingPersonRevision,
} from '#sign-in-core/storage/authorization-revision-delivery-store';

const now = 2_208_988_800_000;
const organizationId = '019a3dce-2000-7000-8000-000000000001';

interface FakeRow {
	revision: number;
	acknowledgedRevision: number;
	nextAttemptAt: number;
}

/** In-memory rows with the store's own rules: pending = revision > ACK; ACK never lowers. */
function fakeStore(rows: {
	readonly organizations: readonly (PendingOrganizationRevision & {
		acknowledgedRevision: number;
	})[];
	readonly persons: readonly (PendingPersonRevision & { acknowledgedRevision: number })[];
}): { readonly store: AuthorizationRevisionDeliveryRecords; readonly state: Map<string, FakeRow> } {
	const state = new Map<string, FakeRow>();
	for (const row of rows.organizations)
		state.set(row.organizationId, {
			revision: row.revision,
			acknowledgedRevision: row.acknowledgedRevision,
			nextAttemptAt: now,
		});
	for (const row of rows.persons)
		state.set(row.subjectId, {
			revision: row.revision,
			acknowledgedRevision: row.acknowledgedRevision,
			nextAttemptAt: now,
		});
	const pending = (id: string, onUse: boolean): boolean => {
		const row = state.get(id);
		return (
			row !== undefined &&
			row.revision > row.acknowledgedRevision &&
			(onUse || row.nextAttemptAt <= now)
		);
	};
	function acknowledge(id: string, acknowledgedRevision: number): 'recorded' | 'not-recorded' {
		const row = state.get(id);
		if (
			row === undefined ||
			row.acknowledgedRevision >= acknowledgedRevision ||
			row.revision < acknowledgedRevision
		)
			return 'not-recorded';
		row.acknowledgedRevision = acknowledgedRevision;
		return 'recorded';
	}
	return {
		state,
		store: {
			// On use (an organization given) every unacknowledged row counts, whatever its wait.
			readPending: async ({ organizationId: scope }) => ({
				kind: 'available',
				value: {
					organizations: rows.organizations.filter(
						(row) =>
							(scope === undefined || row.organizationId === scope) &&
							pending(row.organizationId, scope !== undefined),
					),
					persons: rows.persons.filter(
						(row) =>
							(scope === undefined || row.organizationId === scope) &&
							pending(row.subjectId, scope !== undefined),
					),
				},
			}),
			readOrganization: async (id) => ({
				kind: 'available',
				value: rows.organizations.find((row) => row.organizationId === id) ?? null,
			}),
			recordOrganizationAcknowledgement: async ({ organizationId: id, acknowledgedRevision }) => ({
				kind: 'available',
				value: acknowledge(id, acknowledgedRevision),
			}),
			recordPersonAcknowledgement: async ({ subjectId, acknowledgedRevision }) => ({
				kind: 'available',
				value: acknowledge(subjectId, acknowledgedRevision),
			}),
			deferOrganization: async ({ organizationId: id, nextAttemptAt }) => {
				const row = state.get(id);
				if (row !== undefined) row.nextAttemptAt = nextAttemptAt;
				return { kind: 'available', value: undefined };
			},
			deferPerson: async ({ subjectId, nextAttemptAt }) => {
				const row = state.get(subjectId);
				if (row !== undefined) row.nextAttemptAt = nextAttemptAt;
				return { kind: 'available', value: undefined };
			},
			readSynchronization: async () => ({ kind: 'available', value: 'pending' }),
		},
	};
}

const organizationRow = {
	organizationId,
	revision: 2,
	state: 'active' as const,
	permissionPolicyDigest: 'd'.repeat(64),
	acknowledgedRevision: 1,
};
const personRow = {
	subjectId: '019a3dce-2000-7000-8000-000000000003',
	organizationId,
	personId: '019a3dce-2000-7000-8000-000000000002',
	revision: 4,
	state: 'inactive' as const,
	acknowledgedRevision: 3,
};

function centralAnswering(
	answer: (push: AuthorizationRevisionPush) => AuthorizationRevisionPushAnswer,
): {
	readonly pushed: AuthorizationRevisionPush[];
	readonly client: {
		pushAuthorizationRevision: (
			push: AuthorizationRevisionPush,
		) => Promise<AuthorizationRevisionPushAnswer>;
	};
} {
	const pushed: AuthorizationRevisionPush[] = [];
	return {
		pushed,
		client: {
			pushAuthorizationRevision: async (push) => {
				pushed.push(push);
				return answer(push);
			},
		},
	};
}

/** A deadline that never fires: these pushes answer at once. */
function unreached(): AbortSignal {
	return new AbortController().signal;
}
const clock = { now: () => epochMillisecondsSchema.parse(now) };

it('pushes the organization row before the person row and records each ACK central returns', async (): Promise<void> => {
	// Arrange
	const { store, state } = fakeStore({ organizations: [organizationRow], persons: [personRow] });
	const central = centralAnswering((push) => ({
		kind: 'acknowledged',
		acknowledgedRevision: push.revision,
	}));
	// Act
	const run = await deliverOrganizationRevisions({
		store,
		centralClient: central.client,
		clock,
		deadline: unreached(),
		organizationId,
	});
	// Assert
	expect(central.pushed.map((push) => push.kind)).toEqual(['organization', 'person']);
	expect(central.pushed[1]).toEqual({
		kind: 'person',
		organizationId,
		personId: personRow.personId,
		subjectId: personRow.subjectId,
		revision: 4,
		state: 'inactive',
	});
	expect(state.get(organizationId)?.acknowledgedRevision).toBe(2);
	expect(state.get(personRow.subjectId)?.acknowledgedRevision).toBe(4);
	expect(run).toEqual({ kind: 'delivered', acknowledged: 2, deferred: 0, discrepancies: 0 });
});

it.each<AuthorizationRevisionPushAnswer>([
	{ kind: 'unknown', reason: 'unavailable' },
	{ kind: 'unknown', reason: 'malformed-reply' },
	{ kind: 'refused', reason: 'conflict' },
	{ kind: 'refused', reason: 'organization-mismatch' },
])('records nothing and reschedules on $kind/$reason', async (answer): Promise<void> => {
	const { store, state } = fakeStore({ organizations: [], persons: [personRow] });
	const central = centralAnswering(() => answer);
	const run = await deliverOrganizationRevisions({
		store,
		centralClient: central.client,
		clock,
		deadline: unreached(),
		organizationId,
	});
	expect(state.get(personRow.subjectId)).toEqual({
		revision: 4,
		acknowledgedRevision: 3,
		nextAttemptAt: now + 60_000,
	});
	expect(run).toEqual({ kind: 'pending', acknowledged: 0, deferred: 1, discrepancies: 0 });
});

it('holds a person row back while its organization row is undelivered in the same pass', async (): Promise<void> => {
	const { store, state } = fakeStore({ organizations: [organizationRow], persons: [personRow] });
	const central = centralAnswering((push) =>
		push.kind === 'organization'
			? { kind: 'unknown', reason: 'unavailable' }
			: { kind: 'acknowledged', acknowledgedRevision: push.revision },
	);
	await deliverOrganizationRevisions({
		store,
		centralClient: central.client,
		clock,
		deadline: unreached(),
		organizationId,
	});
	expect(central.pushed.map((push) => push.kind)).toEqual(['organization']);
	expect(state.get(personRow.subjectId)?.acknowledgedRevision).toBe(3);
});

it('resends an already-ACKed organization row when central lacks its floor, then retries the person once', async (): Promise<void> => {
	// Arrange: the source holds the org ACK, but central answers 412 for the person.
	const ackedOrganization = { ...organizationRow, acknowledgedRevision: 2 };
	const { store, state } = fakeStore({ organizations: [ackedOrganization], persons: [personRow] });
	let organizationFloor = false;
	const central = centralAnswering((push) => {
		if (push.kind === 'organization') {
			organizationFloor = true;
			return { kind: 'acknowledged', acknowledgedRevision: push.revision };
		}
		return organizationFloor
			? { kind: 'acknowledged', acknowledgedRevision: push.revision }
			: { kind: 'refused', reason: 'organization-floor-missing' };
	});
	// Act
	await deliverOrganizationRevisions({
		store,
		centralClient: central.client,
		clock,
		deadline: unreached(),
		organizationId,
	});
	// Assert: person, org resend, person; the org ACK is not lowered or changed.
	expect(central.pushed.map((push) => push.kind)).toEqual(['person', 'organization', 'person']);
	expect(state.get(organizationId)?.acknowledgedRevision).toBe(2);
	expect(state.get(personRow.subjectId)?.acknowledgedRevision).toBe(4);
});

it('reports an ACK above the current revision as a discrepancy and records nothing', async (): Promise<void> => {
	const { store, state } = fakeStore({ organizations: [], persons: [personRow] });
	const central = centralAnswering(() => ({ kind: 'acknowledged', acknowledgedRevision: 9 }));
	const run = await deliverOrganizationRevisions({
		store,
		centralClient: central.client,
		clock,
		deadline: unreached(),
		organizationId,
	});
	expect(state.get(personRow.subjectId)?.acknowledgedRevision).toBe(3);
	expect(run).toEqual({ kind: 'pending', acknowledged: 0, deferred: 0, discrepancies: 1 });
});

it('treats a thrown push like a lost reply', async (): Promise<void> => {
	const { store, state } = fakeStore({ organizations: [], persons: [personRow] });
	const run = await deliverOrganizationRevisions({
		store,
		centralClient: {
			pushAuthorizationRevision: async () => {
				throw new Error('Transport failed');
			},
		},
		clock,
		deadline: unreached(),
		organizationId,
	});
	expect(state.get(personRow.subjectId)?.acknowledgedRevision).toBe(3);
	expect(run).toMatchObject({ kind: 'pending', deferred: 1 });
});

it('the hint drain runs one guard per organization with rows due and logs the totals it reports', async (): Promise<void> => {
	// Arrange: a second organization's person row is due too.
	const otherOrganizationId = '019a3dce-2000-7000-8000-000000000009';
	const otherPerson = {
		...personRow,
		subjectId: '019a3dce-2000-7000-8000-00000000000a',
		organizationId: otherOrganizationId,
	};
	const { store } = fakeStore({
		organizations: [organizationRow],
		persons: [personRow, otherPerson],
	});
	const guarded: string[] = [];
	const logged: unknown[] = [];
	// Act
	const run = await runAuthorizationRevisionDrain({
		store: { revisionDelivery: store },
		platform: { log: (observation) => logged.push(observation) },
		prepareFleetCall: async (id) => {
			guarded.push(id);
			return id === organizationId
				? {
						kind: 'ready',
						renewal: { kind: 'current' },
						revisions: { kind: 'delivered', acknowledged: 2, deferred: 0, discrepancies: 0 },
					}
				: {
						kind: 'unavailable',
						renewal: { kind: 'sent-expired' },
						revisions: { kind: 'not-attempted' },
					};
		},
	});
	// Assert: each organization once, in order; a not-attempted organization counts as deferred.
	expect(guarded).toEqual([organizationId, otherOrganizationId]);
	expect(run).toEqual({ kind: 'complete', acknowledged: 2, deferred: 1, discrepancies: 0 });
	expect(logged).toEqual([
		{ kind: 'authorization-drain-summary', acknowledged: 2, deferred: 1, discrepancies: 0 },
	]);
});
