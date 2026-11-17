import { APIError } from 'better-auth/api';

import { fleetPermissionsForRole } from '#sign-in-core/better-auth/fleet-permission-policy';
import { requireStoredValue } from '#sign-in-core/better-auth/store-result-adapters';
import type { PersonFleetApplicationClaims } from '#sign-in-core/contracts/person-fleet-token';
import type { SignInClock } from '#sign-in-core/contracts/sign-in-platform';
import { fleetPermissionPolicyDigest } from '#sign-in-core/organizations/fleet-permission-policy-digest';
import { decidePersonFleetIssuance } from '#sign-in-core/organizations/person-fleet-issuance';
import type { SignInStore } from '#sign-in-core/storage/models/sign-in-store';

/**
 * r3 section 4 for the admin audience. S is sampled before the coherent read is dispatched,
 * so an old result can never be dated after it. A refusal is `invalid_grant`, never claims.
 */
export async function personFleetAccessTokenClaims(props: {
	readonly personId: string;
	readonly sessionId: string;
	readonly store: Pick<SignInStore, 'authorizations'>;
	readonly clock: SignInClock;
	readonly accessTokenSeconds: number;
}): Promise<PersonFleetApplicationClaims> {
	const snapshotAt = props.clock.now();
	const snapshot = requireStoredValue(
		await props.store.authorizations.readPersonFleetSnapshot(props.personId, props.sessionId),
	);
	const decision = decidePersonFleetIssuance({
		snapshot,
		snapshotAt,
		tokenLifetimeMilliseconds: props.accessTokenSeconds * 1000,
		loadedPolicyDigest: fleetPermissionPolicyDigest,
		permissionsForRole: fleetPermissionsForRole,
	});
	if (decision.kind === 'refused')
		throw new APIError('BAD_REQUEST', { error: 'invalid_grant', message: decision.reason });
	return decision.claims;
}
