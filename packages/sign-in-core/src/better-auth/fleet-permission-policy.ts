import { organizationRoles } from '#sign-in-core/better-auth/organization-access-control';
import type { CanonicalJsonValue } from '#sign-in-core/contracts/canonical-json';
import {
	fleetPermissionSchema,
	type FleetPermission,
} from '#sign-in-core/organizations/fleet-permission';

export type FleetRole = keyof typeof organizationRoles;

/** The typed Fleet permissions a native role's statements grant, sorted for hashing. */
function fleetPermissionsOfStatements(
	statements: Readonly<Record<string, readonly string[]>>,
): readonly FleetPermission[] {
	return Object.entries(statements)
		.flatMap(([resource, actions]) =>
			actions.flatMap((action) => {
				const permission = fleetPermissionSchema.safeParse(`${resource}:${action}`);
				return permission.success ? [permission.data] : [];
			}),
		)
		.toSorted();
}

/** T15: the policy artifact (its digest is pinned in fleet-permission-policy-digest.ts) is the role → Fleet permission map, derived from the native roles. */
export const fleetPermissionPolicy = {
	version: 1,
	roles: {
		owner: fleetPermissionsOfStatements(organizationRoles.owner.statements),
		member: fleetPermissionsOfStatements(organizationRoles.member.statements),
	},
} as const satisfies {
	readonly version: 1;
	readonly roles: Record<FleetRole, readonly FleetPermission[]>;
} & CanonicalJsonValue;

/** Null for a role this policy does not know, so issuance refuses instead of granting nothing. */
export function fleetPermissionsForRole(role: string): readonly FleetPermission[] | null {
	return role === 'owner' || role === 'member' ? fleetPermissionPolicy.roles[role] : null;
}
