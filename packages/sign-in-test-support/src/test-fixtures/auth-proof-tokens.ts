import { organizationIdSchema } from '@agent-collaboration/sign-in-core';
import { createProviderRequestState } from '@agent-collaboration/sign-in-core/better-auth';
import {
	createSignInProvider,
	type SignInHttpConfiguration,
} from '@agent-collaboration/sign-in-core/better-auth';
import { signInWorkerConfiguration } from '@agent-collaboration/sign-in-host-cloudflare/configuration';
import { personTokenClaimsSchema } from '@agent-collaboration/tool-access/contracts';
import { betterAuth } from 'better-auth';
import { APIError, createAuthEndpoint } from 'better-auth/api';
import { signJWT } from 'better-auth/plugins/jwt';
import { z } from 'zod';

import { controlledSignInIds } from '#sign-in-test-support/test-fixtures/controlled-sign-in-clock';
import { recordingD1Database } from '#sign-in-test-support/test-fixtures/recording-d1-database';

/** Negative controls only: authentic issuer keys sign a deliberately invalid Person or legacy Agent profile. */
export async function handleAuthProofTokenRequest(
	request: Request,
	bindings: AuthWorkerEnv,
): Promise<Response | null> {
	return handleConfiguredAuthProofTokenRequest(request, () =>
		signInWorkerConfiguration({ ...bindings, DB: recordingD1Database(bindings.DB) }),
	);
}

export async function handleConfiguredAuthProofTokenRequest(
	request: Request,
	configuration: () => SignInHttpConfiguration,
): Promise<Response | null> {
	const pathname = new URL(request.url).pathname;
	if (
		![
			'/api/auth/__proof/without-sid',
			'/api/auth/__proof/legacy-agent',
			'/api/auth/__proof/owner-token-profile',
			'/__auth-proof/no-hook',
			'/__auth-proof/organization-statement',
			'/__auth-proof/organization-provisioning-send',
		].includes(pathname)
	)
		return null;
	if (pathname === '/__auth-proof/organization-provisioning-send') {
		// Fixture transport only: one statement through the host's production provisioning client
		// and link. Production sends at most one statement per stamp (B2 rule 1), so this is how a
		// proof shows central refusing a stale predecessor; it touches no sign-in record.
		const input = z
			.strictObject({ organizationId: organizationIdSchema, organizationStatement: z.string() })
			.parse(await request.json());
		return Response.json(await configuration().platform.centralClient.provisionOrganization(input));
	}
	const provider = configuration();
	const auth = createSignInProvider({
		...provider,
		authority: { kind: 'public' },
		requestState: createProviderRequestState(),
	});
	if (pathname === '/__auth-proof/organization-statement') {
		// Fixture transport only: production's server-only endpoint owns validation and signing.
		const input = z
			.looseObject({
				organizationId: z.string(),
				replaces: z.string().optional(),
			})
			.parse(await request.json());
		return auth.api.signOrganizationStatement({ body: input, asResponse: true });
	}
	if (pathname === '/__auth-proof/no-hook') {
		try {
			await auth.api.adminCreateOAuthClient({
				headers: new Headers(),
				body: {
					client_name: 'no-hook-upgrade-guard',
					grant_types: ['client_credentials'],
					client_credentials_scopes: ['tool-portal:agent'],
					token_endpoint_auth_method: 'client_secret_basic',
					metadata: { kind: 'agent', organizationId: provider.configuration.organizationIds[0] },
				},
			});
			return Response.json({ refused: false });
		} catch (error) {
			if (error instanceof APIError && (error.statusCode === 401 || error.statusCode === 403))
				return Response.json({ refused: true });
			throw error;
		}
	}
	return betterAuth({
		...auth.options,
		plugins: [
			...auth.options.plugins,
			{
				id: 'negative-person-profile-proof',
				endpoints: {
					ownerTokenProfile: createAuthEndpoint(
						'/__proof/owner-token-profile',
						{
							method: 'POST',
							body: z.strictObject({
								claims: personTokenClaimsSchema,
								profile: z.enum(['long-lifetime', 'wrong-client', 'bad-signature']),
							}),
						},
						async (context) => {
							const claims = context.body.claims;
							const foreignClient = controlledSignInIds.nextId();
							const payload = {
								...claims,
								jti: controlledSignInIds.nextId(),
								...(context.body.profile === 'long-lifetime' ? { exp: claims.iat + 301 } : {}),
								...(context.body.profile === 'wrong-client'
									? { client_id: foreignClient, azp: foreignClient }
									: {}),
							};
							const token = await signJWT(context, {
								options: {
									jwt: { issuer: provider.configuration.issuer },
									jwks: { keyPairConfig: { alg: 'EdDSA' } },
								},
								header: { typ: 'at+jwt' },
								payload,
							});
							if (context.body.profile !== 'bad-signature') return context.json({ token });
							const [header, body, signature] = token.split('.');
							if (
								header === undefined ||
								body === undefined ||
								signature === undefined ||
								signature.length === 0
							)
								throw new Error('Fixture signer returned an invalid compact token');
							return context.json({
								token: `${header}.${body}.${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`,
							});
						},
					),
					legacyAgent: createAuthEndpoint(
						'/__proof/legacy-agent',
						{
							method: 'POST',
							body: z.strictObject({ clientId: z.string().min(1), organizationId: z.uuid() }),
						},
						async (context) => {
							const now = Math.floor(provider.platform.clock.now() / 1000);
							const token = await signJWT(context, {
								options: {
									jwt: { issuer: provider.configuration.issuer },
									jwks: { keyPairConfig: { alg: 'EdDSA' } },
								},
								header: { typ: 'at+jwt' },
								payload: {
									iss: provider.configuration.issuer,
									sub: context.body.clientId,
									aud: `${provider.configuration.toolPortalOrigin}/mcp`,
									iat: now,
									exp: now + 300,
									client_id: context.body.clientId,
									azp: context.body.clientId,
									organization_id: context.body.organizationId,
									scope: 'tool-portal:agent',
									jti: controlledSignInIds.nextId(),
								},
							});
							return context.json({ token });
						},
					),
					withoutPersonSid: createAuthEndpoint(
						'/__proof/without-sid',
						{
							method: 'POST',
							body: z.strictObject({ subject: z.string().min(1), clientId: z.string().min(1) }),
						},
						async (context) => {
							const now = Math.floor(provider.platform.clock.now() / 1000);
							const token = await signJWT(context, {
								options: {
									jwt: { issuer: provider.configuration.issuer },
									jwks: { keyPairConfig: { alg: 'EdDSA' } },
								},
								header: { typ: 'at+jwt' },
								payload: {
									iss: provider.configuration.issuer,
									sub: context.body.subject,
									aud: provider.configuration.managementAudience,
									iat: now,
									exp: now + 300,
									client_id: context.body.clientId,
									azp: context.body.clientId,
									scope: 'tool-portal:management',
									jti: controlledSignInIds.nextId(),
								},
							});
							return context.json({ token });
						},
					),
				},
			},
		],
	}).handler(request);
}
