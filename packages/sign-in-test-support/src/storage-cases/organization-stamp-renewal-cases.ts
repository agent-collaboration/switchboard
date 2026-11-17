import {
	createSignInStore,
	organization,
	organizationIdSchema,
	renewOrganizationStampForUse,
	readOrganizationStatementFacts,
	reSignOrganizationsForKeyChange,
	type OrganizationId,
	type OrganizationStampRecords,
	type OrganizationStampRenewalProps,
} from '@agent-collaboration/sign-in-core';
import { eq } from 'drizzle-orm';

import {
	createCentralStampModel,
	createStatementSigner,
	type CentralStampModel,
} from '#sign-in-test-support/storage-cases/organization-stamp-central-model';
import {
	storageCaseOwnerEmail,
	type StorageCaseContext,
} from '#sign-in-test-support/storage-cases/storage-case-context';
import type { StorageCaseDefinition } from '#sign-in-test-support/storage-cases/storage-case-registry';
import { unreachedDeadline } from '#sign-in-test-support/test-fixtures/manual-deadlines';

const day = 86_400_000;
const lifetimeSeconds = 10_368_000;
const currentKey = 'current-native-key';
const retiredKey = 'retired-native-key';

/** A second sign-in instance: its own store over the same real database. */
function otherInstanceStamps(context: StorageCaseContext): OrganizationStampRecords {
	return createSignInStore({
		openDatabase: context.openDatabase,
		platform: context.platform,
		ownerEmail: storageCaseOwnerEmail,
	}).organizationStamps;
}

async function readyOrganization(context: StorageCaseContext): Promise<OrganizationId> {
	const id = organizationIdSchema.parse(context.platform.ids.nextId());
	// Only the B2 columns are written: the stamp record keeps its migrated defaults.
	await context
		.openDatabase()
		.insert(organization)
		.values({
			id,
			name: `Stamp ${id}`,
			slug: `stamp-${id}`,
			createdAt: new Date(context.platform.clock.now()),
			fleetState: 'ready',
		});
	return id;
}

interface StoredStampRow {
	readonly digest: string | null;
	readonly expiresAt: number | null;
	readonly signingKeyId: string | null;
	readonly sent: string | null;
	readonly unanswered: number;
	readonly refused: number;
	readonly lastTryOutcome: string | null;
}

async function storedRecord(
	context: StorageCaseContext,
	organizationId: OrganizationId,
): Promise<StoredStampRow | null> {
	const row = (
		await context
			.openDatabase()
			.select({
				digest: organization.fleetStampDigest,
				expiresAt: organization.fleetStampExpiresAt,
				signingKeyId: organization.fleetStampSigningKeyId,
				sent: organization.fleetStampSent,
				unanswered: organization.fleetStampUnansweredTries,
				refused: organization.fleetStampRefusedTries,
				lastTryOutcome: organization.fleetStampLastTryOutcome,
			})
			.from(organization)
			.where(eq(organization.id, organizationId))
	)[0];
	return row ?? null;
}

interface StampSetup {
	readonly central: CentralStampModel;
	readonly sign: ReturnType<typeof createStatementSigner>;
	readonly guard: (
		organizationId: OrganizationId,
		stamps?: OrganizationStampRecords,
	) => Promise<{ readonly readiness: string; readonly renewal: string }>;
	readonly props: Omit<OrganizationStampRenewalProps, 'organizationId'>;
}

function stampSetup(
	context: StorageCaseContext,
	signingKeyId: () => string = (): string => currentKey,
): StampSetup {
	const central = createCentralStampModel();
	const sign = createStatementSigner({ now: () => context.platform.clock.now(), signingKeyId });
	const props: Omit<OrganizationStampRenewalProps, 'organizationId'> = {
		stamps: context.store.organizationStamps,
		revisions: context.store.revisionDelivery,
		centralClient: central.client,
		sign,
		clock: context.platform.clock,
		crypto: context.platform.crypto,
		currentSigningKeyId: currentKey,
		deadline: unreachedDeadline(),
	};
	return {
		central,
		sign,
		props,
		async guard(organizationId, stamps = context.store.organizationStamps) {
			const readiness = await renewOrganizationStampForUse({ ...props, stamps, organizationId });
			return { readiness: readiness.kind, renewal: readiness.renewal.kind };
		},
	};
}

/** Central holds a stamp signed at `signedAt`; the record is seeded from it on first use. */
async function heldStamp(
	context: StorageCaseContext,
	setup: StampSetup,
	organizationId: OrganizationId,
	signedAt: number,
): Promise<string> {
	const now = context.platform.clock.now();
	context.setTime(signedAt);
	const statement = await setup.sign({ organizationId });
	context.setTime(now);
	await setup.central.hold(organizationId, statement);
	return statement;
}

async function windowBoundary(context: StorageCaseContext): Promise<unknown> {
	const start = context.platform.clock.now();
	const outcomes: unknown[] = [];
	for (const extraSeconds of [0, 1]) {
		context.setTime(start);
		const setup = stampSetup(context);
		// oxlint-disable-next-line no-await-in-loop -- each boundary needs its own organization.
		const organizationId = await readyOrganization(context);
		// oxlint-disable-next-line no-await-in-loop -- central must hold the stamp first.
		await heldStamp(context, setup, organizationId, start);
		context.setTime(start + (lifetimeSeconds - 60 * 86_400 - extraSeconds) * 1000);
		// oxlint-disable-next-line no-await-in-loop -- one guarded call per boundary.
		const result = await setup.guard(organizationId);
		outcomes.push({ ...result, sends: setup.central.sends.length });
	}
	context.setTime(start);
	return outcomes;
}

async function lostReply(
	context: StorageCaseContext,
	behaviour: 'lose-after-apply' | 'lose-before-apply',
): Promise<unknown> {
	const start = context.platform.clock.now();
	const setup = stampSetup(context);
	const organizationId = await readyOrganization(context);
	await heldStamp(context, setup, organizationId, start);
	context.setTime(start + 61 * day);
	setup.central.nextBehaviours(behaviour);
	const first = await setup.guard(organizationId);
	const inDoubt = await storedRecord(context, organizationId);
	// The next use comes from another instance's store over the same database; the real
	// restart case in sign-in-storage.host.e2e.test.ts closes and reopens it.
	context.setTime(start + 61 * day + 60_000);
	const second = await setup.guard(organizationId, otherInstanceStamps(context));
	const sends = setup.central.sends.map((send) => send.statement);
	const confirmed = await readOrganizationStatementFacts(context.platform.crypto, sends[0] ?? '');
	const record = await storedRecord(context, organizationId);
	const result = {
		first,
		second,
		sendCount: sends.length,
		byteIdenticalResend: sends[1] === sends[0],
		signatures: setup.sign.signatures(),
		appliedSwaps: setup.central.appliedSwaps(),
		inDoubtHeldTheSentBytes: sentOf(inDoubt) === sends[0],
		counters: pick(record),
		recordIsCentralsStamp:
			JSON.stringify(record) ===
				JSON.stringify({
					...confirmed,
					sent: null,
					unanswered: 1,
					refused: 0,
					lastTryOutcome: 'unanswered-timeout',
				}) && JSON.stringify(setup.central.stored(organizationId)) === JSON.stringify(confirmed),
	};
	context.setTime(start);
	return result;
}

async function twoInstances(context: StorageCaseContext): Promise<unknown> {
	const start = context.platform.clock.now();
	const central = createCentralStampModel();
	const { promise: bothSigned, resolve: releaseSigners } = Promise.withResolvers<void>();
	const base = createStatementSigner({
		now: () => context.platform.clock.now(),
		signingKeyId: () => currentKey,
	});
	let signers = 0;
	// Both instances read an empty sent column and sign before either claims it.
	const sign: typeof base = Object.assign(
		async (request: Parameters<typeof base>[0]): Promise<string> => {
			const statement = await base(request);
			signers += 1;
			if (signers === 2) releaseSigners();
			await bothSigned;
			return statement;
		},
		{ signatures: base.signatures },
	);
	const organizationId = await readyOrganization(context);
	context.setTime(start);
	await central.hold(organizationId, await base({ organizationId }));
	context.setTime(start + 61 * day);
	const run = (stamps: OrganizationStampRecords): ReturnType<typeof renewOrganizationStampForUse> =>
		renewOrganizationStampForUse({
			organizationId,
			stamps,
			revisions: context.store.revisionDelivery,
			centralClient: central.client,
			sign,
			clock: context.platform.clock,
			crypto: context.platform.crypto,
			currentSigningKeyId: currentKey,
			deadline: unreachedDeadline(),
		});
	const answers = await Promise.all([
		run(context.store.organizationStamps),
		run(otherInstanceStamps(context)),
	]);
	const sends = central.sends.map((send) => send.statement);
	const record = await storedRecord(context, organizationId);
	context.setTime(start);
	return {
		readiness: answers.map((answer) => answer.kind),
		renewalSignatures: base.signatures() - 1,
		// The loser re-sends the winner's bytes, or finds them already confirmed and sends nothing.
		onlyTheClaimedStatementSent: sends.length >= 1 && new Set(sends).size === 1,
		appliedSwaps: central.appliedSwaps(),
		nothingInDoubt: pick(record),
	};
}

async function lateSettlementKeepsNewerSent(context: StorageCaseContext): Promise<unknown> {
	const setup = stampSetup(context);
	const organizationId = await readyOrganization(context);
	const stamps = context.store.organizationStamps;
	const older = await setup.sign({ organizationId });
	context.setTime(context.platform.clock.now() + 1_000);
	const newer = await setup.sign({ organizationId, replaces: 'a'.repeat(64) });
	const olderFacts = await readOrganizationStatementFacts(context.platform.crypto, older);
	const id = organizationId;
	const now = context.platform.clock.now();
	const claimedOlder = await stamps.claimSentStamp({ organizationId: id, statement: older });
	const secondClaimWhileHeld = await stamps.claimSentStamp({
		organizationId: id,
		statement: newer,
	});
	const confirmedOlder = await stamps.confirmSentStamp({
		organizationId: id,
		statement: older,
		stamp: olderFacts,
		now,
	});
	const claimedNewer = await stamps.claimSentStamp({ organizationId: id, statement: newer });
	// A late instance settles the older statement it sent: neither write may touch the newer one.
	const lateClear = await otherInstanceStamps(context).recordStampTry({
		organizationId: id,
		statement: older,
		outcome: 'refused-stale',
		settlement: { kind: 'clear-sent' },
		now,
	});
	const lateConfirm = await otherInstanceStamps(context).confirmSentStamp({
		organizationId: id,
		statement: older,
		stamp: olderFacts,
		now,
	});
	const record = await storedRecord(context, organizationId);
	return {
		claims: [claimedOlder, secondClaimWhileHeld, claimedNewer].map((claim) =>
			claim.kind === 'available' ? claim.value : claim.kind,
		),
		confirmedOlder: confirmedOlder.kind === 'available' && confirmedOlder.value,
		lateWrites: [lateClear, lateConfirm].map((write) =>
			write.kind === 'available' ? write.value : write.kind,
		),
		newerStillSent: sentOf(record) === newer,
	};
}

async function countersApart(context: StorageCaseContext): Promise<unknown> {
	const start = context.platform.clock.now();
	const setup = stampSetup(context);
	const organizationId = await readyOrganization(context);
	await heldStamp(context, setup, organizationId, start);
	context.setTime(start + 61 * day);
	setup.central.nextBehaviours('lose-before-apply', 'refuse-invalid-statement');
	const unanswered = await setup.guard(organizationId);
	const afterUnanswered = await storedRecord(context, organizationId);
	context.setTime(start + 61 * day + 60_000);
	const refused = await setup.guard(organizationId);
	const lastTryAt = (
		await context
			.openDatabase()
			.select({ at: organization.fleetStampLastTryAt })
			.from(organization)
			.where(eq(organization.id, organizationId))
	)[0]?.at;
	const result = {
		unanswered,
		refused,
		afterUnanswered: pick(afterUnanswered),
		afterRefused: pick(await storedRecord(context, organizationId)),
		lastTryAtIsTheRefusal: lastTryAt?.getTime() === start + 61 * day + 60_000,
		resentInDoubtBytes: setup.central.sends[1]?.statement === setup.central.sends[0]?.statement,
	};
	context.setTime(start);
	return result;
}

type StoredRecord = StoredStampRow | null;

function sentOf(record: StoredRecord): string | null | undefined {
	return record?.sent;
}

/** The record's counters and whether a stamp is in doubt, without its varying digest. */
function pick(record: StoredRecord): unknown {
	if (record === null) return null;
	return {
		unanswered: record.unanswered,
		refused: record.refused,
		lastTryOutcome: record.lastTryOutcome,
		inDoubt: record.sent !== null,
	};
}

async function callOverStamp(context: StorageCaseContext): Promise<unknown> {
	const start = context.platform.clock.now();
	const setup = stampSetup(context);
	const valid = await readyOrganization(context);
	const expired = await readyOrganization(context);
	await heldStamp(context, setup, valid, start);
	await heldStamp(context, setup, expired, start - (lifetimeSeconds * 1000 - 61 * day));
	context.setTime(start + 61 * day);
	setup.central.nextBehaviours('lose-before-apply', 'lose-before-apply');
	const validFailing = await setup.guard(valid);
	const expiredFailing = await setup.guard(expired);
	context.setTime(start + 61 * day + 60_000);
	const expiredLanding = await setup.guard(expired);
	context.setTime(start);
	return { validFailing, expiredFailing, expiredLanding };
}

/**
 * Rule 3 with owner R29 (14 Nov): sign-in's confirmed stamp has drifted from central's, and
 * both have expired. The first guarded call's Replace is stale; central's digest read answers
 * its stored, expired facts, which sign-in adopts. The next call is then due against central's
 * digest, so its Replace applies and the call goes out.
 */
async function driftedExpiredRecovers(context: StorageCaseContext): Promise<unknown> {
	const start = context.platform.clock.now();
	const setup = stampSetup(context);
	const organizationId = await readyOrganization(context);
	await heldStamp(context, setup, organizationId, start);
	const seeded = await setup.guard(organizationId);
	// Drift: central now holds another statement sign-in never confirmed.
	const drifted = await heldStamp(context, setup, organizationId, start + 1_000);
	const driftedDigest = (await readOrganizationStatementFacts(context.platform.crypto, drifted))
		.digest;
	context.setTime(start + lifetimeSeconds * 1000 + 2 * day);
	const staleThenAdopted = await setup.guard(organizationId);
	const adopted = await storedRecord(context, organizationId);
	const replaced = await setup.guard(organizationId);
	const record = await storedRecord(context, organizationId);
	context.setTime(start);
	return {
		seeded,
		staleThenAdopted,
		adoptedCentralDigest: adopted?.digest === driftedDigest && adopted.sent === null,
		replaced,
		appliedSwaps: setup.central.appliedSwaps(),
		confirmedIsCentral:
			record !== null &&
			record.sent === null &&
			record.digest === setup.central.stored(organizationId)?.digest,
	};
}

async function sentExpired(context: StorageCaseContext): Promise<unknown> {
	const start = context.platform.clock.now();
	const setup = stampSetup(context);
	const organizationId = await readyOrganization(context);
	await heldStamp(context, setup, organizationId, start);
	context.setTime(start + 61 * day);
	setup.central.nextBehaviours('lose-before-apply');
	await setup.guard(organizationId);
	const signaturesInDoubt = setup.sign.signatures();
	const sendsInDoubt = setup.central.sends.length;
	// No use until the sent stamp itself has expired, 120 days after it was signed.
	context.setTime(start + 61 * day + lifetimeSeconds * 1000);
	const afterExpiry = await setup.guard(organizationId);
	const result = {
		afterExpiry,
		newSignatures: setup.sign.signatures() - signaturesInDoubt,
		newSends: setup.central.sends.length - sendsInDoubt,
		stillInDoubt: pick(await storedRecord(context, organizationId)),
	};
	context.setTime(start);
	return result;
}

async function keyChange(context: StorageCaseContext): Promise<unknown> {
	const start = context.platform.clock.now();
	let key = retiredKey;
	const setup = stampSetup(context, () => key);
	const inDoubt = await readyOrganization(context);
	const idle = await readyOrganization(context);
	const current = await readyOrganization(context);
	await heldStamp(context, setup, inDoubt, start);
	await heldStamp(context, setup, idle, start);
	// The in-doubt organization renewed under the old key and lost its answer.
	context.setTime(start + 61 * day);
	setup.central.nextBehaviours('lose-before-apply');
	await renewOrganizationStampForUse({
		...setup.props,
		currentSigningKeyId: retiredKey,
		organizationId: inDoubt,
	});
	const oldKeyInDoubt = setup.central.sends[0]?.statement;
	key = currentKey;
	await heldStamp(context, setup, current, start + 61 * day);
	const sendsBefore = setup.central.sends.length;
	// Act: the key change, far from expiry for the idle and current-key organizations.
	const run = await reSignOrganizationsForKeyChange({
		...setup.props,
		startDeadline: () => ({ signal: unreachedDeadline(), cancel: (): void => undefined }),
		organizations: {
			readyOrganizationIds: async () => ({
				kind: 'available',
				value: [inDoubt, idle, current],
			}),
		},
	});
	const sends = setup.central.sends.slice(sendsBefore);
	const keyOf = (organizationId: OrganizationId): string | undefined =>
		setup.central.stored(organizationId)?.signingKeyId;
	context.setTime(start);
	return {
		run:
			run.kind === 'complete'
				? run.organizations.map((entry, index) => ({
						kind: entry.kind,
						organization: (['in-doubt', 'idle', 'current'] as const)[index],
						matches: entry.organizationId === [inDoubt, idle, current][index],
					}))
				: run,
		inDoubtSends: sends
			.filter((send) => send.organizationId === inDoubt)
			.map((send, index) =>
				index === 0 && send.statement === oldKeyInDoubt
					? 'resent-unchanged'
					: 'current-key-statement',
			),
		idleSends: sends.filter((send) => send.organizationId === idle).length,
		currentSends: sends.filter((send) => send.organizationId === current).length,
		centralKeys: [keyOf(inDoubt), keyOf(idle), keyOf(current)],
	};
}

async function migratedRowSeeds(context: StorageCaseContext): Promise<unknown> {
	const start = context.platform.clock.now();
	const setup = stampSetup(context);
	const seeded = await readyOrganization(context);
	const unseeded = await readyOrganization(context);
	const statement = await heldStamp(context, setup, seeded, start);
	const emptyBefore = pick(await storedRecord(context, seeded));
	const seededResult = await setup.guard(seeded);
	const facts = await readOrganizationStatementFacts(context.platform.crypto, statement);
	const record = await storedRecord(context, seeded);
	// A link that fails is not an empty central (WS7): the D3 seed-failure path applies.
	setup.central.answerDigestReads('unavailable');
	const unseededResult = await setup.guard(unseeded);
	return {
		emptyBefore,
		seededResult,
		seededFromCentral:
			JSON.stringify(record) ===
			JSON.stringify({
				...facts,
				sent: null,
				unanswered: 0,
				refused: 0,
				lastTryOutcome: null,
			}),
		unseededResult,
		unseeded: await storedRecord(context, unseeded),
		digestReads: setup.central.digestReads(),
		sends: setup.central.sends.length,
	};
}

/** B2 renew-on-use rules 1-6 over each real database, through the real stamp store and guard.
 * Central is the e847a888 replacement stand-in; its own storage and checks are not proven here. */
export const organizationStampRenewalCases: readonly StorageCaseDefinition[] = [
	{
		name: 'organization stamp: exactly 60 days left renews before the call; 60 days and one second does not',
		expected: [
			{ readiness: 'ready', renewal: 'renewed', sends: 1 },
			{ readiness: 'ready', renewal: 'current', sends: 0 },
		],
		run: windowBoundary,
	},
	...(['lose-after-apply', 'lose-before-apply'] as const).map(
		(behaviour): StorageCaseDefinition => ({
			name: `organization stamp: a reply lost ${behaviour === 'lose-after-apply' ? 'after' : 'before'} the swap is re-sent byte-identical by another instance from the stored record and confirmed`,
			expected: {
				first: { readiness: 'ready', renewal: 'unanswered' },
				second: { readiness: 'ready', renewal: 'renewed' },
				sendCount: 2,
				byteIdenticalResend: true,
				signatures: 2,
				appliedSwaps: 1,
				inDoubtHeldTheSentBytes: true,
				counters: {
					unanswered: 1,
					refused: 0,
					lastTryOutcome: 'unanswered-timeout',
					inDoubt: false,
				},
				recordIsCentralsStamp: true,
			},
			run: (context) => lostReply(context, behaviour),
		}),
	),
	{
		name: 'organization stamp: two instances renewing at once leave one sent stamp and one swap',
		expected: {
			readiness: ['ready', 'ready'],
			renewalSignatures: 2,
			onlyTheClaimedStatementSent: true,
			appliedSwaps: 1,
			nothingInDoubt: { unanswered: 0, refused: 0, lastTryOutcome: null, inDoubt: false },
		},
		run: twoInstances,
	},
	{
		name: 'organization stamp: a late settlement of an older statement never clears or confirms over a newer sent stamp',
		expected: {
			claims: [true, false, true],
			confirmedOlder: true,
			lateWrites: [false, false],
			newerStillSent: true,
		},
		run: lateSettlementKeepsNewerSent,
	},
	{
		name: 'organization stamp: unanswered and refused tries are counted apart with the last outcome',
		expected: {
			unanswered: { readiness: 'ready', renewal: 'unanswered' },
			refused: { readiness: 'ready', renewal: 'refused' },
			afterUnanswered: {
				unanswered: 1,
				refused: 0,
				lastTryOutcome: 'unanswered-timeout',
				inDoubt: true,
			},
			afterRefused: {
				unanswered: 1,
				refused: 1,
				lastTryOutcome: 'refused-invalid-statement',
				inDoubt: false,
			},
			lastTryAtIsTheRefusal: true,
			resentInDoubtBytes: true,
		},
		run: countersApart,
	},
	{
		name: 'organization stamp: a valid stamp makes the call though renewal fails; an expired one waits until renewal lands',
		expected: {
			validFailing: { readiness: 'ready', renewal: 'unanswered' },
			expiredFailing: { readiness: 'unavailable', renewal: 'unanswered' },
			expiredLanding: { readiness: 'ready', renewal: 'renewed' },
		},
		run: callOverStamp,
	},
	{
		name: "organization stamp: a drifted organization whose central stamp has expired adopts central's facts on the stale refusal, then replaces central's digest and the call goes out",
		expected: {
			seeded: { readiness: 'ready', renewal: 'current' },
			staleThenAdopted: { readiness: 'unavailable', renewal: 'refused' },
			adoptedCentralDigest: true,
			replaced: { readiness: 'ready', renewal: 'renewed' },
			appliedSwaps: 1,
			confirmedIsCentral: true,
		},
		run: driftedExpiredRecovers,
	},
	{
		name: 'organization stamp: an expired sent stamp is never re-sent or replaced and the call waits',
		expected: {
			afterExpiry: { readiness: 'unavailable', renewal: 'sent-expired' },
			newSignatures: 0,
			newSends: 0,
			stillInDoubt: {
				unanswered: 1,
				refused: 0,
				lastTryOutcome: 'unanswered-timeout',
				inDoubt: true,
			},
		},
		run: sentExpired,
	},
	{
		name: 'organization stamp: key change re-sends an old-key stamp in doubt unchanged, then re-signs every organization under the current key',
		expected: {
			run: (['in-doubt', 'idle', 'current'] as const).map((role) => ({
				kind: 'current-key',
				organization: role,
				matches: true,
			})),
			inDoubtSends: ['resent-unchanged', 'current-key-statement'],
			idleSends: 1,
			currentSends: 0,
			centralKeys: [currentKey, currentKey, currentKey],
		},
		run: keyChange,
	},
	{
		name: 'organization stamp: a migrated row with an empty record seeds from central on first use; a seed read the link fails counts one unanswered try and the call proceeds',
		expected: {
			emptyBefore: { unanswered: 0, refused: 0, lastTryOutcome: null, inDoubt: false },
			seededResult: { readiness: 'ready', renewal: 'current' },
			seededFromCentral: true,
			unseededResult: { readiness: 'ready', renewal: 'unseeded' },
			unseeded: {
				digest: null,
				expiresAt: null,
				signingKeyId: null,
				sent: null,
				unanswered: 1,
				refused: 0,
				lastTryOutcome: 'unanswered-seed-unavailable',
			},
			digestReads: 2,
			sends: 0,
		},
		run: migratedRowSeeds,
	},
];
