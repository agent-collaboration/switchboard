import { APIError } from 'better-auth/api';

import { personFleetAccessTokenClaims } from '#sign-in-core/better-auth/person-fleet-token-claims';
import { requireStoredValue } from '#sign-in-core/better-auth/store-result-adapters';
import type { SignInConfiguration } from '#sign-in-core/contracts/deployment-configuration';
import { uuid7Schema, type SignInClock } from '#sign-in-core/contracts/sign-in-platform';
import { secondFactorTokenClaims } from '#sign-in-core/second-factors/second-factor-token-claims';
import {
	organizationIdSchema,
	personIdSchema,
	type SignInStore,
} from '#sign-in-core/storage/models/sign-in-store';

/** What Better Auth's access-token claims extension gives the contributor. */
export interface PersonAccessTokenInput {
	readonly user?: { readonly id: string } | null;
	readonly resources?: readonly string[];
	/** Absent for grants with no session, such as the device grant: those are refused. */
	readonly sessionId?: string;
}

/**
 * The person access-token contributor: the management profile, or the closed person-fleet
 * profile for the admin audience (r3 section 4). Every person token is bound to a live
 * session, so an issuance without one is `invalid_grant`.
 */
export async function personAccessTokenClaims(
	input: PersonAccessTokenInput,
	dependencies: {
		readonly configuration: Pick<
			SignInConfiguration,
			'managementAudience' | 'centralAdminAudience' | 'accessTokenSeconds'
		>;
		readonly store: SignInStore;
		readonly clock: SignInClock;
	},
): Promise<Record<string, unknown>> {
	if (input.user === undefined || input.user === null) return {};
	const audience = input.resources?.length === 1 ? input.resources[0] : undefined;
	if (
		audience !== dependencies.configuration.managementAudience &&
		audience !== dependencies.configuration.centralAdminAudience
	)
		throw new APIError('BAD_REQUEST', { error: 'invalid_target' });
	if (input.sessionId === undefined) throw new APIError('BAD_REQUEST', { error: 'invalid_grant' });
	// The admin audience carries the closed person-fleet profile (r3 section 4).
	if (audience === dependencies.configuration.centralAdminAudience)
		return personFleetAccessTokenClaims({
			personId: input.user.id,
			sessionId: input.sessionId,
			store: dependencies.store,
			clock: dependencies.clock,
			accessTokenSeconds: dependencies.configuration.accessTokenSeconds,
		});
	const current = requireStoredValue(
		await dependencies.store.persons.readPersonSession(input.user.id, input.sessionId),
	);
	if (current === null || current.session.activeOrganizationId === null)
		throw new APIError('BAD_REQUEST', {
			error: 'invalid_grant',
			message: 'choose-organization',
		});
	const organizationId = organizationIdSchema.parse(current.session.activeOrganizationId);
	const membership = requireStoredValue(
		await dependencies.store.organizations.readMemberRole({
			personId: personIdSchema.parse(input.user.id),
			organizationId,
		}),
	);
	if (membership === null)
		throw new APIError('BAD_REQUEST', {
			error: 'invalid_grant',
			message: 'choose-organization',
		});
	const factorSession = requireStoredValue(
		await dependencies.store.factors.readSession(
			personIdSchema.parse(input.user.id),
			uuid7Schema.parse(input.sessionId),
		),
	);
	if (factorSession === null) throw new APIError('BAD_REQUEST', { error: 'invalid_grant' });
	return {
		organization_id: organizationId,
		...secondFactorTokenClaims(factorSession.confirmation),
	};
}
