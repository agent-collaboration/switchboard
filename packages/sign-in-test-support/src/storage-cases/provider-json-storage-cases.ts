import { oauthClient, oauthResource } from '@agent-collaboration/sign-in-core';
import { createSignInProvider } from '@agent-collaboration/sign-in-core/better-auth';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { StorageCaseContext } from '#sign-in-test-support/storage-cases/storage-case-context';
import { storageProviderProperties } from '#sign-in-test-support/storage-cases/storage-provider-fixture';

export async function providerWritesJsonText(context: StorageCaseContext): Promise<unknown> {
	const organizationId = context.platform.ids.nextId();
	const provider = createSignInProvider({
		...storageProviderProperties(context, organizationId),
		authority: { kind: 'public' },
	});
	const actualProvider = await provider.$context;
	const clientId = 'storage-json-agent';
	await actualProvider.adapter.create({
		model: 'oauthClient',
		data: {
			clientId,
			clientSecret: 'test-only-stored-hash',
			grantTypes: ['client_credentials'],
			clientCredentialsScopes: ['tool-portal:agent'],
			redirectUris: [],
			metadata: { kind: 'agent', organizationId },
			tokenEndpointAuthMethod: 'client_secret_basic',
			disabled: false,
			createdAt: new Date(context.platform.clock.now()),
			updatedAt: new Date(context.platform.clock.now()),
		},
	});
	const cells = z
		.array(z.object({ grantTypes: z.string(), redirects: z.string(), metadata: z.string() }))
		.parse(
			await context
				.openDatabase()
				.select({
					grantTypes: sql<string>`json_type(${oauthClient.grantTypes})`,
					redirects: sql<string>`json_type(${oauthClient.redirectUris})`,
					metadata: sql<string>`json_type(${oauthClient.metadata})`,
				})
				.from(oauthClient)
				.where(eq(oauthClient.clientId, clientId)),
		);
	const registration = await context.store.agents.read(clientId);
	return {
		adapter: actualProvider.adapter.id,
		cells,
		registrationKind: registration.kind,
		grantTypes: registration.kind === 'available' ? registration.value?.grantTypes : null,
		metadataMatches:
			registration.kind === 'available' &&
			registration.value?.metadata.organizationId === organizationId,
	};
}

export async function readsManagementResourceAsNonWorkspace(
	context: StorageCaseContext,
): Promise<unknown> {
	const identifier = 'https://storage-portal.invalid/management';
	await context
		.openDatabase()
		.insert(oauthResource)
		.values({
			id: context.platform.ids.nextId(),
			identifier,
			name: 'Management',
			allowedScopes: JSON.stringify(['tool-portal:management']),
			metadata: null,
			customClaims: null,
			createdAt: new Date(context.platform.clock.now()),
			updatedAt: new Date(context.platform.clock.now()),
		});
	return context.store.resources.read(identifier);
}

export async function malformedWorkspaceRecordIsUnavailable(
	context: StorageCaseContext,
): Promise<unknown> {
	const identifier = 'https://storage-portal.invalid/workspaces/malformed/mcp';
	await context
		.openDatabase()
		.insert(oauthResource)
		.values({
			id: context.platform.ids.nextId(),
			identifier,
			name: 'Malformed workspace fixture',
			metadata: '{',
			allowedScopes: JSON.stringify(['tool-portal:agent']),
			customClaims: null,
		});
	return {
		read: await context.store.resources.read(identifier),
		exists: await context.store.resources.exists(identifier),
	};
}

export async function absentWorkspaceRecordIsAbsent(context: StorageCaseContext): Promise<unknown> {
	const identifier = 'https://storage-portal.invalid/workspaces/absent/mcp';
	return {
		read: await context.store.resources.read(identifier),
		exists: await context.store.resources.exists(identifier),
	};
}
