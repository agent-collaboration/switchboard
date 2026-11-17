import { expect, it } from 'vitest';

import { decidePersonFleetRelease } from '#sign-in-core/response-release/person-fleet-release';

const snapshotAt = 2_208_988_800_000;
const personId = '019a3dce-2000-7000-8000-0000000000a1';
const sessionId = '019a3dce-2000-7000-8000-0000000000a2';
const organizationId = '019a3dce-2000-7000-8000-0000000000a3';

/** A signed person-fleet token whose three deadlines are independent. */
function signedClaims(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
	return {
		iss: 'https://sign-in.example.invalid',
		aud: 'https://central.example.invalid/admin',
		sub: personId,
		sid: sessionId,
		iat: snapshotAt / 1000,
		exp: snapshotAt / 1000 + 300,
		cnf: { jkt: 'thumbprint-of-the-caller-key' },
		client_id: 'client',
		azp: 'client',
		scope: 'fleet:admin',
		jti: 'native-jti',
		token_profile: 'person-fleet',
		organization_id: organizationId,
		authorization_subject_id: '019a3dce-2000-7000-8000-0000000000a4',
		person_revision: 1,
		organization_revision: 1,
		permission_policy_digest: 'd'.repeat(64),
		permissions: ['organization:view'],
		session_expires_at_ms: snapshotAt + 3_600_000,
		authorization_snapshot_at_ms: snapshotAt,
		authorization_snapshot_valid_until_ms: snapshotAt + 300_000,
		second_factor_at: snapshotAt / 1000 - 60,
		second_factor_method: 'passkey',
		...overrides,
	};
}

it('releases a token inside all three deadlines and names its session for the live check', (): void => {
	expect(decidePersonFleetRelease({ signedClaims: signedClaims(), now: snapshotAt + 1 })).toEqual({
		kind: 'releasable',
		personId,
		sessionId,
		organizationId,
	});
});

it.each([
	{
		name: 'the snapshot deadline is reached, with native exp and the session still future',
		claims: signedClaims({
			exp: snapshotAt / 1000 + 300 + 600,
			session_expires_at_ms: snapshotAt + 3_600_000,
		}),
		now: snapshotAt + 300_000,
		reason: 'snapshot-elapsed',
	},
	{
		name: 'the signed session deadline is reached first, with the snapshot and native exp future',
		claims: signedClaims({ session_expires_at_ms: snapshotAt + 10_000 }),
		now: snapshotAt + 10_000,
		reason: 'session-elapsed',
	},
	{
		name: 'native exp is reached first',
		claims: signedClaims({ exp: snapshotAt / 1000 + 5 }),
		now: snapshotAt + 5_000,
		reason: 'native-expired',
	},
])('refuses at equality when $name', ({ claims, now, reason }): void => {
	expect(decidePersonFleetRelease({ signedClaims: claims, now })).toEqual({
		kind: 'refused',
		reason,
	});
	// One millisecond earlier the same token is releasable.
	expect(decidePersonFleetRelease({ signedClaims: claims, now: now - 1 }).kind).toBe('releasable');
});

it.each<{ readonly name: string; readonly claims: Record<string, unknown> }>([
	{ name: 'no key binding', claims: signedClaims({ cnf: undefined }) },
	{ name: 'an empty key thumbprint', claims: signedClaims({ cnf: { jkt: '' } }) },
	{ name: 'another profile', claims: signedClaims({ token_profile: 'person-management' }) },
	{
		name: 'a missing snapshot deadline',
		claims: signedClaims({ authorization_snapshot_valid_until_ms: undefined }),
	},
	{
		name: 'a missing session deadline',
		claims: signedClaims({ session_expires_at_ms: undefined }),
	},
	{
		name: 'a window longer than the token lifetime',
		claims: signedClaims({ authorization_snapshot_valid_until_ms: snapshotAt + 300_001 }),
	},
	{
		name: 'a deadline at or before S',
		claims: signedClaims({ authorization_snapshot_valid_until_ms: snapshotAt }),
	},
	{
		name: 'an unsafe deadline',
		claims: signedClaims({ authorization_snapshot_valid_until_ms: Number.MAX_SAFE_INTEGER + 2 }),
	},
	{
		name: 'a fractional deadline',
		claims: signedClaims({ session_expires_at_ms: snapshotAt + 0.5 }),
	},
	{
		name: 'a non-UUIDv7 subject row',
		claims: signedClaims({ authorization_subject_id: 'subject' }),
	},
	{ name: 'a zero revision', claims: signedClaims({ person_revision: 0 }) },
	{ name: 'an unknown permission', claims: signedClaims({ permissions: ['organization:delete'] }) },
	{
		name: 'a non-hex policy digest',
		claims: signedClaims({ permission_policy_digest: 'D'.repeat(64) }),
	},
])('refuses $name as an invalid profile', ({ claims }): void => {
	expect(decidePersonFleetRelease({ signedClaims: claims, now: snapshotAt + 1 })).toEqual({
		kind: 'refused',
		reason: 'profile-invalid',
	});
});
