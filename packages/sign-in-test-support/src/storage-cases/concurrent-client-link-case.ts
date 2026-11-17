import {
	oauthClientResource,
	personIdSchema,
	uuid7Schema,
	type SignInStore,
} from '@agent-collaboration/sign-in-core';
import { createProviderRequestState } from '@agent-collaboration/sign-in-core/better-auth';
import {
	createSignInProvider,
	manageAgentClient,
} from '@agent-collaboration/sign-in-core/better-auth';
import {
	personProofSchema,
	workspaceResourceIdentifier,
} from '@agent-collaboration/tool-access/contracts';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import {
	storageCaseOwnerEmail,
	type StorageCaseContext,
} from '#sign-in-test-support/storage-cases/storage-case-context';
import { createStorageMembership } from '#sign-in-test-support/storage-cases/storage-case-utilities';
import { storageProviderProperties } from '#sign-in-test-support/storage-cases/storage-provider-fixture';

/** Store/provider-API integration only: a trusted PersonProof input fixture is outside
 * this case's claim. The real owner/session store, provider APIs and database stay real. */
export async function concurrentFirstClientLinks(context: StorageCaseContext): Promise<unknown> {
	const organizationId = context.platform.ids.nextId();
	const workspaceId = context.platform.ids.nextId();
	const properties = storageProviderProperties(context, organizationId);
	const provider = createSignInProvider({ ...properties, authority: { kind: 'public' } });
	const actualProvider = await provider.$context;
	const owner = z.object({ id: personIdSchema }).parse(
		await actualProvider.adapter.create({
			model: 'user',
			data: { name: 'Storage owner', email: storageCaseOwnerEmail, emailVerified: true },
		}),
	);
	const activeOrganizationId = await createStorageMembership(context, owner.id);
	const admitted = await context.store.persons.ensurePersonActive(owner.id);
	if (admitted.kind !== 'available' || !admitted.value)
		throw new Error('Concurrent-link fixture owner was not bound');
	const sessionToken = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
	const session = z.object({ id: uuid7Schema }).parse(
		await actualProvider.adapter.create({
			model: 'session',
			data: {
				userId: owner.id,
				activeOrganizationId,
				token: sessionToken,
				createdAt: new Date(context.platform.clock.now()),
				updatedAt: new Date(context.platform.clock.now()),
				expiresAt: new Date(context.platform.clock.now() + 300_000),
			},
		}),
	);
	const proof = personProofSchema.parse({
		issuer: properties.configuration.issuer,
		audience: properties.configuration.managementAudience,
		subject: owner.id,
		sessionRef: session.id,
		clientId: properties.configuration.ownerCliClientId,
		expiresAt: Math.floor(context.platform.clock.now() / 1000) + 300,
	});
	const clientId = 'concurrent-link-agent';
	await actualProvider.adapter.create({
		model: 'oauthClient',
		data: {
			clientId,
			clientSecret: 'test-only-stored-hash',
			grantTypes: ['client_credentials'],
			clientCredentialsScopes: ['tool-portal:agent'],
			tokenEndpointAuthMethod: 'client_secret_basic',
			redirectUris: [],
			metadata: { kind: 'agent', organizationId },
			disabled: false,
		},
	});
	const resource = workspaceResourceIdentifier({
		toolPortalOrigin: properties.configuration.toolPortalOrigin,
		workspaceId,
	});
	await actualProvider.adapter.create({
		model: 'oauthResource',
		data: {
			identifier: resource,
			name: 'Concurrent workspace',
			metadata: { kind: 'workspace', organizationId, workspaceId },
			allowedScopes: ['tool-portal:agent'],
			customClaims: null,
			accessTokenTtl: 300,
		},
	});
	const registration = {
		requestId: context.platform.ids.nextId(),
		actorUserId: owner.id,
		clientId,
		change: 'registered',
	} as const;
	await context.store.agents.record(registration, 'intent');
	await context.store.agents.record(registration, 'outcome');
	const overlap = Promise.withResolvers<void>();
	let arrived = 0;
	let released = false;
	const heldStore: SignInStore = {
		...context.store,
		agents: {
			...context.store.agents,
			async read(identifier) {
				const result = await context.store.agents.read(identifier);
				if (
					!released &&
					identifier === clientId &&
					result.kind === 'available' &&
					result.value !== null &&
					!result.value.resourceIds.includes(resource)
				) {
					arrived += 1;
					if (arrived === 2) {
						released = true;
						overlap.resolve();
					}
					await overlap.promise;
				}
				return result;
			},
		},
	};
	const attempts = [context.platform.ids.nextId(), context.platform.ids.nextId()];
	const results = await Promise.all(
		attempts.map((requestId) =>
			manageAgentClient({
				provider: {
					...properties,
					store: heldStore,
					requestState: createProviderRequestState(),
				},
				proof,
				operation: { kind: 'link', requestId, organizationId, workspaceId, clientId },
			}),
		),
	);
	const links = await context
		.openDatabase()
		.select({ resourceId: oauthClientResource.resourceId })
		.from(oauthClientResource)
		.where(eq(oauthClientResource.clientId, clientId));
	return {
		kinds: results.map((result) => result.kind),
		overlappingReads: arrived,
		links: links.map((link) => link.resourceId === resource),
		liveOwner:
			(await context.store.persons.readOwnerSession(owner.id, session.id)).kind === 'available',
	};
}
