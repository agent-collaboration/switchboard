import type { hasPermission } from 'better-auth/plugins/organization';

import { checkOrganizationPermission } from '#sign-in-core/better-auth/organization-permission-check';
import {
	personSessionConfirmationSchema,
	type OrganizationPersonTokenClaims,
	type PersonSessionConfirmation,
} from '#sign-in-core/contracts/person-identity-contracts';
import type { SignInClock } from '#sign-in-core/contracts/sign-in-platform';
import type { FleetPermission } from '#sign-in-core/organizations/fleet-permission';
import type { SignInStoreFailure } from '#sign-in-core/storage/models/sign-in-database';
import type { OrganizationId, SignInStore } from '#sign-in-core/storage/models/sign-in-store';

export type PersonPermissionConfirmation = PersonSessionConfirmation | SignInStoreFailure;

/** The caller verifies the token's signature and audience first. This read confirms one request's live permission. */
export async function confirmPersonPermission(props: {
	readonly context: Parameters<typeof hasPermission>[1];
	readonly verifiedClaims: OrganizationPersonTokenClaims;
	readonly requestOrganizationId: OrganizationId;
	readonly permission: FleetPermission;
	readonly clock: SignInClock;
	readonly store: Pick<SignInStore, 'persons' | 'organizations'>;
}): Promise<PersonPermissionConfirmation> {
	const claims = props.verifiedClaims;
	if (claims.organization_id !== props.requestOrganizationId) return { active: false };
	const checkedAt = props.clock.now();
	if (claims.exp <= Math.floor(checkedAt / 1000)) return { active: false };
	const current = await props.store.persons.readPersonSession(claims.sub, claims.sid);
	if (current.kind === 'store-unavailable') return current;
	if (current.value === null) return { active: false };
	const allowed = await checkOrganizationPermission({
		context: props.context,
		personId: claims.sub,
		organizationId: props.requestOrganizationId,
		permission: props.permission,
		readMemberRole: props.store.organizations.readMemberRole,
	});
	if (allowed.kind === 'store-unavailable') return allowed;
	if (!allowed.value) return { active: false };
	return personSessionConfirmationSchema.parse({
		active: true,
		sub: claims.sub,
		sid: claims.sid,
		aud: claims.aud,
		exp: claims.exp,
		organization_id: claims.organization_id,
		permission: props.permission,
		checkedAt,
	});
}
