import { expect, it } from 'vitest';

import { epochMillisecondsSchema } from '#sign-in-core/contracts/sign-in-platform';
import type { FleetPermission } from '#sign-in-core/organizations/fleet-permission';
import {
	decidePersonFleetIssuance,
	type PersonFleetAuthorizationSnapshot,
} from '#sign-in-core/organizations/person-fleet-issuance';

const snapshotAt = epochMillisecondsSchema.parse(2_208_988_800_000);
const digest = 'd'.repeat(64);
const organizationId = '019a3dce-2000-7000-8000-000000000001';
const subjectId = '019a3dce-2000-7000-8000-000000000002';
// Literals from PD 2530c3a3's permission names, unsorted on purpose.
const ownerPermissions: readonly FleetPermission[] = ['workspace:create', 'organization:view'];

function snapshot(
	overrides: Partial<PersonFleetAuthorizationSnapshot> = {},
): PersonFleetAuthorizationSnapshot {
	return {
		sessionExpiresAt: epochMillisecondsSchema.parse(snapshotAt + 3_600_000),
		organizationId,
		confirmation: {
			kind: 'confirmed',
			at: epochMillisecondsSchema.parse(snapshotAt - 600_000),
			method: 'app',
		},
		memberRole: 'owner',
		subject: { id: subjectId, revision: 3, state: 'active' },
		organizationFence: { revision: 2, state: 'active', permissionPolicyDigest: digest },
		...overrides,
	};
}

function decide(
	value: PersonFleetAuthorizationSnapshot | null,
	tokenLifetimeMilliseconds = 300_000,
): ReturnType<typeof decidePersonFleetIssuance> {
	return decidePersonFleetIssuance({
		snapshot: value,
		snapshotAt,
		tokenLifetimeMilliseconds,
		loadedPolicyDigest: digest,
		permissionsForRole: (role) =>
			role === 'owner' ? ownerPermissions : role === 'member' ? [] : null,
	});
}

it('issues the closed person-fleet claims from the snapshot, dated S, with the original factor time', (): void => {
	// Expected values: r3 section 4's claim names, S + L, and the session's own confirmation.
	expect(decide(snapshot())).toEqual({
		kind: 'issue',
		claims: {
			token_profile: 'person-fleet',
			organization_id: organizationId,
			authorization_subject_id: subjectId,
			person_revision: 3,
			organization_revision: 2,
			permission_policy_digest: digest,
			permissions: ['organization:view', 'workspace:create'],
			session_expires_at_ms: snapshotAt + 3_600_000,
			authorization_snapshot_at_ms: snapshotAt,
			authorization_snapshot_valid_until_ms: snapshotAt + 300_000,
			second_factor_at: Math.floor((snapshotAt - 600_000) / 1000),
			second_factor_method: 'app',
		},
	});
});

it('carries no factor facts for an unconfirmed session and an empty permission set for a member', (): void => {
	const decided = decide(snapshot({ confirmation: { kind: 'unconfirmed' }, memberRole: 'member' }));
	expect(decided.kind).toBe('issue');
	if (decided.kind !== 'issue') return;
	expect(decided.claims.permissions).toEqual([]);
	expect(Object.keys(decided.claims)).not.toContain('second_factor_at');
	expect(Object.keys(decided.claims)).not.toContain('second_factor_method');
});

it.each<{
	readonly name: string;
	readonly value: PersonFleetAuthorizationSnapshot | null;
	readonly reason: string;
}>([
	{ name: 'no live session row', value: null, reason: 'no-session' },
	{
		name: 'a session ending exactly at S',
		value: snapshot({ sessionExpiresAt: snapshotAt }),
		reason: 'session-expired',
	},
	{
		name: 'a session that ended before S',
		value: snapshot({ sessionExpiresAt: epochMillisecondsSchema.parse(snapshotAt - 1) }),
		reason: 'session-expired',
	},
	{
		name: 'no active organization',
		value: snapshot({ organizationId: null }),
		reason: 'no-organization',
	},
	{ name: 'no current membership', value: snapshot({ memberRole: null }), reason: 'no-membership' },
	{ name: 'no retained pair', value: snapshot({ subject: null }), reason: 'subject-missing' },
	{
		name: 'an inactive pair',
		value: snapshot({ subject: { id: subjectId, revision: 4, state: 'inactive' } }),
		reason: 'subject-inactive',
	},
	{
		name: 'no org fence',
		value: snapshot({ organizationFence: null }),
		reason: 'organization-fence-missing',
	},
	{
		name: 'a stopped org fence',
		value: snapshot({
			organizationFence: { revision: 3, state: 'stopped', permissionPolicyDigest: digest },
		}),
		reason: 'organization-inactive',
	},
	{
		name: 'a deleted org fence',
		value: snapshot({
			organizationFence: { revision: 3, state: 'deleted', permissionPolicyDigest: digest },
		}),
		reason: 'organization-inactive',
	},
	{
		name: 'a fence naming a newer policy than this process loaded',
		value: snapshot({
			organizationFence: { revision: 3, state: 'active', permissionPolicyDigest: 'e'.repeat(64) },
		}),
		reason: 'policy-mismatch',
	},
	{
		name: 'a role the policy does not know',
		value: snapshot({ memberRole: 'admin' }),
		reason: 'unknown-role',
	},
])('refuses $name', ({ value, reason }): void => {
	expect(decide(value)).toEqual({ kind: 'refused', reason });
});

it.each([0, -1, 300_001, 1.5, Number.MAX_SAFE_INTEGER + 2])(
	'refuses a token lifetime of %s ms rather than signing an unbounded or empty window',
	(lifetime): void => {
		expect(decide(snapshot(), lifetime)).toEqual({ kind: 'refused', reason: 'invalid-window' });
	},
);

it('refuses a snapshot whose deadline would overflow a safe integer', (): void => {
	expect(
		decidePersonFleetIssuance({
			snapshot: snapshot({
				sessionExpiresAt: epochMillisecondsSchema.parse(Number.MAX_SAFE_INTEGER),
			}),
			snapshotAt: epochMillisecondsSchema.parse(Number.MAX_SAFE_INTEGER - 10),
			tokenLifetimeMilliseconds: 300_000,
			loadedPolicyDigest: digest,
			permissionsForRole: () => ownerPermissions,
		}),
	).toEqual({ kind: 'refused', reason: 'invalid-window' });
});
