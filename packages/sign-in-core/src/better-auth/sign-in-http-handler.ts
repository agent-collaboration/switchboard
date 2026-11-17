import { decodeJwt, decodeProtectedHeader } from 'jose';

import {
	renderFactorFormResponse,
	type FactorPageState,
} from '#sign-in-core/better-auth/factor-enrollment-page';
import {
	forwardFleetAdminRequest,
	isFleetAdminForwardingRoute,
} from '#sign-in-core/better-auth/fleet-admin-forwarding';
import {
	isFleetAdminRelayRoute,
	relayFleetAdminRequest,
} from '#sign-in-core/better-auth/fleet-admin-relay';
import {
	minimalOwnerPage,
	ownerAuthorizationResume,
} from '#sign-in-core/better-auth/minimal-owner-pages';
import {
	organizationAdminPage,
	organizationAdminPagePath,
} from '#sign-in-core/better-auth/organization-admin-page';
import {
	createOrganizationFleetCallGuard,
	createOrganizationFleetCallRunner,
} from '#sign-in-core/better-auth/organization-fleet-call-guard';
import { bootstrapOwnerClient } from '#sign-in-core/better-auth/owner-client-bootstrap';
import {
	createSignInProvider,
	type SignInProviderProps,
} from '#sign-in-core/better-auth/provider-configuration';
import {
	createProviderRequestState,
	type ProviderRequestState,
} from '#sign-in-core/better-auth/provider-request-state';
import {
	agentRegistrationPorts,
	personSessionPorts,
	workspaceResourcePorts,
	requireStoredValue,
} from '#sign-in-core/better-auth/store-result-adapters';
import { uuid7Schema } from '#sign-in-core/contracts/sign-in-platform';
import { runAuthorizationRevisionDrain } from '#sign-in-core/organizations/authorization-revision-drainer';
import type { OrganizationFleetState } from '#sign-in-core/organizations/organization-provisioning';
import { pageAssetResponse } from '#sign-in-core/pages/page-document';
import {
	admitSignInRequest,
	providerLimitedResponse,
} from '#sign-in-core/request-limits/sign-in-request-admission';
import {
	handleSignInRequest,
	isPublicSignInRoute,
} from '#sign-in-core/response-release/sign-in-request-handler';
import {
	accessTokenReleaseClaimsSchema,
	type SignInResponseReleasePorts,
} from '#sign-in-core/response-release/sign-in-response-release';
import { decideRecentSecondFactor } from '#sign-in-core/second-factors/second-factor-step-up';
import { personIdSchema } from '#sign-in-core/storage/models/sign-in-store';
import type { OrganizationMembership } from '#sign-in-core/storage/organization-membership-store';

export type SignInHttpConfiguration = Omit<
	SignInProviderProps,
	'authority' | 'generatedClientId' | 'requestState' | 'tokenClientId'
>;

/** Real Better Auth HTTP always returns through the portable release fence. No raw person API is published. */
export interface SignInHttpHandlerOptions {
	/** The host keeps work alive past the response: `waitUntil` on Workers, tracked on Node. */
	readonly deferAfterResponse?: (work: Promise<unknown>) => void;
}

export function createSignInHttpHandler(
	configuration: SignInHttpConfiguration,
	options: SignInHttpHandlerOptions = {},
): (request: Request) => Promise<Response> {
	return async (incomingRequest: Request): Promise<Response> => {
		const asset = pageAssetResponse(incomingRequest);
		if (asset !== null) return asset;
		const state = createProviderRequestState();
		try {
			return await respondToSignInRequest(incomingRequest, state);
		} finally {
			// r3 section 5: a committed fence change hints a bounded drain once the response is ready;
			// the periodic drain recovers a lost hint.
			if (state.authorizationFenceCommitted)
				options.deferAfterResponse?.(
					runAuthorizationRevisionDrain({
						...configuration,
						prepareFleetCall: createOrganizationFleetCallGuard(configuration),
					}),
				);
		}
	};
	/**
	 * B2's admin page and its forwarding routes. The forwarder obtains each request's
	 * person-fleet token through this same handler, so every admission and release fence runs.
	 */
	async function respondToOrganizationAdmin(
		request: Request,
		pathname: string,
		state: ProviderRequestState,
	): Promise<Response> {
		const provider = createSignInProvider({
			...configuration,
			requestState: state,
			authority: { kind: 'public' },
		});
		const persons = personSessionPorts(configuration.store.persons);
		const liveSession = async (): Promise<{
			readonly personId: string;
			readonly activeOrganizationId: string | null;
		} | null> => {
			const current = await provider.api.getSession({
				headers: request.headers,
				query: { disableCookieCache: true },
			});
			if (
				current === null ||
				!current.user.emailVerified ||
				!(await persons.isPersonSessionActive(current.user.id, current.session.id))
			)
				return null;
			const activeOrganizationId =
				'activeOrganizationId' in current.session &&
				typeof current.session.activeOrganizationId === 'string'
					? current.session.activeOrganizationId
					: null;
			return { personId: current.user.id, activeOrganizationId };
		};
		if (isFleetAdminForwardingRoute(pathname))
			return forwardFleetAdminRequest({
				request,
				route: pathname,
				configuration: configuration.configuration,
				platform: configuration.platform,
				hasLiveSession: async () => (await liveSession()) !== null,
				signIn: (inner) => respondToSignInRequest(inner, createProviderRequestState()),
				runFleetCall: createOrganizationFleetCallRunner(configuration),
			});
		if (request.method !== 'GET') return Response.json({ error: 'not-found' }, { status: 404 });
		const current = await liveSession();
		// Built, not `Response.redirect`: hosts add headers to every response.
		const seeOther = (pathname: string): Response =>
			new Response(null, {
				status: 303,
				headers: {
					location: new URL(pathname, configuration.configuration.issuer).toString(),
					'cache-control': 'no-store',
				},
			});
		if (current === null) return seeOther('/sign-in');
		const membership = requireStoredValue(
			await configuration.store.organizations.membershipsForPerson(current.personId),
		).find((candidate) => candidate.organizationId === current.activeOrganizationId);
		if (membership === undefined) return seeOther('/owner-ready');
		return organizationAdminPage({
			organizationId: membership.organizationId,
			organizationName: membership.organizationName,
			operationId: configuration.platform.ids.nextId(),
		});
	}
	async function respondToSignInRequest(
		incomingRequest: Request,
		state: ProviderRequestState,
	): Promise<Response> {
		const persons = personSessionPorts(configuration.store.persons);
		try {
			const admission = await admitSignInRequest({
				request: incomingRequest,
				platform: configuration.platform,
			});
			if (admission.kind === 'refused') return admission.response;
			const request = admission.request;
			const url = new URL(request.url);
			if (!isPublicSignInRoute(url.pathname, request.method))
				return Response.json({ error: 'not-found' }, { status: 404 });
			if (isFleetAdminRelayRoute(url.pathname))
				return await relayFleetAdminRequest({
					request,
					route: url.pathname,
					platform: configuration.platform,
					runFleetCall: createOrganizationFleetCallRunner(configuration),
				});
			if (isFleetAdminForwardingRoute(url.pathname) || url.pathname === organizationAdminPagePath)
				return await respondToOrganizationAdmin(request, url.pathname, state);
			// Validate continuation before any native factor mutation, not after
			// confirmation has already rotated the browser's session cookie.
			const factorResume = url.pathname.startsWith('/api/auth/two-factor/')
				? ownerAuthorizationResume(url.searchParams.get('authorize'), configuration.configuration)
				: null;
			if (url.pathname === '/api/auth/link-social') {
				const payload: unknown = await request.clone().json();
				if (payload !== null && typeof payload === 'object' && Object.hasOwn(payload, 'idToken'))
					return Response.json({ error: 'redirect-linking-required' }, { status: 400 });
			}
			if (request.method === 'GET' && ['/sign-in', '/owner-ready'].includes(url.pathname)) {
				let createOrganization = false;
				let organizationSetup:
					| { readonly organizationId: string; readonly state: OrganizationFleetState }
					| undefined;
				let factorPage: FactorPageState = 'hidden';
				let organizationChoices: readonly Pick<
					OrganizationMembership,
					'organizationId' | 'organizationName' | 'role'
				>[] = [];
				if (url.pathname === '/owner-ready') {
					const auth = createSignInProvider({
						...configuration,
						requestState: state,
						authority: { kind: 'public' },
					});
					const current = await auth.api.getSession({
						headers: request.headers,
						query: { disableCookieCache: true },
					});
					if (current !== null && current.user.emailVerified) {
						const activeOrganizationId =
							'activeOrganizationId' in current.session
								? current.session.activeOrganizationId
								: null;
						const memberships = requireStoredValue(
							await configuration.store.organizations.membershipsForPerson(current.user.id),
						);
						const selected = memberships.find(
							(membership) => membership.organizationId === activeOrganizationId,
						);
						if (selected?.role === 'owner') {
							const fleetState = requireStoredValue(
								await configuration.store.organizations.readFleetState(selected.organizationId),
							);
							if (fleetState !== null)
								organizationSetup = { organizationId: selected.organizationId, state: fleetState };
						}
						createOrganization =
							current.user.email.toLowerCase() ===
								configuration.configuration.ownerEmail.toLowerCase() && memberships.length === 0;
						if (
							memberships.length > 1 &&
							!memberships.some((membership) => membership.organizationId === activeOrganizationId)
						)
							organizationChoices = memberships.map(
								({ organizationId, organizationName, role }) => ({
									organizationId,
									organizationName,
									role,
								}),
							);
						const factors = requireStoredValue(
							await configuration.store.factors.readSession(
								personIdSchema.parse(current.user.id),
								uuid7Schema.parse(current.session.id),
							),
						);
						if (factors !== null)
							factorPage =
								factors.enrollment.kind === 'never-enrolled'
									? 'enroll-app'
									: decideRecentSecondFactor({
												now: configuration.platform.clock.now(),
												confirmation: factors.confirmation,
										  }).kind === 'confirmed'
										? 'confirmed'
										: 'confirm';
					}
				}
				const resumedAuthorization = new URL(
					'/api/auth/oauth2/authorize',
					configuration.configuration.issuer,
				);
				resumedAuthorization.search = url.search;
				return minimalOwnerPage({
					crypto: configuration.platform.crypto,
					organizationChoices,
					...(organizationSetup === undefined ? {} : { organizationSetup }),
					factorPage,
					createOrganization,
					ready: url.pathname === '/owner-ready',
					configuration: configuration.configuration,
					resume: ownerAuthorizationResume(
						url.searchParams.get('authorize') ??
							(url.searchParams.has('client_id') ? resumedAuthorization.toString() : null),
						configuration.configuration,
					),
				});
			}
			const body =
				url.pathname === '/api/auth/oauth2/token'
					? new URLSearchParams(await request.clone().text())
					: undefined;
			const basic = request.headers.get('authorization')?.match(/^Basic ([^\s]+)$/iu)?.[1];
			const tokenClientId =
				body?.get('client_id') ?? (basic === undefined ? undefined : atob(basic).split(':')[0]);
			const providerProps = {
				...configuration,
				requestState: state,
				...(tokenClientId === null || tokenClientId === undefined ? {} : { tokenClientId }),
			};
			if (url.pathname === '/api/auth/owner/bootstrap')
				return bootstrapOwnerClient({ request, provider: providerProps });
			const provider = createSignInProvider({ ...providerProps, authority: { kind: 'public' } });
			if (url.pathname === '/api/auth/link-social') {
				const current = await provider.api.getSession({ headers: request.headers });
				if (
					current === null ||
					!(await persons.isPersonSessionActive(current.user.id, current.session.id))
				)
					return Response.json({ error: 'not-allowed' }, { status: 403 });
			}
			const agents = agentRegistrationPorts(configuration.store);
			const ports: SignInResponseReleasePorts = {
				issuer: configuration.configuration.issuer,
				toolPortalOrigin: configuration.configuration.toolPortalOrigin,
				requestedResource: body?.getAll('resource').length === 1 ? body.get('resource') : null,
				managementAudience: configuration.configuration.managementAudience,
				centralAdminAudience: configuration.configuration.centralAdminAudience,
				ownerFleetCliClientId: configuration.configuration.ownerFleetCliClientId,
				accessTokenSeconds: configuration.configuration.accessTokenSeconds,
				now: configuration.platform.clock.now,
				inspectSignedToken: (token) => {
					if (decodeProtectedHeader(token).typ !== 'at+jwt')
						throw new Error('Wrong signed access token type');
					return accessTokenReleaseClaimsSchema.parse(decodeJwt(token));
				},
				readAgent: agents.read,
				readWorkspaceResource: workspaceResourcePorts(configuration.store).read,
				isPersonSessionActive: persons.isPersonSessionActive,
				isPersonOrganizationSessionActive: async (personId, sessionId, organizationId) =>
					requireStoredValue(
						await configuration.store.persons.isPersonOrganizationSessionActive(
							personId,
							sessionId,
							organizationId,
						),
					),
				deleteSession: persons.deleteSession,
				cleanupUnboundPerson: persons.cleanupUnboundPerson,
			};
			const response = await handleSignInRequest({
				request,
				providerHandler: provider.handler,
				issuedSessions: state.issuedSessions,
				createdUserIds: state.createdUserIds,
				ports,
			});
			if (response.status === 429)
				return await renderFactorFormResponse({
					request,
					crypto: configuration.platform.crypto,
					resume: factorResume,
					response: providerLimitedResponse({
						response,
						requestClass: admission.requestClass,
						log: configuration.platform.log,
					}),
				});
			const method = /\/callback\/(google|github)$/u.exec(url.pathname)?.[1];
			if (state.loginLink.kind === 'changed') {
				const { change, accountId } = state.loginLink;
				requireStoredValue(await configuration.store.linkedLogins.record(change, 'outcome'));
				const recorded = requireStoredValue(
					await configuration.store.linkedLogins.read(change.requestId),
				);
				const account = requireStoredValue(
					await configuration.store.linkedLogins.readAccount(accountId),
				);
				if (
					account === null ||
					account.userId !== change.personId ||
					account.providerId !== change.provider ||
					recorded.length !== 2 ||
					!['intent', 'outcome'].every((phase) =>
						recorded.some(
							(row) =>
								row.phase === phase &&
								row.actorUserId === change.personId &&
								row.targetId === change.provider,
						),
					)
				)
					throw new Error('Login link outcome could not be confirmed');
			}
			if (method !== undefined && state.loginLink.kind === 'none') {
				const actor = state.issuedSessions[0]?.personId ?? 'anonymous';
				const outcome =
					response.headers.has('set-cookie') && state.issuedSessions.length > 0
						? 'succeeded'
						: 'failed';
				requireStoredValue(
					await configuration.store.bootstrap.recordSignIn({ actor, outcome, method }),
				);
			}
			return await renderFactorFormResponse({
				request,
				response,
				crypto: configuration.platform.crypto,
				resume: factorResume,
			});
		} catch {
			await Promise.allSettled(
				state.issuedSessions.map((session) => persons.deleteSession(session.sessionId)),
			);
			await Promise.allSettled(
				state.createdUserIds.map((personId) => persons.cleanupUnboundPerson(personId)),
			);
			return Response.json(
				{ error: 'sign-in-unavailable' },
				{ status: 503, headers: { 'cache-control': 'no-store' } },
			);
		}
	}
}
