import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { jwks, organization, type SignInDatabase } from '@agent-collaboration/sign-in-core';
import { requirePrivateRuntimePath } from '@agent-collaboration/sign-in-owner-cli';
import { z } from 'zod';

import type { ControlledCentralProvisioning } from '#sign-in-test-support/test-fixtures/controlled-central-provisioning';

const retainedTimestampSchema = z
	.date()
	.nullable()
	.transform((value) => value?.getTime() ?? null);
const organizationStampEvidenceSchema = z.object({
	id: z.uuidv7(),
	fleetState: z.enum(['settingUp', 'ready']),
	fleetStampDigest: z
		.string()
		.regex(/^[a-f0-9]{64}$/u)
		.nullable(),
	fleetStampExpiresAt: z.number().int().nonnegative().nullable(),
	fleetStampSigningKeyId: z.string().min(1).nullable(),
	fleetStampSent: z.string().min(1).nullable(),
	fleetStampRenewedAt: retainedTimestampSchema,
	fleetStampUnansweredTries: z.number().int().nonnegative(),
	fleetStampRefusedTries: z.number().int().nonnegative(),
	fleetStampLastTryAt: retainedTimestampSchema,
	fleetStampLastTryOutcome: z
		.enum([
			'unanswered-seed-unavailable',
			'unanswered-unavailable',
			'unanswered-timeout',
			'unanswered-malformed-reply',
			'refused-stale',
			'refused-organization-mismatch',
			'refused-invalid-statement',
		])
		.nullable(),
});

/** Read the injected real store before teardown. Never export native private keys or sessions. */
export async function retainOrganizationJourneyEvidence(props: {
	readonly database: SignInDatabase;
	readonly peer: ControlledCentralProvisioning;
	readonly receiptId: string;
	readonly signInHost: 'cloudflare' | 'node';
}): Promise<void> {
	if (process.env.AUTH_PROOF_ORGANIZATION_EVIDENCE !== '1') return;
	const manifestFile = process.env.AUTH_PROOF_MANIFEST_FILE;
	if (manifestFile === undefined)
		throw new Error('Organization evidence requires a frozen manifest');
	const directory = path.dirname(await requirePrivateRuntimePath(manifestFile, true));
	// Keep only the public setup state and the server-written stamp record. The full
	// organization read lets the evidence schema refuse a target lacking the migration.
	const organizations = z
		.array(organizationStampEvidenceSchema)
		.parse(await props.database.select().from(organization));
	const publicKeys = await props.database
		.select({ id: jwks.id, publicKey: jwks.publicKey })
		.from(jwks);
	await writeFile(
		path.join(directory, `organization-evidence-${props.receiptId}.json`),
		JSON.stringify({
			receiptId: props.receiptId,
			storage: props.signInHost === 'node' ? 'better-sqlite3' : 'D1',
			organizations,
			publicKeys,
			exchanges: props.peer.exchanges,
			standIn: 'recording-central-peer',
		}),
		{ mode: 0o600, flag: 'wx' },
	);
}
