import type { BetterAuthPlugin } from '@better-auth/core';
import {
	APIError,
	createAuthEndpoint,
	getSessionFromCtx,
	originCheckMiddleware,
	formCsrfMiddleware,
} from 'better-auth/api';
import { z } from 'zod';

import { checkOrganizationPermission } from '#sign-in-core/better-auth/organization-permission-check';
import { requireStoredValue } from '#sign-in-core/better-auth/store-result-adapters';
import type { SignInPlatform } from '#sign-in-core/contracts/sign-in-platform';
import {
	ensureOrganizationProvisioned,
	type SignOrganizationStatement,
} from '#sign-in-core/organizations/organization-provisioning';
import {
	organizationIdSchema,
	personIdSchema,
	type SignInStore,
} from '#sign-in-core/storage/models/sign-in-store';

/** This explicit owner action is the only retry trigger; reads and forwarded requests never provision. */
export function createOrganizationProvisioningPlugin(props: {
	readonly store: Pick<SignInStore, 'persons' | 'organizations' | 'organizationStamps'>;
	readonly platform: Pick<SignInPlatform, 'centralClient'>;
	readonly signStatement: SignOrganizationStatement;
}): BetterAuthPlugin {
	return {
		id: 'organization-provisioning',
		endpoints: {
			retryOrganizationProvisioning: createAuthEndpoint(
				'/organization/retry-provisioning',
				{
					method: 'POST',
					body: z.strictObject({ organizationId: organizationIdSchema }),
					use: [originCheckMiddleware, formCsrfMiddleware],
				},
				async (context) => {
					if (context.headers?.has('authorization')) throw new APIError('FORBIDDEN');
					const current = await getSessionFromCtx(context, { disableCookieCache: true });
					if (current === null || !current.user.emailVerified) throw new APIError('UNAUTHORIZED');
					const live = requireStoredValue(
						await props.store.persons.readPersonSession(current.user.id, current.session.id),
					);
					if (live === null) throw new APIError('UNAUTHORIZED');
					const allowed = requireStoredValue(
						await checkOrganizationPermission({
							context,
							personId: personIdSchema.parse(current.user.id),
							organizationId: context.body.organizationId,
							permission: 'organization:view',
							readMemberRole: props.store.organizations.readMemberRole,
						}),
					);
					if (!allowed) throw new APIError('FORBIDDEN');
					const result = await ensureOrganizationProvisioned({
						organizationId: context.body.organizationId,
						store: props.store.organizations,
						stamps: props.store.organizationStamps,
						centralClient: props.platform.centralClient,
						signStatement: props.signStatement,
					});
					context.setHeader('cache-control', 'no-store');
					if (result.kind === 'ready') return context.json(result);
					if (result.kind === 'setting-up') {
						context.setStatus(503);
						return context.json(result);
					}
					if (result.kind === 'refused') {
						context.setStatus(409);
						return context.json(result);
					}
					throw new APIError('SERVICE_UNAVAILABLE', { message: 'organization-setup-unavailable' });
				},
			),
		},
	};
}
