import {
	createCentralLinkClient,
	organization,
	organizationAuthorizationRevisions as organizationFence,
	organizationIdSchema,
	personOrganizationAuthorizationRevisions as personFence,
	readOrganizationStatementFacts,
	type AuthorizationRevisionPush,
	type AuthorizationRevisionPushAnswer,
	type FleetAdminAnswer,
	type OrganizationId,
} from '@agent-collaboration/sign-in-core';
import {
	createOrganizationFleetCallRunner,
	createProviderRequestState,
	createSignInProvider,
	type SignInHttpConfiguration,
} from '@agent-collaboration/sign-in-core/better-auth';
import { eq } from 'drizzle-orm';
import { decodeJwt } from 'jose';

import { createCentralStampModel } from '#sign-in-test-support/storage-cases/organization-stamp-central-model';
import type { StorageCaseContext } from '#sign-in-test-support/storage-cases/storage-case-context';
import type { StorageCaseDefinition } from '#sign-in-test-support/storage-cases/storage-case-registry';
import { resetStorageCase } from '#sign-in-test-support/storage-cases/storage-case-utilities';
import { storageProviderProperties } from '#sign-in-test-support/storage-cases/storage-provider-fixture';
import { createManualDeadlines } from '#sign-in-test-support/test-fixtures/manual-deadlines';

/** `hold`: received and recorded, then never answered, whatever its abort (an admin call only). */
type LinkMode = 'decide' | 'answer-503' | 'transport-failure' | 'hold';
type DigestMode = 'answer' | 'unavailable' | 'hold';

/**
 * A controlled central that applies pinned central `e847a888`'s rules on the link:
 * - an unstamped store answers every admin call and push with a bare 503
 *   (`organization_unstamped_routes.rs:244-301`);
 * - admission needs an organization floor and a person floor at the token's revisions
 *   (`request_admission.rs` `admit`), otherwise `authorizationSyncRequired`;
 * - a person floor needs its organization floor first (412).
 * `restartEmpty` drops every stamp and floor, as the new central starts (owner, 12 Nov).
 */
function createAdmittingCentral(): {
	readonly stamps: ReturnType<typeof createCentralStampModel>;
	readonly pushes: string[];
	readonly adminAnswers: string[];
	readonly restartEmpty: () => void;
	readonly floorsFor: (organizationId: string) => readonly string[];
	readonly nextAdmin: (...modes: LinkMode[]) => void;
	readonly nextPush: (...modes: LinkMode[]) => void;
	readonly digestMode: (mode: DigestMode, onHold?: () => void) => void;
	/** The next digest read is answered as central stands on arrival, but only once released. */
	readonly gateNextDigest: () => {
		readonly arrived: Promise<void>;
		readonly release: () => void;
	};
	/** Runs when an admin call in `hold` mode arrives. */
	readonly onAdminHold: (hook: () => void) => void;
	/** Runs as an admin call arrives, before central answers it. */
	readonly beforeAdmin: (hook: () => void) => void;
	/**
	 * The next provisioning send is recorded and then goes through the production link client
	 * over a transport that throws, as a closed link or a reply lost on the way does.
	 */
	readonly loseNextProvisioningOnTransport: () => void;
	/** The next provisioning send is received and recorded, runs `onArrival`, and is never answered. */
	readonly holdProvisioning: (onArrival: () => void) => void;
	readonly provisionOrganization: ReturnType<
		typeof createCentralStampModel
	>['client']['provisionOrganization'];
	readonly admin: (props: {
		readonly organizationId: string;
		readonly personId: string;
		readonly organizationRevision: number;
		readonly personRevision: number;
	}) => Promise<FleetAdminAnswer>;
	readonly push: (push: AuthorizationRevisionPush) => Promise<AuthorizationRevisionPushAnswer>;
	readonly readStatementDigest: ReturnType<
		typeof createCentralStampModel
	>['client']['readStatementDigest'];
} {
	const stamps = createCentralStampModel();
	const organizationFloors = new Map<string, number>();
	const personFloors = new Map<string, number>();
	const pushes: string[] = [];
	const adminAnswers: string[] = [];
	const adminModes: LinkMode[] = [];
	const pushModes: LinkMode[] = [];
	let digest: { readonly mode: DigestMode; readonly onHold?: () => void } = { mode: 'answer' };
	let adminHook: (() => void) | null = null;
	let adminHoldHook: (() => void) | null = null;
	let digestGate: {
		readonly arrived: () => void;
		readonly released: Promise<void>;
	} | null = null;
	let provisionHold: (() => void) | null = null;
	let loseOnTransport = false;
	const unstamped = (organizationId: string): boolean => stamps.stored(organizationId) === null;
	return {
		stamps,
		pushes,
		adminAnswers,
		restartEmpty: () => {
			stamps.restartEmpty();
			organizationFloors.clear();
			personFloors.clear();
		},
		floorsFor: (organizationId) => [
			...[...organizationFloors]
				.filter(([id]) => id === organizationId)
				.map(([, revision]) => `organization:${revision}`),
			...[...personFloors]
				.filter(([key]) => key.startsWith(`${organizationId}:`))
				.map(([, revision]) => `person:${revision}`),
		],
		nextAdmin: (...modes) => adminModes.push(...modes),
		nextPush: (...modes) => pushModes.push(...modes),
		digestMode: (mode, onHold) => {
			digest = onHold === undefined ? { mode } : { mode, onHold };
		},
		gateNextDigest: () => {
			const arrival = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			digestGate = { arrived: arrival.resolve, released: release.promise };
			return { arrived: arrival.promise, release: release.resolve };
		},
		onAdminHold: (hook) => {
			adminHoldHook = hook;
		},
		beforeAdmin: (hook) => {
			adminHook = hook;
		},
		loseNextProvisioningOnTransport: () => {
			loseOnTransport = true;
		},
		holdProvisioning: (onArrival) => {
			provisionHold = onArrival;
		},
		async provisionOrganization(input) {
			if (loseOnTransport) {
				loseOnTransport = false;
				stamps.recordHeldSend(input.organizationId, input.organizationStatement);
				return createCentralLinkClient({
					fetch: async () => {
						throw new Error('Link closed before central answered');
					},
				}).provisionOrganization(input);
			}
			const onArrival = provisionHold;
			if (onArrival === null) return stamps.client.provisionOrganization(input);
			provisionHold = null;
			stamps.recordHeldSend(input.organizationId, input.organizationStatement);
			onArrival();
			return new Promise<never>((): void => undefined);
		},
		async admin(props) {
			adminHook?.();
			const mode = adminModes.shift() ?? 'decide';
			if (mode === 'hold') {
				adminAnswers.push('held');
				adminHoldHook?.();
				return new Promise<never>((): void => undefined);
			}
			const answer: FleetAdminAnswer =
				mode === 'transport-failure'
					? { kind: 'unknown', reason: 'unavailable' }
					: mode === 'answer-503' || unstamped(props.organizationId)
						? { kind: 'answered-unavailable' }
						: organizationFloors.get(props.organizationId) === props.organizationRevision &&
							  personFloors.get(`${props.organizationId}:${props.personId}`) ===
									props.personRevision
							? { kind: 'answered', result: { result: 'records', records: [] } }
							: {
									kind: 'answered',
									result: { result: 'refused', reason: 'authorizationSyncRequired' },
								};
			adminAnswers.push(
				answer.kind === 'answered'
					? answer.result.result === 'refused'
						? `refused:${answer.result.reason}`
						: answer.result.result
					: answer.kind,
			);
			return answer;
		},
		async push(push) {
			pushes.push(`${push.kind}:${push.revision}`);
			const mode = pushModes.shift() ?? 'decide';
			if (mode === 'transport-failure') return { kind: 'unknown', reason: 'unavailable' };
			if (mode === 'answer-503' || unstamped(push.organizationId))
				return { kind: 'answered-unavailable' };
			if (push.kind === 'organization') {
				organizationFloors.set(push.organizationId, push.revision);
				return { kind: 'acknowledged', acknowledgedRevision: push.revision };
			}
			if (!organizationFloors.has(push.organizationId))
				return { kind: 'refused', reason: 'organization-floor-missing' };
			personFloors.set(`${push.organizationId}:${push.personId}`, push.revision);
			return { kind: 'acknowledged', acknowledgedRevision: push.revision };
		},
		async readStatementDigest(organizationId, options) {
			if (digest.mode === 'unavailable') return { kind: 'unavailable', reason: 'unavailable' };
			if (digest.mode === 'hold') {
				digest.onHold?.();
				return new Promise<never>((): void => undefined);
			}
			const gate = digestGate;
			if (gate === null) return stamps.client.readStatementDigest(organizationId, options);
			digestGate = null;
			const answer = await stamps.client.readStatementDigest(organizationId, options);
			gate.arrived();
			await gate.released;
			return answer;
		},
	};
}

interface ForgotSetup {
	readonly organizationId: OrganizationId;
	readonly personId: string;
	readonly central: ReturnType<typeof createAdmittingCentral>;
	readonly starts: readonly number[];
	readonly fire: () => void;
	readonly run: () => Promise<{ readonly outcome: string; readonly answer: string | null }>;
}

/**
 * A ready organization in steady state: sign-in signed its setup statement with its native key,
 * central stored it, and central's floors match sign-in's ACKed fence (organization revision 2,
 * one person pair at revision 3). Not due: the stamp has its full lifetime left.
 */
async function steadyOrganization(
	context: StorageCaseContext,
	options: { readonly due?: boolean } = {},
): Promise<ForgotSetup> {
	await resetStorageCase(context);
	const organizationId = organizationIdSchema.parse(context.platform.ids.nextId());
	const personId = context.platform.ids.nextId();
	const now = context.platform.clock.now();
	await context
		.openDatabase()
		.insert(organization)
		.values({
			id: organizationId,
			name: 'Central forgot',
			slug: `central-forgot-${organizationId}`,
			createdAt: new Date(now),
			fleetState: 'ready',
		});
	const central = createAdmittingCentral();
	const manual = createManualDeadlines();
	const base = storageProviderProperties(context, organizationId);
	const configuration: SignInHttpConfiguration = {
		...base,
		platform: {
			...base.platform,
			deadlines: manual.deadlines,
			centralClient: {
				...createCentralLinkClient({ fetch: async () => new Response(null, { status: 503 }) }),
				provisionOrganization: central.provisionOrganization,
				readStatementDigest: central.readStatementDigest,
				pushAuthorizationRevision: central.push,
			},
		},
	};
	const { statement } = await createSignInProvider({
		...configuration,
		authority: { kind: 'public' },
		requestState: createProviderRequestState(),
	}).api.signOrganizationStatement({ body: { organizationId } });
	await central.stamps.hold(organizationId, statement);
	const facts = await readOrganizationStatementFacts(context.platform.crypto, statement);
	await context.store.organizationStamps.seedConfirmedStamp({
		organizationId,
		// `due`: the same stamp recorded 59 days from expiry, inside the renewal window.
		stamp:
			options.due === true ? { ...facts, expiresAt: Math.floor(now / 1000) + 59 * 86_400 } : facts,
	});
	const fence = { createdAt: now, updatedAt: now, nextAttemptAt: now };
	await context
		.openDatabase()
		.insert(organizationFence)
		.values({
			id: organizationId,
			revision: 2,
			state: 'active',
			permissionPolicyDigest: 'a'.repeat(64),
			acknowledgedRevision: 2,
			...fence,
		});
	await context
		.openDatabase()
		.insert(personFence)
		.values({
			id: context.platform.ids.nextId(),
			organizationId,
			personId,
			revision: 3,
			state: 'active',
			acknowledgedRevision: 3,
			...fence,
		});
	await central.push({
		kind: 'organization',
		organizationId,
		revision: 2,
		state: 'active',
		permissionPolicyDigest: 'a'.repeat(64),
	});
	await central.push({
		kind: 'person',
		organizationId,
		personId,
		subjectId: context.platform.ids.nextId(),
		revision: 3,
		state: 'active',
	});
	central.pushes.length = 0;
	const runner = createOrganizationFleetCallRunner(configuration);
	return {
		organizationId,
		personId,
		central,
		starts: manual.starts,
		fire: manual.fire,
		async run() {
			const outcome = await runner<FleetAdminAnswer>({
				organizationId,
				send: async () =>
					central.admin({
						organizationId,
						personId,
						organizationRevision: 2,
						personRevision: await currentPersonRevision(context, personId),
					}),
				answeredUnavailable: (answer) => answer.kind === 'answered-unavailable',
				atDeadline: { kind: 'unknown', reason: 'timeout' },
			});
			return {
				outcome:
					outcome.recovery.kind === 'attempted'
						? `${outcome.kind}:${outcome.recovery.trigger}:${outcome.recovery.result.kind}`
						: `${outcome.kind}:no-recovery`,
				// What the caller received, not the peer's ledger (the Verifier, 13 Nov).
				answer: outcome.kind === 'sent' ? describeAnswer(outcome.answer) : null,
			};
		},
	};
}

function describeAnswer(answer: FleetAdminAnswer): string {
	if (answer.kind === 'answered')
		return answer.result.result === 'refused'
			? `refused:${answer.result.reason}`
			: answer.result.result;
	return answer.kind === 'unknown' ? `unknown:${answer.reason}` : answer.kind;
}

async function currentPersonRevision(
	context: StorageCaseContext,
	personId: string,
): Promise<number> {
	const row = (
		await context
			.openDatabase()
			.select({ revision: personFence.revision })
			.from(personFence)
			.where(eq(personFence.personId, personId))
	)[0];
	if (row === undefined) throw new Error('Person pair missing');
	return row.revision;
}

/** The record, the fence ACKs, central's floors and what central received. */
async function observed(context: StorageCaseContext, setup: ForgotSetup): Promise<unknown> {
	const record = await context.store.organizationStamps.readStampRecord(setup.organizationId);
	if (record.kind !== 'available' || record.value === null) throw new Error('Record missing');
	const organizationAck = (
		await context
			.openDatabase()
			.select({ acknowledged: organizationFence.acknowledgedRevision })
			.from(organizationFence)
			.where(eq(organizationFence.id, setup.organizationId))
	).map((row) => row.acknowledged);
	const pairAcks = (
		await context
			.openDatabase()
			.select({ acknowledged: personFence.acknowledgedRevision })
			.from(personFence)
			.where(eq(personFence.organizationId, setup.organizationId))
	).map((row) => row.acknowledged);
	const stored = setup.central.stamps.stored(setup.organizationId);
	return {
		adminAnswers: [...setup.central.adminAnswers],
		pushes: [...setup.central.pushes],
		sends: setup.central.stamps.sends.map((send) =>
			typeof decodeJwt(send.statement)['replaces'] === 'string' ? 'renewal' : 'setup',
		),
		digestReads: setup.central.stamps.digestReads(),
		floors: setup.central.floorsFor(setup.organizationId),
		acks: { organization: organizationAck, pairs: pairAcks },
		recordNamesCentral: stored !== null && record.value.confirmed?.digest === stored.digest,
		record: {
			confirmed: record.value.confirmed !== null,
			sent: record.value.sent !== null,
			unanswered: record.value.unansweredTries,
			refused: record.value.refusedTries,
			lastTryOutcome: record.value.lastTry?.outcome ?? null,
		},
		budgets: [...setup.starts],
	};
}

async function notDueRecoversOnFirstUse(context: StorageCaseContext): Promise<unknown> {
	const setup = await steadyOrganization(context);
	setup.central.restartEmpty();
	const result = await setup.run();
	return { result, ...((await observed(context, setup)) as object) };
}

async function pushAnsweredUnavailable(context: StorageCaseContext): Promise<unknown> {
	// A person change after central restarted empty: its pair is pending at revision 4.
	const recovers = await steadyOrganization(context);
	await context
		.openDatabase()
		.update(personFence)
		.set({ revision: 4, state: 'active' })
		.where(eq(personFence.personId, recovers.personId));
	recovers.central.restartEmpty();
	const recovered = await recovers.run();
	const recoveredObserved = await observed(context, recovers);
	// The same 503 from a central that still holds the stamp: nothing is reset or sent.
	const busy = await steadyOrganization(context);
	await context
		.openDatabase()
		.update(personFence)
		.set({ revision: 4, state: 'active' })
		.where(eq(personFence.personId, busy.personId));
	busy.central.nextPush('answer-503');
	const held = await busy.run();
	return {
		recovered: { result: recovered, ...(recoveredObserved as object) },
		busyCentral: { result: held, ...((await observed(context, busy)) as object) },
	};
}

async function otherProbeOutcomesStandUnchanged(context: StorageCaseContext): Promise<unknown> {
	const results: Record<string, unknown> = {};
	// A busy central that still holds the stamp: the probe answers `current`.
	const busy = await steadyOrganization(context);
	busy.central.nextAdmin('answer-503');
	results['probeCurrent'] = {
		result: await busy.run(),
		...((await observed(context, busy)) as object),
	};
	// An emptied central whose digest read fails, or never answers before the deadline.
	const failing = await steadyOrganization(context);
	failing.central.restartEmpty();
	failing.central.digestMode('unavailable');
	results['probeUnavailable'] = {
		result: await failing.run(),
		...((await observed(context, failing)) as object),
	};
	const slow = await steadyOrganization(context);
	slow.central.restartEmpty();
	slow.central.digestMode('hold', slow.fire);
	results['probeTimeout'] = {
		result: await slow.run(),
		...((await observed(context, slow)) as object),
	};
	// A transport failure is not central's 503: nothing is probed.
	const broken = await steadyOrganization(context);
	broken.central.restartEmpty();
	broken.central.nextAdmin('transport-failure');
	results['transportFailure'] = {
		result: await broken.run(),
		...((await observed(context, broken)) as object),
	};
	return results;
}

async function budgetAndRetryBounds(context: StorageCaseContext): Promise<unknown> {
	// Each setup resets storage, so each run is observed before the next one is arranged.
	const observe = async (setup: ForgotSetup): Promise<unknown> => ({
		result: await setup.run(),
		...((await observed(context, setup)) as object),
	});
	// D7 positive control: renewal spends the budget over a valid stamp; the first call still goes.
	const renewing = await steadyOrganization(context, { due: true });
	renewing.central.holdProvisioning(renewing.fire);
	const renewalSpendsBudget = await observe(renewing);
	// The first call spends the budget before central's 503 comes back: no probe, no retry.
	const spent = await steadyOrganization(context);
	spent.central.restartEmpty();
	spent.central.beforeAdmin(spent.fire);
	const budgetSpentByFirstCall = await observe(spent);
	// A retry answered 503 again is returned as it is: two dispatches, never a third.
	const twice = await steadyOrganization(context);
	twice.central.restartEmpty();
	twice.central.nextAdmin('decide', 'answer-503');
	const retryAnswered503 = await observe(twice);
	// The retry is held past the run's one deadline (ignoring its abort): the caller still gets
	// the deadline's answer, after two sends and never a third (the Verifier, 13 Nov).
	const heldRetry = await steadyOrganization(context);
	heldRetry.central.restartEmpty();
	heldRetry.central.nextAdmin('decide', 'hold');
	heldRetry.central.onAdminHold(heldRetry.fire);
	const retryHeldPastDeadline = await observe(heldRetry);
	// A recovery setup whose reply is lost: one unanswered try, the record left empty.
	const lost = await steadyOrganization(context);
	lost.central.restartEmpty();
	lost.central.stamps.nextBehaviours('lose-before-apply');
	const recoverySetupLost = await observe(lost);
	// Lead clarification (13 Nov): a transport loss keeps its own reason, through the real client.
	const dropped = await steadyOrganization(context);
	dropped.central.restartEmpty();
	dropped.central.loseNextProvisioningOnTransport();
	const recoverySetupTransportLost = await observe(dropped);
	// A recovery setup applied at central but its reply lost: the readback is not reached.
	const applied = await steadyOrganization(context);
	applied.central.restartEmpty();
	applied.central.stamps.nextBehaviours('lose-after-apply');
	const appliedFirstUse = await observe(applied);
	// R-floors timing (Lead, 13 Nov): the next use seeds the stamp central now holds, delivers
	// the ACKs forgotten on `none`, and the call succeeds.
	const appliedNextUse = await observe(applied);
	const recoverySetupAppliedReplyLost = { firstUse: appliedFirstUse, nextUse: appliedNextUse };
	return {
		renewalSpendsBudget,
		budgetSpentByFirstCall,
		retryAnswered503,
		retryHeldPastDeadline,
		recoverySetupLost,
		recoverySetupTransportLost,
		recoverySetupAppliedReplyLost,
	};
}

/**
 * The Verifier's interleaving (13 Nov): central's `none` is held while another sign-in writer
 * confirms a newer stamp, or claims newer bytes, then released. The stale `none` must not clear
 * what that writer wrote, nor forget the organization's ACKs.
 */
async function staleNoneLosesToAnotherWriter(context: StorageCaseContext): Promise<unknown> {
	const results: Record<string, unknown> = {};
	for (const writer of ['confirms-newer-stamp', 'claims-newer-bytes'] as const) {
		// oxlint-disable-next-line no-await-in-loop -- each interleaving resets storage first.
		const setup = await steadyOrganization(context);
		setup.central.restartEmpty();
		const gate = setup.central.gateNextDigest();
		const running = setup.run();
		// oxlint-disable-next-line no-await-in-loop -- the other writer acts while `none` is held.
		await gate.arrived;
		// oxlint-disable-next-line no-await-in-loop -- one write, through the real store.
		const before = await context.store.organizationStamps.readStampRecord(setup.organizationId);
		if (before.kind !== 'available' || before.value?.confirmed == null)
			throw new Error('Steady record missing');
		const newer = {
			digest: 'e'.repeat(64),
			expiresAt: before.value.confirmed.expiresAt + 86_400,
			signingKeyId: before.value.confirmed.signingKeyId,
		};
		if (writer === 'confirms-newer-stamp') {
			// oxlint-disable-next-line no-await-in-loop -- another writer's two conditional writes.
			await context.store.organizationStamps.forgetConfirmedStamp({
				organizationId: setup.organizationId,
				digest: before.value.confirmed.digest,
			});
			// oxlint-disable-next-line no-await-in-loop -- the second of them.
			await context.store.organizationStamps.seedConfirmedStamp({
				organizationId: setup.organizationId,
				stamp: newer,
			});
		} else {
			// oxlint-disable-next-line no-await-in-loop -- another writer's claim of newer bytes.
			await context.store.organizationStamps.claimSentStamp({
				organizationId: setup.organizationId,
				statement: 'newer.pending.bytes',
			});
		}
		gate.release();
		// oxlint-disable-next-line no-await-in-loop -- the stale run finishes after the write.
		const result = await running;
		// oxlint-disable-next-line no-await-in-loop -- read back what survived.
		const after = await context.store.organizationStamps.readStampRecord(setup.organizationId);
		if (after.kind !== 'available' || after.value === null) throw new Error('Record missing');
		results[writer] = {
			result,
			survivor: {
				digest: after.value.confirmed?.digest === newer.digest ? 'newer' : 'other',
				sent: after.value.sent,
			},
			// oxlint-disable-next-line no-await-in-loop -- the rest of the observation.
			...((await observed(context, setup)) as object),
		};
	}
	return results;
}

/** WS7 R-notdue, R-floors and R-push503 (Lead, 13 Nov), through the production run seam. */
export const organizationCentralForgotCases: readonly StorageCaseDefinition[] = [
	{
		name: 'central forgot: a ready organization that is not due recovers on its first Fleet call after central restarts empty, pushes its revisions again and the retried admin call succeeds',
		expected: {
			result: { outcome: 'sent:call:recovered', answer: 'records' },
			adminAnswers: ['answered-unavailable', 'records'],
			pushes: ['organization:2', 'person:3'],
			sends: ['setup'],
			digestReads: 2,
			floors: ['organization:2', 'person:3'],
			acks: { organization: [2], pairs: [3] },
			recordNamesCentral: true,
			record: { confirmed: true, sent: false, unanswered: 0, refused: 0, lastTryOutcome: null },
			budgets: [5_000],
		},
		run: notDueRecoversOnFirstUse,
	},
	{
		name: 'central forgot: a revision push answered 503 by an emptied central recovers and then sends the call; the same 503 from a central that holds the stamp keeps the call back unchanged',
		expected: {
			recovered: {
				result: { outcome: 'sent:push:recovered', answer: 'records' },
				adminAnswers: ['records'],
				pushes: ['person:4', 'organization:2', 'person:4'],
				sends: ['setup'],
				digestReads: 2,
				floors: ['organization:2', 'person:4'],
				acks: { organization: [2], pairs: [4] },
				recordNamesCentral: true,
				record: { confirmed: true, sent: false, unanswered: 0, refused: 0, lastTryOutcome: null },
				budgets: [5_000],
			},
			busyCentral: {
				result: { outcome: 'held:push:not-forgotten', answer: null },
				adminAnswers: [],
				pushes: ['person:4'],
				sends: [],
				digestReads: 1,
				floors: ['organization:2', 'person:3'],
				acks: { organization: [2], pairs: [3] },
				recordNamesCentral: true,
				record: { confirmed: true, sent: false, unanswered: 0, refused: 0, lastTryOutcome: null },
				budgets: [5_000],
			},
		},
		run: pushAnsweredUnavailable,
	},
	{
		name: 'central forgot: after a 503, a probe that answers current, fails or times out returns the original answer unchanged, and a transport failure is never probed',
		expected: {
			probeCurrent: {
				result: { outcome: 'sent:call:not-forgotten', answer: 'answered-unavailable' },
				adminAnswers: ['answered-unavailable'],
				pushes: [],
				sends: [],
				digestReads: 1,
				floors: ['organization:2', 'person:3'],
				acks: { organization: [2], pairs: [3] },
				recordNamesCentral: true,
				record: { confirmed: true, sent: false, unanswered: 0, refused: 0, lastTryOutcome: null },
				budgets: [5_000],
			},
			probeUnavailable: {
				result: { outcome: 'sent:call:not-forgotten', answer: 'answered-unavailable' },
				adminAnswers: ['answered-unavailable'],
				pushes: [],
				sends: [],
				digestReads: 0,
				floors: [],
				acks: { organization: [2], pairs: [3] },
				recordNamesCentral: false,
				record: { confirmed: true, sent: false, unanswered: 0, refused: 0, lastTryOutcome: null },
				budgets: [5_000],
			},
			probeTimeout: {
				result: { outcome: 'sent:call:not-forgotten', answer: 'answered-unavailable' },
				adminAnswers: ['answered-unavailable'],
				pushes: [],
				sends: [],
				digestReads: 0,
				floors: [],
				acks: { organization: [2], pairs: [3] },
				recordNamesCentral: false,
				record: { confirmed: true, sent: false, unanswered: 0, refused: 0, lastTryOutcome: null },
				budgets: [5_000],
			},
			transportFailure: {
				result: { outcome: 'sent:no-recovery', answer: 'unknown:unavailable' },
				adminAnswers: ['unknown'],
				pushes: [],
				sends: [],
				digestReads: 0,
				floors: [],
				acks: { organization: [2], pairs: [3] },
				recordNamesCentral: false,
				record: { confirmed: true, sent: false, unanswered: 0, refused: 0, lastTryOutcome: null },
				budgets: [5_000],
			},
		},
		run: otherProbeOutcomesStandUnchanged,
	},
	{
		name: 'central forgot: the run budget lets the first call out even when spent, never starts a probe once spent, retries once at most, and counts a recovery setup that did not land',
		expected: {
			renewalSpendsBudget: {
				result: { outcome: 'sent:no-recovery', answer: 'records' },
				adminAnswers: ['records'],
				pushes: [],
				sends: ['renewal'],
				digestReads: 0,
				floors: ['organization:2', 'person:3'],
				acks: { organization: [2], pairs: [3] },
				recordNamesCentral: true,
				record: {
					confirmed: true,
					sent: true,
					unanswered: 1,
					refused: 0,
					lastTryOutcome: 'unanswered-timeout',
				},
				budgets: [5_000],
			},
			budgetSpentByFirstCall: {
				result: { outcome: 'sent:call:budget-spent', answer: 'answered-unavailable' },
				adminAnswers: ['answered-unavailable'],
				pushes: [],
				sends: [],
				digestReads: 0,
				floors: [],
				acks: { organization: [2], pairs: [3] },
				recordNamesCentral: false,
				record: { confirmed: true, sent: false, unanswered: 0, refused: 0, lastTryOutcome: null },
				budgets: [5_000],
			},
			retryAnswered503: {
				result: { outcome: 'sent:call:recovered', answer: 'answered-unavailable' },
				adminAnswers: ['answered-unavailable', 'answered-unavailable'],
				pushes: ['organization:2', 'person:3'],
				sends: ['setup'],
				digestReads: 2,
				floors: ['organization:2', 'person:3'],
				acks: { organization: [2], pairs: [3] },
				recordNamesCentral: true,
				record: { confirmed: true, sent: false, unanswered: 0, refused: 0, lastTryOutcome: null },
				budgets: [5_000],
			},
			retryHeldPastDeadline: {
				result: { outcome: 'sent:call:recovered', answer: 'unknown:timeout' },
				adminAnswers: ['answered-unavailable', 'held'],
				pushes: ['organization:2', 'person:3'],
				sends: ['setup'],
				digestReads: 2,
				floors: ['organization:2', 'person:3'],
				acks: { organization: [2], pairs: [3] },
				recordNamesCentral: true,
				record: { confirmed: true, sent: false, unanswered: 0, refused: 0, lastTryOutcome: null },
				budgets: [5_000],
			},
			recoverySetupLost: {
				result: { outcome: 'sent:call:not-recovered', answer: 'answered-unavailable' },
				adminAnswers: ['answered-unavailable'],
				pushes: [],
				sends: ['setup'],
				digestReads: 1,
				floors: [],
				acks: { organization: [0], pairs: [0] },
				recordNamesCentral: false,
				record: {
					confirmed: false,
					sent: false,
					unanswered: 1,
					refused: 0,
					lastTryOutcome: 'unanswered-timeout',
				},
				budgets: [5_000],
			},
			recoverySetupTransportLost: {
				result: { outcome: 'sent:call:not-recovered', answer: 'answered-unavailable' },
				adminAnswers: ['answered-unavailable'],
				pushes: [],
				sends: ['setup'],
				digestReads: 1,
				floors: [],
				acks: { organization: [0], pairs: [0] },
				recordNamesCentral: false,
				record: {
					confirmed: false,
					sent: false,
					unanswered: 1,
					refused: 0,
					lastTryOutcome: 'unanswered-unavailable',
				},
				budgets: [5_000],
			},
			recoverySetupAppliedReplyLost: {
				firstUse: {
					result: { outcome: 'sent:call:not-recovered', answer: 'answered-unavailable' },
					adminAnswers: ['answered-unavailable'],
					pushes: [],
					sends: ['setup'],
					digestReads: 1,
					floors: [],
					acks: { organization: [0], pairs: [0] },
					recordNamesCentral: false,
					record: {
						confirmed: false,
						sent: false,
						unanswered: 1,
						refused: 0,
						lastTryOutcome: 'unanswered-timeout',
					},
					budgets: [5_000],
				},
				nextUse: {
					result: { outcome: 'sent:no-recovery', answer: 'records' },
					adminAnswers: ['answered-unavailable', 'records'],
					pushes: ['organization:2', 'person:3'],
					sends: ['setup'],
					digestReads: 2,
					floors: ['organization:2', 'person:3'],
					acks: { organization: [2], pairs: [3] },
					recordNamesCentral: true,
					record: {
						confirmed: true,
						sent: false,
						unanswered: 1,
						refused: 0,
						lastTryOutcome: 'unanswered-timeout',
					},
					budgets: [5_000, 5_000],
				},
			},
		},
		run: budgetAndRetryBounds,
	},
	{
		name: 'central forgot: a stale none, released after another writer confirms a newer stamp or claims newer bytes, clears neither and forgets no ACKs',
		expected: {
			'confirms-newer-stamp': {
				result: { outcome: 'sent:call:contended', answer: 'answered-unavailable' },
				survivor: { digest: 'newer', sent: null },
				adminAnswers: ['answered-unavailable'],
				pushes: [],
				sends: [],
				digestReads: 1,
				floors: [],
				acks: { organization: [2], pairs: [3] },
				recordNamesCentral: false,
				record: { confirmed: true, sent: false, unanswered: 0, refused: 0, lastTryOutcome: null },
				budgets: [5_000],
			},
			'claims-newer-bytes': {
				result: { outcome: 'sent:call:contended', answer: 'answered-unavailable' },
				survivor: { digest: 'other', sent: 'newer.pending.bytes' },
				adminAnswers: ['answered-unavailable'],
				pushes: [],
				sends: [],
				digestReads: 1,
				floors: [],
				acks: { organization: [2], pairs: [3] },
				recordNamesCentral: false,
				record: { confirmed: true, sent: true, unanswered: 0, refused: 0, lastTryOutcome: null },
				budgets: [5_000],
			},
		},
		run: staleNoneLosesToAnotherWriter,
	},
];
