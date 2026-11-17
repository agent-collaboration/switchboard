import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
	member,
	organizationAuthorizationRevisions,
	personOrganizationAuthorizationRevisions,
	session,
	type SignInDatabase,
} from '@agent-collaboration/sign-in-core';
import { requirePrivateRuntimePath } from '@agent-collaboration/sign-in-owner-cli';

import type { ControlledCentralProvisioning } from '#sign-in-test-support/test-fixtures/controlled-central-provisioning';

/** Final real-store readbacks complement the tests' intermediate assertions; session tokens stay private. */
export async function retainRevisionJourneyEvidence(props: {
	readonly database: SignInDatabase;
	readonly receiptId: string;
	readonly peer: ControlledCentralProvisioning;
	readonly signInHost: 'cloudflare' | 'node';
}): Promise<void> {
	if (process.env.AUTH_PROOF_REVISION_EVIDENCE !== '1') return;
	const manifestFile = process.env.AUTH_PROOF_MANIFEST_FILE;
	if (manifestFile === undefined) throw new Error('Revision evidence requires a frozen manifest');
	const directory = path.dirname(await requirePrivateRuntimePath(manifestFile, true));
	const members = await props.database.select().from(member);
	const sessions = await props.database
		.select({ id: session.id, userId: session.userId })
		.from(session);
	const organizations = await props.database.select().from(organizationAuthorizationRevisions);
	const persons = await props.database.select().from(personOrganizationAuthorizationRevisions);
	await writeFile(
		path.join(directory, `revision-evidence-${props.receiptId}.json`),
		JSON.stringify({
			receiptId: props.receiptId,
			storage: props.signInHost === 'node' ? 'better-sqlite3' : 'D1',
			members,
			sessions,
			organizations,
			persons,
			centralStandIn: 'recording-producer-contract-peer',
			centralPushes: props.peer.pushes,
			centralExchanges: props.peer.exchanges.filter(
				(exchange) => exchange.path === '/internal/organization-authorization-revisions',
			),
		}),
		{ mode: 0o600, flag: 'wx' },
	);
}
