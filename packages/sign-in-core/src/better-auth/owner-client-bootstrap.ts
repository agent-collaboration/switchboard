import { betterAuth } from 'better-auth';
import {
	createAuthEndpoint,
	originCheckMiddleware,
	formCsrfMiddleware,
	sessionMiddleware,
} from 'better-auth/api';
import { z } from 'zod';

import { adminPageRedirectUri } from '#sign-in-core/better-auth/fleet-admin-forwarding';
import {
	createSignInProvider,
	type SignInProviderProps,
	type SignInProvider,
} from '#sign-in-core/better-auth/provider-configuration';
import {
	personSessionPorts,
	requireStoredValue,
} from '#sign-in-core/better-auth/store-result-adapters';
import type {
	SystemClientRecord,
	SystemResourceRecord,
} from '#sign-in-core/storage/owner-bootstrap-store';

interface OwnerBootstrapProps {
	readonly request: Request;
	readonly provider: Omit<SignInProviderProps, 'authority' | 'generatedClientId'>;
}

/**
 * A client the owner bootstrap creates with a fixed ID and readback-checks: the management CLI
 * (unchanged) and, for B2, the admin page whose credential the sign-in server holds.
 */
interface SystemClientProfile {
	readonly clientId: string;
	readonly clientName: string;
	readonly redirectUri: string;
	readonly grantTypes: readonly ('authorization_code' | 'refresh_token')[];
	readonly scope: string;
	readonly audience: string;
	/** Fail closed: an existing client or resource that differs is never reused or rewritten. */
	readonly clientMatches: (client: SystemClientRecord) => boolean;
	readonly resourceMatches: (resource: SystemResourceRecord) => boolean;
}

function systemClientProfiles(
	configuration: SignInProviderProps['configuration'],
): readonly [SystemClientProfile, SystemClientProfile, SystemClientProfile] {
	const ttlMatches = (resource: SystemResourceRecord): boolean =>
		resource.accessTokenTtl === null ||
		resource.accessTokenTtl === configuration.accessTokenSeconds;
	const nativePkceClient = (
		client: SystemClientRecord,
		redirectUri: string,
		grantTypes: readonly string[] = ['authorization_code'],
	): boolean =>
		client.tokenEndpointAuthMethod === 'none' &&
		client.applicationType === 'native' &&
		client.requirePKCE === true &&
		JSON.stringify(client.grantTypes) === JSON.stringify(grantTypes) &&
		JSON.stringify(client.redirectUris) === JSON.stringify([redirectUri]);
	const adminResourceMatches = (resource: SystemResourceRecord): boolean =>
		!resource.disabled &&
		resource.dpopBoundAccessTokensRequired &&
		JSON.stringify(resource.allowedScopes) === JSON.stringify(['fleet:admin', 'offline_access']) &&
		ttlMatches(resource) &&
		resource.metadata === null &&
		resource.customClaims === null;
	const adminPageRedirect = adminPageRedirectUri(configuration);
	return [
		{
			clientId: configuration.ownerCliClientId,
			clientName: 'Owner management CLI',
			redirectUri: configuration.ownerCliRedirectUri,
			grantTypes: ['authorization_code'],
			scope: 'tool-portal:management',
			audience: configuration.managementAudience,
			clientMatches: (client) => nativePkceClient(client, configuration.ownerCliRedirectUri),
			resourceMatches: (resource) =>
				!resource.disabled &&
				JSON.stringify(resource.allowedScopes) === JSON.stringify(['tool-portal:management']) &&
				ttlMatches(resource) &&
				resource.metadata === null &&
				resource.customClaims === null,
		},
		{
			clientId: configuration.adminPageClientId,
			clientName: 'Organization admin page',
			redirectUri: adminPageRedirect,
			grantTypes: ['authorization_code'],
			scope: 'fleet:admin',
			audience: configuration.centralAdminAudience,
			clientMatches: (client) =>
				nativePkceClient(client, adminPageRedirect) &&
				JSON.stringify(client.scopes) === JSON.stringify(['fleet:admin']) &&
				client.skipConsent === true,
			resourceMatches: adminResourceMatches,
		},
		{
			clientId: configuration.ownerFleetCliClientId,
			clientName: 'Owner fleet CLI',
			redirectUri: configuration.ownerCliRedirectUri,
			grantTypes: ['authorization_code', 'refresh_token'],
			scope: 'fleet:admin offline_access',
			audience: configuration.centralAdminAudience,
			clientMatches: (client) =>
				nativePkceClient(client, configuration.ownerCliRedirectUri, [
					'authorization_code',
					'refresh_token',
				]) &&
				JSON.stringify(client.scopes) === JSON.stringify(['fleet:admin', 'offline_access']) &&
				client.skipConsent === true,
			resourceMatches: adminResourceMatches,
		},
	];
}

async function completeOwnerClient(
	props: OwnerBootstrapProps & { readonly authFor: (clientId: string) => SignInProvider },
): Promise<Response> {
	const { configuration, store } = props.provider;
	if (
		props.request.method !== 'POST' ||
		props.request.headers.has('authorization') ||
		props.request.headers.get('origin') !== new URL(configuration.issuer).origin
	)
		return Response.json({ error: 'not-allowed' }, { status: 403 });
	const current = await props.authFor(configuration.ownerCliClientId).api.getSession({
		headers: props.request.headers,
		query: { disableCookieCache: true },
	});
	const persons = personSessionPorts(store.persons);
	if (
		current === null ||
		(await persons.readOwnerSession(current.user.id, current.session.id)) === null
	)
		return Response.json({ error: 'not-allowed' }, { status: 403 });
	const actorUserId = current.user.id;
	const ownerSessionId = current.session.id;

	async function clientMatches(profile: SystemClientProfile): Promise<boolean> {
		const client = requireStoredValue(await store.bootstrap.readClient(profile.clientId));
		return client !== null && client.clientId === profile.clientId && profile.clientMatches(client);
	}
	async function profileComplete(profile: SystemClientProfile): Promise<boolean> {
		const resource = requireStoredValue(await store.bootstrap.readSystemResource(profile.audience));
		const links = requireStoredValue(await store.bootstrap.readLinks(profile.clientId));
		if (
			!(await clientMatches(profile)) ||
			resource === null ||
			resource.identifier !== profile.audience ||
			!profile.resourceMatches(resource) ||
			links.length !== 1 ||
			links[0] !== profile.audience
		)
			return false;
		return (await persons.readOwnerSession(actorUserId, ownerSessionId)) !== null;
	}
	async function ensureProfile(profile: SystemClientProfile): Promise<void> {
		const auth = props.authFor(profile.clientId);
		const record = async (phase: 'intent' | 'outcome'): Promise<void> => {
			requireStoredValue(
				await store.bootstrap.record({ clientId: profile.clientId, actorUserId, phase }),
			);
		};
		await record('intent');
		const existing = requireStoredValue(await store.bootstrap.readClient(profile.clientId));
		if (existing === null) {
			try {
				await auth.api.adminCreateOAuthClient({
					headers: props.request.headers,
					body: {
						client_name: profile.clientName,
						token_endpoint_auth_method: 'none',
						application_type: 'native',
						redirect_uris: [profile.redirectUri],
						grant_types: [...profile.grantTypes],
						response_types: ['code'],
						require_pkce: true,
						subject_type: 'public',
						scope: profile.scope,
						skip_consent: true,
					},
				});
			} catch (error) {
				// A concurrent bootstrap created it first; only an exact match is accepted.
				if (!(await clientMatches(profile))) throw error;
			}
		}
		const priorLinks = requireStoredValue(await store.bootstrap.readLinks(profile.clientId));
		if (!priorLinks.includes(profile.audience)) {
			try {
				await auth.api.adminLinkClientResource({
					headers: props.request.headers,
					params: { identifier: profile.audience, client_id: profile.clientId },
				});
			} catch (error) {
				// oauth-provider 1.7.11 reads err.message for duplicates; DrizzleQueryError
				// carries the constraint in cause. Our operation proves completion itself.
				if (!(await profileComplete(profile))) throw error;
			}
		}
		await record('outcome');
		if (!(await profileComplete(profile)))
			throw new Error('System client completion readback failed');
		const records = requireStoredValue(
			await store.bootstrap.readAuditIds(profile.clientId, actorUserId),
		);
		if (records.length !== 2) throw new Error('System client audit readback incomplete');
	}

	try {
		for (const profile of systemClientProfiles(configuration)) await ensureProfile(profile);
		if ((await persons.readOwnerSession(actorUserId, ownerSessionId)) === null)
			throw new Error('Owner authority changed before bootstrap completed');
		return Response.json(
			{ kind: 'complete', clientId: configuration.ownerCliClientId },
			{ headers: { 'cache-control': 'no-store' } },
		);
	} catch {
		return Response.json({ kind: 'incomplete' }, { status: 503 });
	}
}

/** Normal Better Auth HTTP middleware enforces origin, CSRF and the genuine owner session. */
export async function bootstrapOwnerClient(props: OwnerBootstrapProps): Promise<Response> {
	if (props.request.headers.has('authorization'))
		return Response.json({ error: 'not-allowed' }, { status: 403 });
	// Better Auth generates each client's ID through this option, so each profile gets its own.
	const authFor = (clientId: string): SignInProvider =>
		createSignInProvider({
			...props.provider,
			authority: { kind: 'owner-bootstrap' },
			generatedClientId: clientId,
		});
	const auth = authFor(props.provider.configuration.ownerCliClientId);
	const guarded = betterAuth({
		...auth.options,
		plugins: [
			...auth.options.plugins,
			{
				id: 'fixed-owner-cli-bootstrap',
				endpoints: {
					bootstrapOwnerCli: createAuthEndpoint(
						'/owner/bootstrap',
						{
							method: 'POST',
							body: z.strictObject({}),
							use: [originCheckMiddleware, formCsrfMiddleware, sessionMiddleware],
						},
						async () => completeOwnerClient({ ...props, authFor }),
					),
				},
			},
		],
	});
	return guarded.handler(props.request);
}
