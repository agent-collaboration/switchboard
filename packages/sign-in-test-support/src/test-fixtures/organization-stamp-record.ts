import { organization, type SignInDatabase } from '@agent-collaboration/sign-in-core';
import { eq } from 'drizzle-orm';

/**
 * Arranges a provisioned (ready) organization whose confirmed stamp expired one second ago, with
 * nothing in doubt: B2 rule 4's state. The record is the guard's input; every renewal step still
 * runs in product.
 */
export async function holdExpiredStampRecord(props: {
	readonly database: SignInDatabase;
	readonly organizationId: string;
	readonly nowMilliseconds: number;
}): Promise<void> {
	const updated = await props.database
		.update(organization)
		.set({
			fleetState: 'ready',
			fleetStampDigest: 'f'.repeat(64),
			fleetStampExpiresAt: Math.floor(props.nowMilliseconds / 1000) - 1,
			fleetStampSigningKeyId: 'expired-stamp-key',
			fleetStampSent: null,
		})
		.where(eq(organization.id, props.organizationId))
		.returning({ id: organization.id });
	if (updated.length !== 1) throw new Error('Stamp record arrangement found no organization');
}
