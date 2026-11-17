import {
	organization,
	organizationIdSchema,
	readOrganizationStatementFacts,
	renewOrganizationStampForUse,
	type OrganizationId,
} from '@agent-collaboration/sign-in-core';
import { eq } from 'drizzle-orm';
import { decodeJwt } from 'jose';

import {
	createCentralStampModel,
	createStatementSigner,
	type CentralStampModel,
} from '#sign-in-test-support/storage-cases/organization-stamp-central-model';
import type { StorageCaseContext } from '#sign-in-test-support/storage-cases/storage-case-context';
import type { StorageCaseDefinition } from '#sign-in-test-support/storage-cases/storage-case-registry';
import { unreachedDeadline } from '#sign-in-test-support/test-fixtures/manual-deadlines';

const currentKey = 'current-native-key';
const day = 86_400_000;

interface EmptyCentralSetup {
	readonly organizationId: OrganizationId;
	readonly central: CentralStampModel;
	readonly sign: ReturnType<typeof createStatementSigner>;
	readonly guard: () => Promise<{ readonly readiness: string; readonly renewal: string }>;
}

/** A ready organization and a central that, like a freshly started one, holds nothing for it. */
async function emptyCentral(context: StorageCaseContext): Promise<EmptyCentralSetup> {
	const organizationId = organizationIdSchema.parse(context.platform.ids.nextId());
	await context
		.openDatabase()
		.insert(organization)
		.values({
			id: organizationId,
			name: 'Central empty',
			slug: `central-empty-${organizationId}`,
			createdAt: new Date(context.platform.clock.now()),
			fleetState: 'ready',
		});
	const central = createCentralStampModel();
	const sign = createStatementSigner({
		now: () => context.platform.clock.now(),
		signingKeyId: () => currentKey,
	});
	return {
		organizationId,
		central,
		sign,
		async guard() {
			const readiness = await renewOrganizationStampForUse({
				organizationId,
				stamps: context.store.organizationStamps,
				revisions: context.store.revisionDelivery,
				centralClient: central.client,
				sign,
				clock: context.platform.clock,
				crypto: context.platform.crypto,
				currentSigningKeyId: currentKey,
				deadline: unreachedDeadline(),
			});
			return { readiness: readiness.kind, renewal: readiness.renewal.kind };
		},
	};
}

async function record(
	context: StorageCaseContext,
	organizationId: OrganizationId,
): Promise<{
	readonly digest: string | null;
	readonly sent: string | null;
	readonly unanswered: number;
	readonly refused: number;
	readonly lastTryOutcome: string | null;
}> {
	const row = (
		await context
			.openDatabase()
			.select({
				digest: organization.fleetStampDigest,
				sent: organization.fleetStampSent,
				unanswered: organization.fleetStampUnansweredTries,
				refused: organization.fleetStampRefusedTries,
				lastTryOutcome: organization.fleetStampLastTryOutcome,
			})
			.from(organization)
			.where(eq(organization.id, organizationId))
	)[0];
	if (row === undefined) throw new Error('Central-empty organization row missing');
	return row;
}

/** Each send, named by what it is: a setup statement or a renewal naming a predecessor. */
function sendKinds(central: CentralStampModel): readonly string[] {
	return central.sends.map((send) =>
		typeof decodeJwt(send.statement)['replaces'] === 'string' ? 'renewal' : 'setup',
	);
}

async function seededFromCentral(
	context: StorageCaseContext,
	setup: EmptyCentralSetup,
): Promise<boolean> {
	const stored = setup.central.stored(setup.organizationId);
	return stored !== null && (await record(context, setup.organizationId)).digest === stored.digest;
}

async function emptyRecordSetsUpAgain(context: StorageCaseContext): Promise<unknown> {
	const setup = await emptyCentral(context);
	const result = await setup.guard();
	return {
		result,
		sends: sendKinds(setup.central),
		seededFromCentral: await seededFromCentral(context, setup),
		inDoubt: (await record(context, setup.organizationId)).sent !== null,
	};
}

async function forgottenRenewalSetsUpAgain(context: StorageCaseContext): Promise<unknown> {
	const start = context.platform.clock.now();
	const setup = await emptyCentral(context);
	// The record names a stamp from before central was emptied, now 61 days into its life.
	const old = await readOrganizationStatementFacts(
		context.platform.crypto,
		await setup.sign({ organizationId: setup.organizationId }),
	);
	await context.store.organizationStamps.seedConfirmedStamp({
		organizationId: setup.organizationId,
		stamp: old,
	});
	context.setTime(start + 61 * day);
	const result = await setup.guard();
	const after = await record(context, setup.organizationId);
	context.setTime(start);
	return {
		result,
		sends: sendKinds(setup.central),
		seededFromCentral: await seededFromCentral(context, setup),
		forgotTheOldStamp: after.digest !== old.digest,
		refused: after.refused,
		lastTryOutcome: after.lastTryOutcome,
	};
}

async function unansweredSetupWaits(context: StorageCaseContext): Promise<unknown> {
	const setup = await emptyCentral(context);
	setup.central.nextBehaviours('lose-before-apply');
	const unanswered = await setup.guard();
	const between = await record(context, setup.organizationId);
	const nextUse = await setup.guard();
	return {
		unanswered,
		emptyBetween: between.digest === null && between.sent === null,
		// Lead ruling (13 Nov): no sent slot, but the lost setup is still counted.
		countedBetween: {
			unanswered: between.unanswered,
			refused: between.refused,
			lastTryOutcome: between.lastTryOutcome,
		},
		nextUse,
		sends: sendKinds(setup.central),
		seededFromCentral: await seededFromCentral(context, setup),
	};
}

async function failingLinkIsNotEmpty(context: StorageCaseContext): Promise<unknown> {
	const setup = await emptyCentral(context);
	setup.central.answerDigestReads('unavailable');
	const result = await setup.guard();
	return {
		result,
		sends: sendKinds(setup.central),
		lastTryOutcome: (await record(context, setup.organizationId)).lastTryOutcome,
	};
}

/** WS7 (Lead, 12 Nov; owner via Lead A): the new central starts empty, and sign-in recovers. */
export const organizationCentralEmptyCases: readonly StorageCaseDefinition[] = [
	{
		name: 'central empty: an empty record whose central holds nothing is set up again with a fresh setup statement, seeded from central, and the call proceeds',
		expected: {
			result: { readiness: 'ready', renewal: 'reprovisioned' },
			sends: ['setup'],
			seededFromCentral: true,
			inDoubt: false,
		},
		run: emptyRecordSetsUpAgain,
	},
	{
		name: 'central empty: a renewal refused because central forgot the organization forgets the record and sets it up again',
		expected: {
			result: { readiness: 'ready', renewal: 'reprovisioned' },
			sends: ['renewal', 'setup'],
			seededFromCentral: true,
			forgotTheOldStamp: true,
			refused: 1,
			lastTryOutcome: 'refused-stale',
		},
		run: forgottenRenewalSetsUpAgain,
	},
	{
		name: 'central empty: an unanswered fresh setup keeps the call back and the next use sets the organization up',
		expected: {
			unanswered: { readiness: 'unavailable', renewal: 'central-empty' },
			emptyBetween: true,
			countedBetween: { unanswered: 1, refused: 0, lastTryOutcome: 'unanswered-timeout' },
			nextUse: { readiness: 'ready', renewal: 'reprovisioned' },
			sends: ['setup', 'setup'],
			seededFromCentral: true,
		},
		run: unansweredSetupWaits,
	},
	{
		name: 'central empty: a link that fails the stamp read is never taken for an empty central',
		expected: {
			result: { readiness: 'ready', renewal: 'unseeded' },
			sends: [],
			lastTryOutcome: 'unanswered-seed-unavailable',
		},
		run: failingLinkIsNotEmpty,
	},
];
