import {
	personIdSchema,
	uuid7Schema,
	organizationIdSchema,
	type SignInStore,
} from '@agent-collaboration/sign-in-core';
import {
	createSignInProvider,
	confirmPersonPermission,
} from '@agent-collaboration/sign-in-core/better-auth';
import {
	organizationPersonTokenClaimsSchema,
	personSessionConfirmationSchema,
} from '@agent-collaboration/sign-in-core/person-identity';
import { betterAuth } from 'better-auth';
import { APIError, createAuthEndpoint } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import type { OrganizationOptions } from 'better-auth/plugins/organization';
import { z } from 'zod';

import type { StorageCaseContext } from '#sign-in-test-support/storage-cases/storage-case-context';
import { storageProviderProperties } from '#sign-in-test-support/storage-cases/storage-provider-fixture';

type BeforeRemove = NonNullable<
	NonNullable<OrganizationOptions['organizationHooks']>['beforeRemoveMember']
>;

/** Isolated native-provider/real-database proof, not first-factor authentication.
 * A test-only setup endpoint asks the native internal adapter and cookie helper
 * for the fixture person's actual session. No cookie or endpoint context is forged.
 * Neither this setup endpoint nor the confirmation probe enters a production host. */
export function createOrganizationProofProvider(props: {
	readonly context: StorageCaseContext;
	readonly organizationId: string;
	readonly store?: SignInStore;
	readonly wrapBeforeRemove?: (productionHook: BeforeRemove) => BeforeRemove;
}): Pick<ReturnType<typeof betterAuth>, 'handler' | '$context'> {
	const store = props.store ?? props.context.store;
	const properties = { ...storageProviderProperties(props.context, props.organizationId), store };
	const base = createSignInProvider({ ...properties, authority: { kind: 'public' } });
	if (props.wrapBeforeRemove !== undefined) {
		const hooks = base.options.plugins[5].options.organizationHooks;
		const productionHook = hooks?.beforeRemoveMember;
		if (hooks === undefined || productionHook === undefined)
			throw new Error('Production owner-removal hook absent');
		hooks.beforeRemoveMember = props.wrapBeforeRemove(productionHook);
	}
	const permissionSchema = personSessionConfirmationSchema.options[1].shape.permission;
	return betterAuth({
		...base.options,
		plugins: [
			...base.options.plugins,
			{
				id: 'storage-organization-proof',
				endpoints: {
					fixtureSession: createAuthEndpoint(
						'/__storage-proof/session',
						{ method: 'POST', body: z.object({ personId: personIdSchema }) },
						async (ctx) => {
							const person = await ctx.context.internalAdapter.findUserById(ctx.body.personId);
							if (person === null) throw new APIError('NOT_FOUND');
							const created = await ctx.context.internalAdapter.createSession(person.id);
							if (created === null) throw new APIError('INTERNAL_SERVER_ERROR');
							await setSessionCookie(ctx, { session: created, user: person });
							return ctx.json({ id: created.id });
						},
					),
					confirmationProbe: createAuthEndpoint(
						'/__storage-proof/confirmation',
						{
							method: 'POST',
							body: z.object({
								claims: organizationPersonTokenClaimsSchema,
								organizationId: organizationIdSchema,
								permission: permissionSchema,
							}),
						},
						async (ctx) =>
							ctx.json(
								await confirmPersonPermission({
									context: ctx,
									verifiedClaims: ctx.body.claims,
									requestOrganizationId: ctx.body.organizationId,
									permission: ctx.body.permission,
									clock: props.context.platform.clock,
									store,
								}),
							),
					),
				},
			},
		],
	});
}

export async function nativeProofCookie(props: {
	readonly context: StorageCaseContext;
	readonly personId: string;
	readonly organizationId: string;
	readonly confirmation?: 'app';
}): Promise<string> {
	const properties = storageProviderProperties(props.context, props.organizationId);
	const auth = createOrganizationProofProvider(props);
	const response = await auth.handler(
		new Request(properties.configuration.issuer + '/api/auth/__storage-proof/session', {
			method: 'POST',
			headers: { 'content-type': 'application/json', origin: properties.configuration.issuer },
			body: JSON.stringify({ personId: props.personId }),
		}),
	);
	if (!response.ok) throw new Error('Native fixture session refused');
	if (props.confirmation === 'app') {
		const sessionId = z.object({ id: uuid7Schema }).parse(await response.clone().json()).id;
		const stamped = await props.context.store.factors.stampSession({
			personId: personIdSchema.parse(props.personId),
			sessionId,
			method: 'app',
		});
		if (stamped.kind !== 'available' || stamped.value.kind !== 'stamped')
			throw new Error('Fixture confirmation unavailable');
	}
	const cookie = response.headers
		.getSetCookie()
		.map((value) => value.split(';')[0])
		.join('; ');
	if (cookie.length === 0) throw new Error('Native fixture session returned no cookie');
	return cookie;
}
