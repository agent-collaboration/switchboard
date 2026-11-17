import {
	organization,
	organizationIdSchema,
	renewOrganizationStampForUse,
	readOrganizationStatementFacts,
} from '@agent-collaboration/sign-in-core';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import {
	createCentralStampModel,
	createStatementSigner,
} from '#sign-in-test-support/storage-cases/organization-stamp-central-model';
import type { StorageCaseContext } from '#sign-in-test-support/storage-cases/storage-case-context';
import { resetStorageCase } from '#sign-in-test-support/storage-cases/storage-case-utilities';
import { unreachedDeadline } from '#sign-in-test-support/test-fixtures/manual-deadlines';

const currentKey = 'current-native-key';
const day = 86_400_000;

/** What the test carries across the restart: the identity of the stamp left in doubt. */
export const stampRestartStateSchema = z.strictObject({
	organizationId: z.uuidv7(),
	heldStatement: z.string().min(1),
	sentStatement: z.string().min(1),
	resumeAt: z.number().int().nonnegative(),
});
export type StampRestartState = z.infer<typeof stampRestartStateSchema>;

interface StampRow {
	readonly sent: string | null;
	readonly digest: string | null;
	readonly unanswered: number;
	readonly refused: number;
	readonly lastTryOutcome: string | null;
}

async function stampRow(
	context: StorageCaseContext,
	organizationId: string,
): Promise<StampRow | null> {
	return (
		(
			await context
				.openDatabase()
				.select({
					sent: organization.fleetStampSent,
					digest: organization.fleetStampDigest,
					unanswered: organization.fleetStampUnansweredTries,
					refused: organization.fleetStampRefusedTries,
					lastTryOutcome: organization.fleetStampLastTryOutcome,
				})
				.from(organization)
				.where(eq(organization.id, organizationId))
		)[0] ?? null
	);
}

/** The row with its two byte-valued fields named by which known statement they match. */
function describeRow(
	row: StampRow | null,
	statements: { readonly sent: string; readonly digests: Readonly<Record<string, string>> },
): unknown {
	if (row === null) return null;
	const digestName = Object.entries(statements.digests).find(([, digest]) => digest === row.digest);
	return {
		sent:
			row.sent === null
				? null
				: row.sent === statements.sent
					? 'the bytes sent before restart'
					: 'other',
		digest: digestName?.[0] ?? 'other',
		unanswered: row.unanswered,
		refused: row.refused,
		lastTryOutcome: row.lastTryOutcome,
	};
}

/**
 * Before the restart: central applies a renewal and its reply is lost (B2 rule 1), so the
 * production guard leaves exactly one stamp in doubt with one unanswered try.
 */
export async function prepareStampRestart(context: StorageCaseContext): Promise<StampRestartState> {
	// Each workerd command restarts the deterministic ID source, as the other restart cases do.
	await resetStorageCase(context);
	const start = context.platform.clock.now();
	const organizationId = organizationIdSchema.parse(context.platform.ids.nextId());
	await context
		.openDatabase()
		.insert(organization)
		.values({
			id: organizationId,
			name: 'Stamp restart',
			slug: `stamp-restart-${organizationId}`,
			createdAt: new Date(start),
			fleetState: 'ready',
		});
	const central = createCentralStampModel();
	const sign = createStatementSigner({
		now: () => context.platform.clock.now(),
		signingKeyId: () => currentKey,
	});
	const heldStatement = await sign({ organizationId });
	await central.hold(organizationId, heldStatement);
	context.setTime(start + 61 * day);
	central.nextBehaviours('lose-after-apply');
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
	const sentStatement = central.sends[0]?.statement;
	if (readiness.renewal.kind !== 'unanswered' || sentStatement === undefined)
		throw new Error(
			`Restart arrangement did not leave a stamp in doubt: ${readiness.renewal.kind}`,
		);
	return { organizationId, heldStatement, sentStatement, resumeAt: start + 61 * day + 60_000 };
}

/**
 * After a real restart (SQLite closed and reopened, or workerd disposed and restarted): the
 * reopened row must still hold the same bytes and counters, and the next use re-sends exactly
 * them. Central applied that statement before the restart, so it answers the replay.
 */
export async function readStampAfterRestart(
	context: StorageCaseContext,
	state: StampRestartState,
): Promise<unknown> {
	const organizationId = organizationIdSchema.parse(state.organizationId);
	const reopened = await stampRow(context, organizationId);
	const central = createCentralStampModel();
	await central.hold(organizationId, state.sentStatement);
	context.setTime(state.resumeAt);
	const readiness = await renewOrganizationStampForUse({
		organizationId,
		stamps: context.store.organizationStamps,
		revisions: context.store.revisionDelivery,
		centralClient: central.client,
		sign: async () => {
			throw new Error('A stamp in doubt must be re-sent, never re-signed');
		},
		clock: context.platform.clock,
		crypto: context.platform.crypto,
		currentSigningKeyId: currentKey,
		deadline: unreachedDeadline(),
	});
	const sent = await readOrganizationStatementFacts(context.platform.crypto, state.sentStatement);
	const held = await readOrganizationStatementFacts(context.platform.crypto, state.heldStatement);
	const statements = {
		sent: state.sentStatement,
		digests: { 'the held stamp': held.digest, 'the re-sent stamp': sent.digest },
	};
	return {
		reopened: describeRow(reopened, statements),
		readiness: readiness.kind,
		renewal: readiness.renewal.kind,
		resent: central.sends.map((send) =>
			send.statement === state.sentStatement ? 'the bytes sent before restart' : 'other',
		),
		confirmed: describeRow(await stampRow(context, organizationId), statements),
	};
}
