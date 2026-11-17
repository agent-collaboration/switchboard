import { organization, readOrganizationStatementFacts } from '@agent-collaboration/sign-in-core';
import { eq } from 'drizzle-orm';
import { expect } from 'vitest';
import { z } from 'zod';

import type { startLocalAuthHarness } from '#sign-in-test-support/test-fixtures/local-auth-harness';
import { webSignInCrypto } from '#sign-in-test-support/test-fixtures/recording-sign-in-capabilities';

type Harness = Awaited<ReturnType<typeof startLocalAuthHarness>>;

/**
 * WS7 steady state on either proof host: sign-in signs its setup statement with its native key,
 * the controlled central stores it, and the record names it with its full lifetime left, so the
 * stamp is not due and a normal call reads nothing first.
 */
export async function holdNotDueStamp(harness: Harness, organizationId: string): Promise<void> {
	const signed = await harness.auth('/__auth-proof/organization-statement', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ organizationId }),
	});
	expect(signed.status).toBe(200);
	const { statement } = z.object({ statement: z.string() }).parse(await signed.json());
	const facts = await readOrganizationStatementFacts(webSignInCrypto, statement);
	harness.centralProvisioning.holdStamp(organizationId, facts);
	await harness.database
		.update(organization)
		.set({
			fleetState: 'ready',
			fleetStampDigest: facts.digest,
			fleetStampExpiresAt: facts.expiresAt,
			fleetStampSigningKeyId: facts.signingKeyId,
			fleetStampSent: null,
		})
		.where(eq(organization.id, organizationId));
}

/**
 * The controlled central restarts empty: no stamp, no floors, and every unstamped admin route or
 * push answered with a bare 503, as pinned central `e847a888` does. Setup is answered.
 */
export function emptyControlledCentral(harness: Harness, organizationId: string): void {
	const peer = harness.centralProvisioning;
	peer.holdStamp(organizationId, null);
	peer.forgetFloors();
	peer.refuseUnstampedStores(true);
	peer.replyWith('provisioned');
	peer.replyToPushesWith('acknowledge');
}
