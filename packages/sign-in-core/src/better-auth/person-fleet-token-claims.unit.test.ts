import { expect, it } from 'vitest';

import { personFleetAccessTokenClaims } from '#sign-in-core/better-auth/person-fleet-token-claims';
import { epochMillisecondsSchema } from '#sign-in-core/contracts/sign-in-platform';
import { fleetPermissionPolicyDigest } from '#sign-in-core/organizations/fleet-permission-policy-digest';
import type { PersonFleetAuthorizationSnapshot } from '#sign-in-core/organizations/person-fleet-issuance';

const startedAt = 2_208_988_800_000;

it('dates the snapshot by the clock read before the coherent read was dispatched, even if the read is slow', async (): Promise<void> => {
	// Arrange: the store's read takes 250 s of controlled time before it returns.
	let now = startedAt;
	const snapshot: PersonFleetAuthorizationSnapshot = {
		sessionExpiresAt: epochMillisecondsSchema.parse(startedAt + 3_600_000),
		organizationId: '019a3dce-2000-7000-8000-000000000001',
		confirmation: { kind: 'unconfirmed' },
		memberRole: 'member',
		subject: { id: '019a3dce-2000-7000-8000-000000000002', revision: 1, state: 'active' },
		organizationFence: {
			revision: 1,
			state: 'active',
			permissionPolicyDigest: fleetPermissionPolicyDigest,
		},
	};
	// Act
	const claims = await personFleetAccessTokenClaims({
		personId: '019a3dce-2000-7000-8000-000000000003',
		sessionId: '019a3dce-2000-7000-8000-000000000004',
		clock: { now: () => epochMillisecondsSchema.parse(now) },
		accessTokenSeconds: 300,
		store: {
			authorizations: {
				readPersonFleetSnapshot: async () => {
					now += 250_000;
					return { kind: 'available', value: snapshot };
				},
			},
		},
	});
	// Assert: S and S + L come from before the read, never from when it returned.
	expect(claims.authorization_snapshot_at_ms).toBe(startedAt);
	expect(claims.authorization_snapshot_valid_until_ms).toBe(startedAt + 300_000);
});

it('refuses with the decision reason and no claims when the snapshot does not authorize', async (): Promise<void> => {
	await expect(
		personFleetAccessTokenClaims({
			personId: '019a3dce-2000-7000-8000-000000000003',
			sessionId: '019a3dce-2000-7000-8000-000000000004',
			clock: { now: () => epochMillisecondsSchema.parse(startedAt) },
			accessTokenSeconds: 300,
			store: {
				authorizations: {
					readPersonFleetSnapshot: async () => ({ kind: 'available', value: null }),
				},
			},
		}),
	).rejects.toMatchObject({ body: { error: 'invalid_grant', message: 'no-session' } });
});
