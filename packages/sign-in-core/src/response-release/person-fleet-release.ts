import {
	personFleetSnapshotWindowMaximumMilliseconds,
	personFleetTokenClaimsSchema,
} from '#sign-in-core/contracts/person-fleet-token';

export type PersonFleetReleaseRefusal =
	| 'profile-invalid'
	| 'snapshot-elapsed'
	| 'session-elapsed'
	| 'native-expired';
export type PersonFleetRelease =
	| {
			readonly kind: 'releasable';
			readonly personId: string;
			readonly sessionId: string;
			readonly organizationId: string;
	  }
	| { readonly kind: 'refused'; readonly reason: PersonFleetReleaseRefusal };

/**
 * r3 section 4, release-time check: the issuer's clock is sampled again and a token whose
 * signed snapshot or session deadline has passed is never released. Equality is expired.
 * Central enforces the same bounds again at its applying transaction.
 */
export function decidePersonFleetRelease(props: {
	readonly signedClaims: unknown;
	readonly now: number;
}): PersonFleetRelease {
	const claims = personFleetTokenClaimsSchema.safeParse(props.signedClaims);
	if (!claims.success) return { kind: 'refused', reason: 'profile-invalid' };
	const signed = claims.data;
	const window = signed.authorization_snapshot_valid_until_ms - signed.authorization_snapshot_at_ms;
	if (window <= 0 || window > personFleetSnapshotWindowMaximumMilliseconds)
		return { kind: 'refused', reason: 'profile-invalid' };
	if (props.now >= signed.authorization_snapshot_valid_until_ms)
		return { kind: 'refused', reason: 'snapshot-elapsed' };
	if (props.now >= signed.session_expires_at_ms)
		return { kind: 'refused', reason: 'session-elapsed' };
	if (props.now >= signed.exp * 1000) return { kind: 'refused', reason: 'native-expired' };
	return {
		kind: 'releasable',
		personId: signed.sub,
		sessionId: signed.sid,
		organizationId: signed.organization_id,
	};
}
