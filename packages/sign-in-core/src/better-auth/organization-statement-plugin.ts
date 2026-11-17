import type { GenericEndpointContext } from '@better-auth/core';
import { createAuthEndpoint } from 'better-auth/api';
import { resolveSigningKey } from 'better-auth/plugins/jwt';
import { z } from 'zod';

import { signInJwtOptions } from '#sign-in-core/better-auth/native-jwt-options';
import { signOrganizationStatement } from '#sign-in-core/better-auth/organization-statement-signing';
import type { SignInConfiguration } from '#sign-in-core/contracts/deployment-configuration';
import { organizationStatementSigningRequestSchema } from '#sign-in-core/contracts/organization-statement';
import type { SignInPlatform } from '#sign-in-core/contracts/sign-in-platform';
import {
	recoverForgottenOrganization,
	type ForgottenOrganizationRecovery,
} from '#sign-in-core/organizations/organization-central-recovery';
import {
	prepareOrganizationFleetCall,
	type OrganizationFleetCallReadiness,
} from '#sign-in-core/organizations/organization-fleet-call';
import {
	reSignOrganizationsForKeyChange,
	type OrganizationKeyChangeRun,
} from '#sign-in-core/organizations/organization-key-change';
import type { OrganizationStampRenewalProps } from '#sign-in-core/organizations/organization-stamp-renewal';
import { organizationIdSchema, type SignInStore } from '#sign-in-core/storage/models/sign-in-store';

const fleetCallSchema = z.strictObject({ organizationId: organizationIdSchema });
const keyChangeSchema = z.strictObject({});
type FleetCallEndpoint = ReturnType<
	typeof createAuthEndpoint.serverOnly<
		string,
		{ method: 'POST'; body: typeof fleetCallSchema },
		OrganizationFleetCallReadiness
	>
>;
type RecoveryEndpoint = ReturnType<
	typeof createAuthEndpoint.serverOnly<
		string,
		{ method: 'POST'; body: typeof fleetCallSchema },
		ForgottenOrganizationRecovery
	>
>;
type KeyChangeEndpoint = ReturnType<
	typeof createAuthEndpoint.serverOnly<
		string,
		{ method: 'POST'; body: typeof keyChangeSchema },
		OrganizationKeyChangeRun
	>
>;

type SigningEndpoint = ReturnType<
	typeof createAuthEndpoint.serverOnly<
		string,
		{ method: 'POST'; body: typeof organizationStatementSigningRequestSchema },
		{ statement: string }
	>
>;

/** Server-only dispatch gives each Fleet call's stamp guard the native signing context,
 * without an HTTP route (B2 renew-on-use, owner 9 Nov: there is no daily job). */
export function createOrganizationStatementPlugin(props: {
	readonly configuration: SignInConfiguration;
	readonly platform: Pick<SignInPlatform, 'clock' | 'centralClient' | 'crypto' | 'deadlines'>;
	readonly store: Pick<SignInStore, 'organizations' | 'organizationStamps' | 'revisionDelivery'>;
}): {
	readonly id: 'organization-statement';
	readonly endpoints: {
		readonly signOrganizationStatement: SigningEndpoint;
		readonly prepareOrganizationFleetCall: FleetCallEndpoint;
		readonly recoverForgottenOrganization: RecoveryEndpoint;
		readonly reSignOrganizationsForKeyChange: KeyChangeEndpoint;
	};
} {
	async function stampRenewalProps(
		context: GenericEndpointContext,
		deadline: AbortSignal,
	): Promise<Omit<OrganizationStampRenewalProps, 'organizationId'>> {
		const currentKey = await resolveSigningKey(context, signInJwtOptions(props.configuration));
		return {
			stamps: props.store.organizationStamps,
			revisions: props.store.revisionDelivery,
			centralClient: props.platform.centralClient,
			clock: props.platform.clock,
			crypto: props.platform.crypto,
			deadline,
			// Without a key nothing can be signed; a valid stamp still lets the call go out.
			currentSigningKeyId: currentKey?.kid ?? '',
			sign: async (request) => {
				if (currentKey === null) throw new Error('Native organization signing key unavailable');
				return signOrganizationStatement({
					context,
					request,
					configuration: props.configuration,
					clock: props.platform.clock,
				});
			},
		};
	}
	return {
		id: 'organization-statement',
		endpoints: {
			signOrganizationStatement: createAuthEndpoint.serverOnly(
				{ method: 'POST', body: organizationStatementSigningRequestSchema },
				async (context) => ({
					statement: await signOrganizationStatement({
						context,
						request: context.body,
						configuration: props.configuration,
						clock: props.platform.clock,
					}),
				}),
			),
			prepareOrganizationFleetCall: createAuthEndpoint.serverOnly(
				{ method: 'POST', body: fleetCallSchema },
				async (context) => {
					// D7: the renewal runs inside the original request, so it ends on its own.
					const deadline = props.platform.deadlines.start(
						props.configuration.organizationStampRenewalDeadlineMilliseconds,
					);
					try {
						return await prepareOrganizationFleetCall({
							...(await stampRenewalProps(context, deadline.signal)),
							centralClient: props.platform.centralClient,
							revisions: props.store.revisionDelivery,
							organizationId: context.body.organizationId,
						});
					} finally {
						deadline.cancel();
					}
				},
			),
			// WS7 R-notdue: the run's step after central's own 503; the run shares its deadline.
			recoverForgottenOrganization: createAuthEndpoint.serverOnly(
				{ method: 'POST', body: fleetCallSchema },
				async (context) => {
					const deadline = props.platform.deadlines.start(
						props.configuration.organizationStampRenewalDeadlineMilliseconds,
					);
					try {
						return await recoverForgottenOrganization({
							...(await stampRenewalProps(context, deadline.signal)),
							organizationId: context.body.organizationId,
						});
					} finally {
						deadline.cancel();
					}
				},
			),
			reSignOrganizationsForKeyChange: createAuthEndpoint.serverOnly(
				{ method: 'POST', body: keyChangeSchema },
				async (context) =>
					reSignOrganizationsForKeyChange({
						...(await stampRenewalProps(context, new AbortController().signal)),
						organizations: props.store.organizations,
						startDeadline: () =>
							props.platform.deadlines.start(
								props.configuration.organizationStampRenewalDeadlineMilliseconds,
							),
					}),
			),
		},
	};
}
