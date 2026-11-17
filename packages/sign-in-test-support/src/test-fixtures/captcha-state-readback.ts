import { signInSchema } from '@agent-collaboration/sign-in-core';

import type { startLocalAuthHarness } from '#sign-in-test-support/test-fixtures/local-auth-harness';
import { rowFingerprints } from '#sign-in-test-support/test-fixtures/stored-row-fingerprints';

type LocalAuthHarness = Awaited<ReturnType<typeof startLocalAuthHarness>>;
export interface CaptchaStateSnapshot {
	readonly verification: readonly string[];
	readonly users: readonly string[];
	readonly accounts: readonly string[];
	readonly sessions: readonly string[];
	readonly organizations: readonly string[];
	readonly memberships: readonly string[];
	readonly invitations: readonly string[];
	readonly audit: readonly string[];
}

/** Compare every stored identity field without exposing OAuth state in assertion output. */
export async function readCaptchaState(harness: LocalAuthHarness): Promise<CaptchaStateSnapshot> {
	const [verification, users, accounts, sessions, organizations, memberships, invitations, audit] =
		await Promise.all([
			harness.database.select().from(signInSchema.verification).all(),
			harness.database.select().from(signInSchema.user).all(),
			harness.database.select().from(signInSchema.account).all(),
			harness.database.select().from(signInSchema.session).all(),
			harness.database.select().from(signInSchema.organization).all(),
			harness.database.select().from(signInSchema.member).all(),
			harness.database.select().from(signInSchema.invitation).all(),
			harness.database.select().from(signInSchema.signInAudit).all(),
		]);
	return {
		verification: rowFingerprints(verification),
		users: rowFingerprints(users),
		accounts: rowFingerprints(accounts),
		sessions: rowFingerprints(sessions),
		organizations: rowFingerprints(organizations),
		memberships: rowFingerprints(memberships),
		invitations: rowFingerprints(invitations),
		audit: rowFingerprints(audit),
	};
}

/** Reset only transient OAuth and audit rows on a fresh, signed-out harness. Readiness creates no owner or organization. */
export async function clearCaptchaState(harness: LocalAuthHarness): Promise<void> {
	await harness.database.delete(signInSchema.verification).run();
	await harness.database.delete(signInSchema.signInAudit).run();
}
