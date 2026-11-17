import {
	createPersonTokenVerifier,
	type PersonProof,
} from '@agent-collaboration/tool-access/contracts';
import type { FetchImplementation } from 'jose';
import type { z } from 'zod';

import type {
	workspaceAgentChangeSchema,
	agentClientChangeSchema,
	RegisterAndLinkResult,
	LinkResult,
	UnlinkResult,
	DisableResult,
	AgentManagementResult,
} from '#sign-in-core/agent-clients/agent-registration';
import { manageAgentClient } from '#sign-in-core/better-auth/agent-client-management';
import { createProviderRequestState } from '#sign-in-core/better-auth/provider-request-state';
import {
	createSignInHttpHandler,
	type SignInHttpConfiguration,
} from '#sign-in-core/better-auth/sign-in-http-handler';
import {
	agentRegistrationPorts,
	personSessionPorts,
} from '#sign-in-core/better-auth/store-result-adapters';

/** Internal named-entrypoint implementation. Public HTTP never dispatches these methods. */
export function createSignInManagementBinding(
	configuration: SignInHttpConfiguration,
	verifierDependencies?: { readonly jwksFetch?: FetchImplementation },
): {
	readonly humanCheckStatus: () => Promise<
		| { readonly kind: 'ready'; readonly level: 'remembered-login' }
		| {
				readonly kind: 'not-implemented';
				readonly level: 'fresh-verified-uv' | 'exact-operation-binding';
		  }
	>;
	readonly isLiveOwner: (props: {
		readonly token: string;
		readonly organizationId: string;
	}) => Promise<boolean>;
	readonly ownsAgentClient: (props: {
		readonly token: string;
		readonly organizationId: string;
		readonly clientId: string;
	}) => Promise<boolean>;
	readonly registerAndLink: (
		props: { readonly token: string } & z.infer<typeof workspaceAgentChangeSchema>,
	) => Promise<RegisterAndLinkResult>;
	readonly link: (
		props: { readonly token: string; readonly clientId: string } & z.infer<
			typeof workspaceAgentChangeSchema
		>,
	) => Promise<LinkResult>;
	readonly unlink: (
		props: { readonly token: string; readonly clientId: string } & z.infer<
			typeof workspaceAgentChangeSchema
		>,
	) => Promise<UnlinkResult>;
	readonly disable: (
		props: { readonly token: string; readonly clientId: string } & z.infer<
			typeof agentClientChangeSchema
		>,
	) => Promise<DisableResult>;
} {
	const publicHandler = createSignInHttpHandler(configuration);
	const verifier = createPersonTokenVerifier({
		deployment: configuration.configuration.issuer,
		audience: configuration.configuration.managementAudience,
		jwksUrl: new URL('/api/auth/jwks', configuration.configuration.issuer),
		now: configuration.platform.clock.now,
		// Verify against the actual public JWKS produced by this deployment's Better Auth database.
		jwksFetch:
			verifierDependencies?.jwksFetch ??
			(async (input, init) => publicHandler(new Request(input, init))),
	});
	const persons = personSessionPorts(configuration.store.persons);
	async function ownerProof(token: string): Promise<PersonProof | null> {
		if (configuration.configuration.managementHumanCheck !== 'remembered-login') return null;
		const result = await verifier.verify(token);
		if (
			result.kind !== 'verified' ||
			(await persons.readOwnerSession(result.proof.subject, result.proof.sessionRef)) === null
		)
			return null;
		return result.proof;
	}
	async function runOperation(token: string, operation: unknown): Promise<AgentManagementResult> {
		if (configuration.configuration.managementHumanCheck !== 'remembered-login')
			return { kind: 'refused', reason: 'human-check-not-implemented' };
		const proof = await ownerProof(token);
		if (proof === null) return { kind: 'refused', reason: 'not-owner' };
		return manageAgentClient({
			provider: { ...configuration, requestState: createProviderRequestState() },
			proof,
			operation,
		});
	}
	return {
		async humanCheckStatus() {
			const level = configuration.configuration.managementHumanCheck;
			return level === 'remembered-login'
				? { kind: 'ready', level }
				: { kind: 'not-implemented', level };
		},
		async isLiveOwner({ token, organizationId }): Promise<boolean> {
			return (
				configuration.configuration.organizationIds.includes(organizationId) &&
				(await ownerProof(token)) !== null
			);
		},
		async ownsAgentClient({ token, organizationId, clientId }): Promise<boolean> {
			if (
				!configuration.configuration.organizationIds.includes(organizationId) ||
				(await ownerProof(token)) === null
			)
				return false;
			return (
				(await agentRegistrationPorts(configuration.store).read(clientId))?.metadata
					.organizationId === organizationId
			);
		},
		async registerAndLink({ token, ...operation }): Promise<RegisterAndLinkResult> {
			const result = await runOperation(token, { ...operation, kind: 'registerAndLink' });
			return result.kind === 'registered' ||
				result.kind === 'incomplete' ||
				result.kind === 'refused'
				? result
				: { kind: 'incomplete', clientId: result.clientId };
		},
		async link({ token, ...operation }): Promise<LinkResult> {
			const result = await runOperation(token, { ...operation, kind: 'link' });
			return result.kind === 'linked' || result.kind === 'incomplete' || result.kind === 'refused'
				? result
				: { kind: 'incomplete', clientId: result.clientId };
		},
		async unlink({ token, ...operation }): Promise<UnlinkResult> {
			const result = await runOperation(token, { ...operation, kind: 'unlink' });
			return result.kind === 'unlinked' || result.kind === 'incomplete' || result.kind === 'refused'
				? result
				: { kind: 'incomplete', clientId: result.clientId };
		},
		async disable({ token, ...operation }): Promise<DisableResult> {
			const result = await runOperation(token, { ...operation, kind: 'disable' });
			return result.kind === 'disabled' || result.kind === 'incomplete' || result.kind === 'refused'
				? result
				: { kind: 'incomplete', clientId: result.clientId };
		},
	};
}
