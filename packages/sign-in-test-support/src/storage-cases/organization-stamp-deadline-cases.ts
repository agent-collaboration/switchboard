import {
	centralProvisioningRequestSchema,
	centralStatementDigestRequestSchema,
	createCentralLinkClient,
	organization,
	organizationIdSchema,
	readOrganizationStatementFacts,
	type OrganizationId,
} from '@agent-collaboration/sign-in-core';
import {
	createOrganizationFleetCallGuard,
	type SignInHttpConfiguration,
} from '@agent-collaboration/sign-in-core/better-auth';
import { eq } from 'drizzle-orm';

import {
	createCentralStampModel,
	createStatementSigner,
	type CentralStampModel,
} from '#sign-in-test-support/storage-cases/organization-stamp-central-model';
import type { StorageCaseContext } from '#sign-in-test-support/storage-cases/storage-case-context';
import type { StorageCaseDefinition } from '#sign-in-test-support/storage-cases/storage-case-registry';
import { storageProviderProperties } from '#sign-in-test-support/storage-cases/storage-provider-fixture';
import { createManualDeadlines } from '#sign-in-test-support/test-fixtures/manual-deadlines';

const day = 86_400_000;
type PeerRoute = 'replace' | 'digest';

/**
 * The central end of the real link client: it answers through the e847a888 replacement model,
 * or holds a request and never replies, even after that request's signal aborts. It records the
 * abort it observed, so completion can only come from the guard's own deadline race (D7).
 */
interface HeldCentralPeer {
	readonly model: CentralStampModel;
	readonly holdNext: (route: PeerRoute) => Promise<void>;
	readonly observedAborts: readonly string[];
	readonly fetch: (request: Request) => Promise<Response>;
}

function createHeldCentralPeer(): HeldCentralPeer {
	const model = createCentralStampModel();
	const holds: { readonly route: PeerRoute; readonly arrived: () => void }[] = [];
	const observedAborts: string[] = [];
	async function holdIgnoringAbort(request: Request): Promise<Response> {
		request.signal.addEventListener(
			'abort',
			(): void => {
				const reason: unknown = request.signal.reason;
				observedAborts.push(reason instanceof Error ? reason.name : 'unnamed');
			},
			{ once: true },
		);
		return new Promise<Response>((): void => undefined);
	}
	return {
		model,
		observedAborts,
		holdNext: async (route) => {
			const { promise, resolve } = Promise.withResolvers<void>();
			holds.push({ route, arrived: resolve });
			return promise;
		},
		async fetch(request): Promise<Response> {
			const pathname = new URL(request.url).pathname;
			const route: PeerRoute | null =
				pathname === '/internal/organization-provisioning'
					? 'replace'
					: pathname === '/internal/organization-statement-digest'
						? 'digest'
						: null;
			if (route === null) return new Response(null, { status: 404 });
			const body: unknown = await request.json();
			const hold = holds.findIndex((entry) => entry.route === route);
			if (hold !== -1) {
				const [entry] = holds.splice(hold, 1);
				entry?.arrived();
				if (route === 'replace') {
					const parsed = centralProvisioningRequestSchema.parse(body);
					model.recordHeldSend(parsed.organizationId, parsed.organizationStatement);
				}
				return holdIgnoringAbort(request);
			}
			if (route === 'digest') {
				const parsed = centralStatementDigestRequestSchema.parse(body);
				const answer = await model.client.readStatementDigest(
					organizationIdSchema.parse(parsed.organizationId),
				);
				return answer.kind === 'current'
					? Response.json({
							digest: answer.digest,
							expiresAt: answer.expiresAt,
							signingKeyId: answer.signingKeyId,
						})
					: new Response(null, { status: 404 });
			}
			const parsed = centralProvisioningRequestSchema.parse(body);
			const answer = await model.client.provisionOrganization({
				organizationId: organizationIdSchema.parse(parsed.organizationId),
				organizationStatement: parsed.organizationStatement,
			});
			if (answer.kind === 'provisioned') return Response.json({ result: 'provisioned' });
			if (answer.kind === 'refused')
				return new Response(null, { status: answer.reason === 'stale' ? 409 : 422 });
			return new Response(null, { status: 503 });
		},
	};
}

interface DeadlineSetup {
	readonly organizationId: OrganizationId;
	readonly peer: HeldCentralPeer;
	readonly starts: readonly number[];
	readonly fire: () => void;
	readonly guard: () => Promise<{ readonly readiness: string; readonly renewal: unknown }>;
}

/** The production guard through its server-only endpoint, over the real link client. */
async function deadlineSetup(context: StorageCaseContext): Promise<DeadlineSetup> {
	const organizationId = organizationIdSchema.parse(context.platform.ids.nextId());
	await context
		.openDatabase()
		.insert(organization)
		.values({
			id: organizationId,
			name: 'Stamp deadline',
			slug: `stamp-deadline-${organizationId}`,
			createdAt: new Date(context.platform.clock.now()),
			fleetState: 'ready',
		});
	const peer = createHeldCentralPeer();
	const manual = createManualDeadlines();
	const base = storageProviderProperties(context, organizationId);
	const configuration: SignInHttpConfiguration = {
		...base,
		platform: {
			...base.platform,
			centralClient: createCentralLinkClient({ fetch: peer.fetch }),
			deadlines: manual.deadlines,
		},
	};
	const guard = createOrganizationFleetCallGuard(configuration);
	return {
		organizationId,
		peer,
		starts: manual.starts,
		fire: manual.fire,
		async guard() {
			const readiness = await guard(organizationId);
			return { readiness: readiness.kind, renewal: readiness.renewal };
		},
	};
}

/** Central holds a stamp signed long enough ago to sit inside (or past) its renewal window. */
async function centralHolds(
	context: StorageCaseContext,
	setup: DeadlineSetup,
	signedAt: number,
	seedRecord: boolean,
): Promise<string> {
	const now = context.platform.clock.now();
	context.setTime(signedAt);
	const statement = await createStatementSigner({
		now: () => context.platform.clock.now(),
		signingKeyId: () => 'held-native-key',
	})({ organizationId: setup.organizationId });
	context.setTime(now);
	await setup.peer.model.hold(setup.organizationId, statement);
	if (seedRecord)
		await context.store.organizationStamps.seedConfirmedStamp({
			organizationId: setup.organizationId,
			stamp: await readOrganizationStatementFacts(context.platform.crypto, statement),
		});
	return statement;
}

async function record(
	context: StorageCaseContext,
	organizationId: OrganizationId,
): Promise<unknown> {
	const row = (
		await context
			.openDatabase()
			.select({
				sent: organization.fleetStampSent,
				unanswered: organization.fleetStampUnansweredTries,
				refused: organization.fleetStampRefusedTries,
				lastTryOutcome: organization.fleetStampLastTryOutcome,
			})
			.from(organization)
			.where(eq(organization.id, organizationId))
	)[0];
	return row === undefined
		? null
		: {
				inDoubt: row.sent !== null,
				unanswered: row.unanswered,
				refused: row.refused,
				lastTryOutcome: row.lastTryOutcome,
			};
}

async function sentBytes(
	context: StorageCaseContext,
	organizationId: OrganizationId,
): Promise<string | null> {
	return (
		(
			await context
				.openDatabase()
				.select({ sent: organization.fleetStampSent })
				.from(organization)
				.where(eq(organization.id, organizationId))
		)[0]?.sent ?? null
	);
}

/** Runs one guard with `route` held, fires the deadline once the peer holds it, and waits. */
async function heldRun(
	setup: DeadlineSetup,
	route: PeerRoute,
): Promise<{ readonly readiness: string; readonly renewal: unknown }> {
	const held = setup.peer.holdNext(route);
	const running = setup.guard();
	await held;
	setup.fire();
	return running;
}

async function heldResendThenNextUse(
	context: StorageCaseContext,
	stamp: 'valid-in-window' | 'expired',
): Promise<unknown> {
	const start = context.platform.clock.now();
	const setup = await deadlineSetup(context);
	await centralHolds(
		context,
		setup,
		stamp === 'valid-in-window' ? start - 61 * day : start - 121 * day,
		true,
	);
	const timedOut = await heldRun(setup, 'replace');
	const pending = await sentBytes(context, setup.organizationId);
	const afterTimeout = await record(context, setup.organizationId);
	context.setTime(start + 60_000);
	const nextUse = await setup.guard();
	const resent = setup.peer.model.sends.map((send) => send.statement);
	context.setTime(start);
	return {
		timedOut,
		peerObservedAbort: [...setup.peer.observedAborts],
		afterTimeout,
		nextUse,
		resentPendingBytes:
			pending !== null && resent.length === 2 && resent.every((bytes) => bytes === pending),
		budgets: [...setup.starts],
		afterNextUse: await record(context, setup.organizationId),
	};
}

async function oneBudgetPerRun(context: StorageCaseContext): Promise<unknown> {
	const start = context.platform.clock.now();
	// Seed then replace: an empty record's seed read is answered, the replace is held.
	const seeding = await deadlineSetup(context);
	await centralHolds(context, seeding, start - 61 * day, false);
	const seedThenReplace = await heldRun(seeding, 'replace');
	// Replace then reconcile: central refuses as stale, the reconcile digest read is held.
	const reconciling = await deadlineSetup(context);
	await centralHolds(context, reconciling, start - 61 * day, false);
	await context.store.organizationStamps.seedConfirmedStamp({
		organizationId: reconciling.organizationId,
		stamp: {
			digest: 'e'.repeat(64),
			expiresAt: Math.floor(start / 1000) + 86_400,
			signingKeyId: 'held-native-key',
		},
	});
	const replaceThenReconcile = await heldRun(reconciling, 'digest');
	// A held first-use seed read: the timeout is counted and no pending bytes are invented.
	const seedHeld = await deadlineSetup(context);
	await centralHolds(context, seedHeld, start - 61 * day, false);
	const seedRead = await heldRun(seedHeld, 'digest');
	return {
		seedHeld: {
			result: seedRead,
			budgets: [...seedHeld.starts],
			peerObservedAbort: [...seedHeld.peer.observedAborts],
			sends: seedHeld.peer.model.sends.length,
			record: await record(context, seedHeld.organizationId),
		},
		seedThenReplace: {
			result: seedThenReplace,
			budgets: [...seeding.starts],
			peerObservedAbort: [...seeding.peer.observedAborts],
			record: await record(context, seeding.organizationId),
		},
		replaceThenReconcile: {
			result: replaceThenReconcile,
			budgets: [...reconciling.starts],
			peerObservedAbort: [...reconciling.peer.observedAborts],
			record: await record(context, reconciling.organizationId),
		},
	};
}

/** D7 (Lead, 12 Nov): one injected deadline bounds each guard run on the request path. */
export const organizationStampDeadlineCases: readonly StorageCaseDefinition[] = [
	{
		name: 'organization stamp: a renewal held past its deadline is aborted at the peer and counted unanswered; a valid stamp still lets the call out and the next use re-sends the same bytes',
		expected: {
			timedOut: { readiness: 'ready', renewal: { kind: 'unanswered', reason: 'timeout' } },
			peerObservedAbort: ['TimeoutError'],
			afterTimeout: {
				inDoubt: true,
				unanswered: 1,
				refused: 0,
				lastTryOutcome: 'unanswered-timeout',
			},
			nextUse: { readiness: 'ready', renewal: { kind: 'renewed' } },
			resentPendingBytes: true,
			budgets: [5_000, 5_000],
			afterNextUse: {
				inDoubt: false,
				unanswered: 1,
				refused: 0,
				lastTryOutcome: 'unanswered-timeout',
			},
		},
		run: (context) => heldResendThenNextUse(context, 'valid-in-window'),
	},
	{
		name: 'organization stamp: over an expired stamp a renewal held past its deadline keeps the call back, then the next use re-sends the same bytes and lets it out',
		expected: {
			timedOut: { readiness: 'unavailable', renewal: { kind: 'unanswered', reason: 'timeout' } },
			peerObservedAbort: ['TimeoutError'],
			afterTimeout: {
				inDoubt: true,
				unanswered: 1,
				refused: 0,
				lastTryOutcome: 'unanswered-timeout',
			},
			nextUse: { readiness: 'ready', renewal: { kind: 'renewed' } },
			resentPendingBytes: true,
			budgets: [5_000, 5_000],
			afterNextUse: {
				inDoubt: false,
				unanswered: 1,
				refused: 0,
				lastTryOutcome: 'unanswered-timeout',
			},
		},
		run: (context) => heldResendThenNextUse(context, 'expired'),
	},
	{
		name: 'organization stamp: one deadline covers a guard run (a held seed, seed then replace, replace then reconcile), never one per call',
		expected: {
			seedHeld: {
				result: { readiness: 'ready', renewal: { kind: 'unseeded' } },
				budgets: [5_000],
				peerObservedAbort: ['TimeoutError'],
				sends: 0,
				record: { inDoubt: false, unanswered: 1, refused: 0, lastTryOutcome: 'unanswered-timeout' },
			},
			seedThenReplace: {
				result: { readiness: 'ready', renewal: { kind: 'unanswered', reason: 'timeout' } },
				budgets: [5_000],
				peerObservedAbort: ['TimeoutError'],
				record: { inDoubt: true, unanswered: 1, refused: 0, lastTryOutcome: 'unanswered-timeout' },
			},
			replaceThenReconcile: {
				result: { readiness: 'ready', renewal: { kind: 'unanswered', reason: 'timeout' } },
				budgets: [5_000],
				peerObservedAbort: ['TimeoutError'],
				// D7: a deadline during the reconcile read is unanswered, never refused.
				record: { inDoubt: true, unanswered: 1, refused: 0, lastTryOutcome: 'unanswered-timeout' },
			},
		},
		run: oneBudgetPerRun,
	},
];
