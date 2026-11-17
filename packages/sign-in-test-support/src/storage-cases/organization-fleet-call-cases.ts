import {
	createCentralLinkClient,
	member,
	organization,
	organizationAuthorizationRevisions as organizationFence,
	organizationIdSchema,
	personOrganizationAuthorizationRevisions as personFence,
	runAuthorizationRevisionDrain,
	session,
	type AuthorizationRevisionPush,
	type AuthorizationRevisionPushAnswer,
	type OrganizationId,
} from '@agent-collaboration/sign-in-core';
import {
	createOrganizationFleetCallGuard,
	type SignInHttpConfiguration,
} from '@agent-collaboration/sign-in-core/better-auth';
import { eq } from 'drizzle-orm';

import { createCentralStampModel } from '#sign-in-test-support/storage-cases/organization-stamp-central-model';
import type { StorageCaseContext } from '#sign-in-test-support/storage-cases/storage-case-context';
import type { StorageCaseDefinition } from '#sign-in-test-support/storage-cases/storage-case-registry';
import {
	createStoragePerson,
	resetStorageCase,
} from '#sign-in-test-support/storage-cases/storage-case-utilities';
import { storageProviderProperties } from '#sign-in-test-support/storage-cases/storage-provider-fixture';
import { createManualDeadlines } from '#sign-in-test-support/test-fixtures/manual-deadlines';

type PushBehaviour = 'acknowledge' | 'acknowledge-older' | 'refuse-conflict' | 'hold';

/** Central's revision route: it records each push in order, then acknowledges, refuses or holds
 * it unanswered (ignoring the abort, recording it), so only the guard's deadline can end a hold. */
function createPushPeer(): {
	readonly pushes: AuthorizationRevisionPush[];
	readonly observedAborts: string[];
	readonly next: (...behaviours: PushBehaviour[]) => void;
	readonly arrived: () => Promise<void>;
	/** Resolves once the peer has received this many pushes in total. */
	readonly arrivedAt: (count: number) => Promise<void>;
	/** Runs once a push arrives and before central answers it, as a concurrent local write. */
	readonly beforeAnswer: (hook: (push: AuthorizationRevisionPush) => Promise<void>) => void;
	readonly push: (
		push: AuthorizationRevisionPush,
		options?: { readonly signal?: AbortSignal },
	) => Promise<AuthorizationRevisionPushAnswer>;
} {
	const pushes: AuthorizationRevisionPush[] = [];
	const observedAborts: string[] = [];
	const behaviours: PushBehaviour[] = [];
	let notify: (() => void) | null = null;
	let hook: ((push: AuthorizationRevisionPush) => Promise<void>) | null = null;
	const countWaiters: { readonly count: number; readonly resolve: () => void }[] = [];
	return {
		pushes,
		observedAborts,
		next: (...more) => behaviours.push(...more),
		arrived: async () => {
			const { promise, resolve } = Promise.withResolvers<void>();
			notify = resolve;
			return promise;
		},
		arrivedAt: async (count) => {
			if (pushes.length >= count) return;
			const { promise, resolve } = Promise.withResolvers<void>();
			countWaiters.push({ count, resolve });
			return promise;
		},
		beforeAnswer: (next) => {
			hook = next;
		},
		async push(push, options) {
			pushes.push(push);
			notify?.();
			for (const waiter of countWaiters.filter((entry) => pushes.length >= entry.count)) {
				countWaiters.splice(countWaiters.indexOf(waiter), 1);
				waiter.resolve();
			}
			await hook?.(push);
			const behaviour = behaviours.shift() ?? 'acknowledge';
			if (behaviour === 'refuse-conflict') return { kind: 'refused', reason: 'conflict' };
			if (behaviour === 'hold') {
				options?.signal?.addEventListener(
					'abort',
					(): void => {
						const reason: unknown = options.signal?.reason;
						observedAborts.push(reason instanceof Error ? reason.name : 'unnamed');
					},
					{ once: true },
				);
				return new Promise<AuthorizationRevisionPushAnswer>((): void => undefined);
			}
			if (behaviour === 'acknowledge-older')
				return { kind: 'acknowledged', acknowledgedRevision: push.revision - 1 };
			return { kind: 'acknowledged', acknowledgedRevision: push.revision };
		},
	};
}

interface FleetCallSetup {
	readonly peer: ReturnType<typeof createPushPeer>;
	readonly central: ReturnType<typeof createCentralStampModel>;
	readonly starts: readonly number[];
	readonly fire: () => void;
	readonly configuration: SignInHttpConfiguration;
}

/** The production guard through its server-only endpoint; the stamp is current unless asked. */
function fleetCallSetup(
	context: StorageCaseContext,
	organizationId: OrganizationId,
): FleetCallSetup {
	const peer = createPushPeer();
	const central = createCentralStampModel();
	const manual = createManualDeadlines();
	const base = storageProviderProperties(context, organizationId);
	const stampClient = createCentralLinkClient({
		fetch: async () => new Response(null, { status: 503 }),
	});
	const configuration: SignInHttpConfiguration = {
		...base,
		platform: {
			...base.platform,
			deadlines: manual.deadlines,
			centralClient: {
				...stampClient,
				provisionOrganization: central.client.provisionOrganization,
				readStatementDigest: central.client.readStatementDigest,
				pushAuthorizationRevision: peer.push,
			},
		},
	};
	return { peer, central, starts: manual.starts, fire: manual.fire, configuration };
}

/**
 * An organization with a pending organization row and person row, both inside their retry wait.
 * `no-stamp-step`: not yet ready, so the stamp step has nothing to renew and only delivery runs;
 * `due`: ready with a stamp 59 days from expiry, so the stamp step renews first.
 */
async function pendingOrganization(
	context: StorageCaseContext,
	stamp: 'no-stamp-step' | 'due',
): Promise<{ readonly organizationId: OrganizationId; readonly personId: string }> {
	const organizationId = organizationIdSchema.parse(context.platform.ids.nextId());
	const personId = context.platform.ids.nextId();
	const now = context.platform.clock.now();
	const nowSeconds = Math.floor(now / 1000);
	await context
		.openDatabase()
		.insert(organization)
		.values({
			id: organizationId,
			name: 'Fleet call',
			slug: `fleet-call-${organizationId}`,
			createdAt: new Date(now),
			...(stamp === 'due'
				? {
						fleetState: 'ready',
						fleetStampDigest: 'c'.repeat(64),
						fleetStampExpiresAt: nowSeconds + 59 * 86_400,
						fleetStampSigningKeyId: 'held-native-key',
					}
				: { fleetState: 'settingUp' }),
		});
	await context
		.openDatabase()
		.insert(organizationFence)
		.values({
			id: organizationId,
			revision: 2,
			state: 'active',
			permissionPolicyDigest: 'a'.repeat(64),
			acknowledgedRevision: 1,
			nextAttemptAt: now + 60_000,
			createdAt: now,
			updatedAt: now,
		});
	await context
		.openDatabase()
		.insert(personFence)
		.values({
			id: context.platform.ids.nextId(),
			organizationId,
			personId,
			revision: 3,
			state: 'inactive',
			acknowledgedRevision: 2,
			nextAttemptAt: now + 60_000,
			createdAt: now,
			updatedAt: now,
		});
	return { organizationId, personId };
}

function pushedRows(peer: ReturnType<typeof createPushPeer>, organizationId: string): string[] {
	return peer.pushes
		.filter((push) => push.organizationId === organizationId)
		.map((push) => `${push.kind}:${push.revision}`);
}

async function deliveredBeforeTheCall(context: StorageCaseContext): Promise<unknown> {
	await resetStorageCase(context);
	const called = await pendingOrganization(context, 'no-stamp-step');
	const other = await pendingOrganization(context, 'no-stamp-step');
	const setup = fleetCallSetup(context, called.organizationId);
	// Act: the call's guard run; both rows are still inside their retry wait.
	const readiness = await createOrganizationFleetCallGuard(setup.configuration)(
		called.organizationId,
	);
	return {
		readiness: { kind: readiness.kind, revisions: readiness.revisions },
		calledPushes: pushedRows(setup.peer, called.organizationId),
		otherPushes: pushedRows(setup.peer, other.organizationId),
		budgets: [...setup.starts],
	};
}

async function undeliveredHoldsTheCall(context: StorageCaseContext): Promise<unknown> {
	await resetStorageCase(context);
	const refused = await pendingOrganization(context, 'no-stamp-step');
	const refusing = fleetCallSetup(context, refused.organizationId);
	refusing.peer.next('refuse-conflict');
	const afterRefusal = await createOrganizationFleetCallGuard(refusing.configuration)(
		refused.organizationId,
	);
	const held = await pendingOrganization(context, 'no-stamp-step');
	const holding = fleetCallSetup(context, held.organizationId);
	holding.peer.next('hold');
	const arrived = holding.peer.arrived();
	const running = createOrganizationFleetCallGuard(holding.configuration)(held.organizationId);
	await arrived;
	holding.fire();
	const afterDeadline = await running;
	return {
		refused: {
			kind: afterRefusal.kind,
			revisions: afterRefusal.revisions.kind,
			pushes: pushedRows(refusing.peer, refused.organizationId),
		},
		heldPastDeadline: {
			kind: afterDeadline.kind,
			revisions: afterDeadline.revisions.kind,
			pushes: pushedRows(holding.peer, held.organizationId),
			peerObservedAbort: [...holding.peer.observedAborts],
			budgets: [...holding.starts],
		},
	};
}

async function renewalSpendsTheBudget(context: StorageCaseContext): Promise<unknown> {
	await resetStorageCase(context);
	const due = await pendingOrganization(context, 'due');
	const setup = fleetCallSetup(context, due.organizationId);
	setup.central.nextBehaviours('lose-before-apply');
	// The renewal is answered `unknown` only after the deadline has fired.
	const original = setup.configuration.platform.centralClient.provisionOrganization;
	const configuration: SignInHttpConfiguration = {
		...setup.configuration,
		platform: {
			...setup.configuration.platform,
			centralClient: {
				...setup.configuration.platform.centralClient,
				provisionOrganization: async (input) => {
					const answer = original(input);
					setup.fire();
					return answer;
				},
			},
		},
	};
	const readiness = await createOrganizationFleetCallGuard(configuration)(due.organizationId);
	return {
		kind: readiness.kind,
		renewal: readiness.renewal.kind,
		revisions: readiness.revisions.kind,
		pushes: pushedRows(setup.peer, due.organizationId),
		budgets: [...setup.starts],
	};
}

async function hintDrainPushesEachRowOnce(context: StorageCaseContext): Promise<unknown> {
	await resetStorageCase(context);
	const first = await pendingOrganization(context, 'no-stamp-step');
	const second = await pendingOrganization(context, 'no-stamp-step');
	const setup = fleetCallSetup(context, first.organizationId);
	// The hint's drain lists rows past their retry time.
	context.setTime(context.platform.clock.now() + 60_000);
	const run = await runAuthorizationRevisionDrain({
		...setup.configuration,
		prepareFleetCall: createOrganizationFleetCallGuard(setup.configuration),
	});
	context.setTime(context.platform.clock.now() - 60_000);
	return {
		run,
		first: pushedRows(setup.peer, first.organizationId),
		second: pushedRows(setup.peer, second.organizationId),
	};
}

/** R-batch (Lead, 13 Nov): an organization with more pending person pairs than one batch. */
async function manyPendingPairs(
	context: StorageCaseContext,
	pairs: number,
): Promise<OrganizationId> {
	const { organizationId } = await pendingOrganization(context, 'no-stamp-step');
	const now = context.platform.clock.now();
	const rows = Array.from({ length: pairs - 1 }, () => ({
		id: context.platform.ids.nextId(),
		organizationId,
		personId: context.platform.ids.nextId(),
		revision: 2,
		state: 'inactive' as const,
		acknowledgedRevision: 1,
		nextAttemptAt: now + 60_000,
		createdAt: now,
		updatedAt: now,
	}));
	// D1 bounds bound parameters per statement, so the rows go in groups of ten.
	for (let start = 0; start < rows.length; start += 10)
		// oxlint-disable-next-line no-await-in-loop -- each group is one bounded insert.
		await context
			.openDatabase()
			.insert(personFence)
			.values(rows.slice(start, start + 10));
	return organizationId;
}

async function pairCounts(
	context: StorageCaseContext,
	organizationId: OrganizationId,
): Promise<{ readonly pairs: number; readonly unacknowledged: number }> {
	const rows = await context
		.openDatabase()
		.select({ revision: personFence.revision, acknowledged: personFence.acknowledgedRevision })
		.from(personFence)
		.where(eq(personFence.organizationId, organizationId));
	return {
		pairs: rows.length,
		unacknowledged: rows.filter((row) => row.revision > row.acknowledged).length,
	};
}

async function everyBatchBeforeTheCall(context: StorageCaseContext): Promise<unknown> {
	await resetStorageCase(context);
	const organizationId = await manyPendingPairs(context, 250);
	const setup = fleetCallSetup(context, organizationId);
	const readiness = await createOrganizationFleetCallGuard(setup.configuration)(organizationId);
	return {
		kind: readiness.kind,
		revisions: readiness.revisions,
		organizationPushes: setup.peer.pushes.filter((push) => push.kind === 'organization').length,
		personPushes: setup.peer.pushes.filter((push) => push.kind === 'person').length,
		...(await pairCounts(context, organizationId)),
		budgets: [...setup.starts],
	};
}

async function deadlineInALaterBatch(context: StorageCaseContext): Promise<unknown> {
	await resetStorageCase(context);
	const organizationId = await manyPendingPairs(context, 150);
	const setup = fleetCallSetup(context, organizationId);
	// A batch is the fence and 100 pairs; the 130th push, in the second batch, is held.
	setup.peer.next(...Array.from({ length: 129 }, (): PushBehaviour => 'acknowledge'), 'hold');
	const running = createOrganizationFleetCallGuard(setup.configuration)(organizationId);
	// A run that stops after one batch never reaches the hold; it must not hang the case.
	await Promise.race([setup.peer.arrivedAt(130), running]);
	setup.fire();
	const readiness = await running;
	return {
		kind: readiness.kind,
		revisions: readiness.revisions.kind,
		pushes: setup.peer.pushes.length,
		peerObservedAbort: [...setup.peer.observedAborts],
		...(await pairCounts(context, organizationId)),
		budgets: [...setup.starts],
	};
}

async function revisionAdvancesWhileAcknowledged(context: StorageCaseContext): Promise<unknown> {
	await resetStorageCase(context);
	const { organizationId, personId } = await pendingOrganization(context, 'no-stamp-step');
	const setup = fleetCallSetup(context, organizationId);
	// A local change lands while central is answering the pair's revision 3.
	setup.peer.beforeAnswer(async (push) => {
		if (push.kind !== 'person' || push.revision !== 3) return;
		await context
			.openDatabase()
			.update(personFence)
			.set({ revision: 4, state: 'active' })
			.where(eq(personFence.personId, personId));
	});
	const readiness = await createOrganizationFleetCallGuard(setup.configuration)(organizationId);
	return {
		kind: readiness.kind,
		revisions: readiness.revisions,
		pushes: pushedRows(setup.peer, organizationId),
		...(await pairCounts(context, organizationId)),
		budgets: [...setup.starts],
	};
}

async function olderAcknowledgementEndsTheRun(context: StorageCaseContext): Promise<unknown> {
	await resetStorageCase(context);
	const { organizationId } = await pendingOrganization(context, 'no-stamp-step');
	const setup = fleetCallSetup(context, organizationId);
	// Central answers the pair with the revision it already held, so nothing new is recorded.
	setup.peer.next('acknowledge', 'acknowledge-older');
	// A run that pushed the same revision again would spin until its deadline; end it there.
	setup.peer.beforeAnswer(async () => {
		if (setup.peer.pushes.length > 2) setup.fire();
	});
	const readiness = await createOrganizationFleetCallGuard(setup.configuration)(organizationId);
	return {
		kind: readiness.kind,
		revisions: readiness.revisions,
		pushes: pushedRows(setup.peer, organizationId),
		...(await pairCounts(context, organizationId)),
		budgets: [...setup.starts],
	};
}

/** A person with one session in one organization whose rows predate the fence tables. */
async function unfencedMembership(context: StorageCaseContext): Promise<{
	readonly organizationId: OrganizationId;
	readonly personId: string;
	readonly sessionId: string;
}> {
	const personId = await createStoragePerson(
		context,
		`${context.platform.ids.nextId()}@example.invalid`,
	);
	const organizationId = organizationIdSchema.parse(context.platform.ids.nextId());
	const now = new Date(context.platform.clock.now());
	await context
		.openDatabase()
		.insert(organization)
		.values({
			id: organizationId,
			name: 'Unfenced',
			slug: `unfenced-${organizationId}`,
			createdAt: now,
		});
	await context.openDatabase().insert(member).values({
		id: context.platform.ids.nextId(),
		organizationId,
		userId: personId,
		role: 'owner',
		createdAt: now,
	});
	const sessionId = context.platform.ids.nextId();
	await context
		.openDatabase()
		.insert(session)
		.values({
			id: sessionId,
			token: context.platform.ids.nextId(),
			userId: personId,
			expiresAt: new Date(context.platform.clock.now() + 3_600_000),
			createdAt: now,
			updatedAt: now,
		});
	return { organizationId, personId, sessionId };
}

async function fenceRows(context: StorageCaseContext, organizationId: string): Promise<unknown> {
	const database = context.openDatabase();
	return {
		organization: (
			await database
				.select({ revision: organizationFence.revision })
				.from(organizationFence)
				.where(eq(organizationFence.id, organizationId))
		).map((row) => row.revision),
		pairs: (
			await database
				.select({ revision: personFence.revision, state: personFence.state })
				.from(personFence)
				.where(eq(personFence.organizationId, organizationId))
		).map((row) => `${row.state}:${row.revision}`),
	};
}

async function sessionsOf(context: StorageCaseContext, personId: string): Promise<number> {
	return (
		await context
			.openDatabase()
			.select({ id: session.id })
			.from(session)
			.where(eq(session.userId, personId))
	).length;
}

async function backfillRecovery(context: StorageCaseContext): Promise<unknown> {
	await resetStorageCase(context);
	// Wholly unfenced: the fenced write backfills its own organization and lands once.
	const unfenced = await unfencedMembership(context);
	const recovered = await context.store.persons.deleteSession(unfenced.sessionId);
	// A lost retained pair beside a present organization fence: r3, never reset, fails closed.
	const lost = await unfencedMembership(context);
	const { backfillAuthorizationRevisions } = await import('@agent-collaboration/sign-in-core');
	await backfillAuthorizationRevisions({
		openDatabase: context.openDatabase,
		platform: context.platform,
		organizationIds: [lost.organizationId],
	});
	await context.openDatabase().delete(personFence).where(eq(personFence.personId, lost.personId));
	const lostBefore = await fenceRows(context, lost.organizationId);
	const refusedLost = await context.store.persons.deleteSession(lost.sessionId);
	// A wholly unfenced organization whose backfill fails: still fails closed, nothing written.
	const failing = await unfencedMembership(context);
	context.setFault({
		operation: 'select',
		table: 'member',
		key: failing.organizationId,
		additionalKeys: [],
	});
	const refusedFailing = await context.store.persons.deleteSession(failing.sessionId);
	context.setFault(null);
	return {
		recovered: {
			result: recovered.kind,
			sessions: await sessionsOf(context, unfenced.personId),
			fences: await fenceRows(context, unfenced.organizationId),
		},
		lostRetainedPair: {
			result: refusedLost.kind,
			sessions: await sessionsOf(context, lost.personId),
			unchanged:
				JSON.stringify(await fenceRows(context, lost.organizationId)) ===
				JSON.stringify(lostBefore),
		},
		failedBackfill: {
			result: refusedFailing.kind,
			sessions: await sessionsOf(context, failing.personId),
			fences: await fenceRows(context, failing.organizationId),
		},
	};
}

/** WS3 (owner, 12 Nov; Lead rulings Q1 = A and Q2): no timer; each guard run drains on use. */
export const organizationFleetCallCases: readonly StorageCaseDefinition[] = [
	{
		name: "fleet call: the guard delivers its organization's pending revisions, fence before pair and inside their retry wait, before the call; another organization waits",
		expected: {
			readiness: {
				kind: 'ready',
				revisions: { kind: 'delivered', acknowledged: 2, deferred: 0, discrepancies: 0 },
			},
			calledPushes: ['organization:2', 'person:3'],
			otherPushes: [],
			budgets: [5_000],
		},
		run: deliveredBeforeTheCall,
	},
	{
		name: 'fleet call: an undelivered revision holds the call back, whether refused or held past the one deadline (Q1 = A)',
		expected: {
			refused: { kind: 'unavailable', revisions: 'pending', pushes: ['organization:2'] },
			heldPastDeadline: {
				kind: 'unavailable',
				revisions: 'pending',
				pushes: ['organization:2'],
				peerObservedAbort: ['TimeoutError'],
				budgets: [5_000],
			},
		},
		run: undeliveredHoldsTheCall,
	},
	{
		name: 'fleet call: a renewal that spends the one budget leaves pending revisions unsent and the call unavailable over a valid stamp (Q2)',
		expected: {
			kind: 'unavailable',
			renewal: 'unanswered',
			revisions: 'pending',
			pushes: [],
			budgets: [5_000],
		},
		run: renewalSpendsTheBudget,
	},
	{
		name: 'fleet call: every pending batch is delivered, and a re-read finds none pending, before the call goes out past one batch of 100 (R-batch)',
		expected: {
			kind: 'ready',
			revisions: { kind: 'delivered', acknowledged: 251, deferred: 0, discrepancies: 0 },
			organizationPushes: 1,
			personPushes: 250,
			pairs: 250,
			unacknowledged: 0,
			budgets: [5_000],
		},
		run: everyBatchBeforeTheCall,
	},
	{
		name: 'fleet call: a deadline in a later batch keeps the call back with rows still pending (R-batch, Q1 = A)',
		expected: {
			kind: 'unavailable',
			revisions: 'pending',
			pushes: 130,
			peerObservedAbort: ['TimeoutError'],
			pairs: 150,
			unacknowledged: 22,
			budgets: [5_000],
		},
		run: deadlineInALaterBatch,
	},
	{
		name: "fleet call: a pair's revision that advances while its older ACK is recorded is re-read pending and delivered before the call, never ready on the old ACK (R-batch)",
		expected: {
			kind: 'ready',
			revisions: { kind: 'delivered', acknowledged: 3, deferred: 0, discrepancies: 0 },
			pushes: ['organization:2', 'person:3', 'person:4'],
			pairs: 1,
			unacknowledged: 0,
			budgets: [5_000],
		},
		run: revisionAdvancesWhileAcknowledged,
	},
	{
		name: 'fleet call: an ACK of an older revision leaves its row pending and the call back, without pushing that revision again (R-batch)',
		expected: {
			kind: 'unavailable',
			revisions: { kind: 'pending', acknowledged: 2, deferred: 0, discrepancies: 0 },
			pushes: ['organization:2', 'person:3'],
			pairs: 1,
			unacknowledged: 1,
			budgets: [5_000],
		},
		run: olderAcknowledgementEndsTheRun,
	},
	{
		name: "fleet call: the hint's drain runs one guard per organization and pushes each row exactly once",
		expected: {
			run: { kind: 'complete', acknowledged: 4, deferred: 0, discrepancies: 0 },
			first: ['organization:2', 'person:3'],
			second: ['organization:2', 'person:3'],
		},
		run: hintDrainPushesEachRowOnce,
	},
	{
		name: 'fleet call: a fenced write meeting a wholly unfenced organization backfills it and lands once; a lost retained pair or a failed backfill still fails closed',
		expected: {
			recovered: {
				result: 'available',
				sessions: 0,
				fences: { organization: [1], pairs: ['active:2'] },
			},
			lostRetainedPair: { result: 'store-unavailable', sessions: 1, unchanged: true },
			failedBackfill: {
				result: 'store-unavailable',
				sessions: 1,
				fences: { organization: [], pairs: [] },
			},
		},
		run: backfillRecovery,
	},
];
