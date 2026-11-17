import { oauthClient, oauthClientAssertion } from '@agent-collaboration/sign-in-core';
import { createSignInProvider } from '@agent-collaboration/sign-in-core/better-auth';
import { eq } from 'drizzle-orm';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { z } from 'zod';

import { providerWritesJsonText } from '#sign-in-test-support/storage-cases/provider-json-storage-cases';
import type { StorageCaseContext } from '#sign-in-test-support/storage-cases/storage-case-context';
import { storageProviderProperties } from '#sign-in-test-support/storage-cases/storage-provider-fixture';
import { controlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-sign-in-clock';
import { readStoredUuidInventory } from '#sign-in-test-support/test-fixtures/stored-uuid-inventory';

export async function providerIdentifiersUseUuid7(context: StorageCaseContext): Promise<unknown> {
	await providerWritesJsonText(context);
	const rows = await context
		.openDatabase()
		.select({ id: oauthClient.id, metadata: oauthClient.metadata })
		.from(oauthClient)
		.where(eq(oauthClient.clientId, 'storage-json-agent'));
	const original = z
		.array(z.object({ id: z.uuidv7(), metadata: z.string() }))
		.length(1)
		.parse(rows)[0];
	if (original === undefined) throw new Error('Provider identifier fixture is absent');
	const id = original.id;
	const inventory = await readStoredUuidInventory(context.openDatabase());
	const metadata = JSON.stringify({
		kind: 'agent',
		organizationId: context.platform.ids.nextId(),
		negativeControl: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
	});
	await context
		.openDatabase()
		.update(oauthClient)
		.set({ metadata })
		.where(eq(oauthClient.clientId, 'storage-json-agent'));
	const planted = await readStoredUuidInventory(context.openDatabase());
	await context
		.openDatabase()
		.update(oauthClient)
		.set({ metadata: original.metadata })
		.where(eq(oauthClient.clientId, 'storage-json-agent'));
	return {
		generatorUsed: id !== undefined && context.issuedIds.includes(id),
		hasUuidCells: inventory.uuidValues > 0,
		nonV7Locations: inventory.nonV7Locations,
		plantedLocations: planted.nonV7Locations,
		restoredClean:
			(await readStoredUuidInventory(context.openDatabase())).nonV7Locations.length === 0,
	};
}

export async function providerAssertionDigestRemainsSingleUse(
	context: StorageCaseContext,
): Promise<unknown> {
	const clientId = 'assertion-proof-client';
	const organizationId = context.platform.ids.nextId();
	const provider = createSignInProvider({
		...storageProviderProperties(context, organizationId),
		authority: { kind: 'public' },
		tokenClientId: clientId,
	});
	const actual = await provider.$context;
	const keys = await generateKeyPair('ES256');
	const publicKey = await exportJWK(keys.publicKey);
	await actual.adapter.create({
		model: 'oauthClient',
		data: {
			clientId,
			clientSecret: null,
			tokenEndpointAuthMethod: 'private_key_jwt',
			jwks: JSON.stringify({ keys: [{ ...publicKey, kid: 'assertion-proof-key', alg: 'ES256' }] }),
			redirectUris: [],
			grantTypes: ['client_credentials'],
			clientCredentialsScopes: ['tool-portal:agent'],
			metadata: { kind: 'agent', organizationId },
			disabled: false,
		},
	});
	const jti = context.platform.ids.nextId();
	const issuedAt = Math.floor(controlledSignInClock.now() / 1000);
	const endpoint = 'https://storage-sign-in.invalid/api/auth/oauth2/token';
	const assertion = await new SignJWT({})
		.setProtectedHeader({ alg: 'ES256', kid: 'assertion-proof-key' })
		.setIssuer(clientId)
		.setSubject(clientId)
		.setAudience(endpoint)
		.setJti(jti)
		.setIssuedAt(issuedAt)
		.setExpirationTime(issuedAt + 180)
		.sign(keys.privateKey);
	const digest = new Uint8Array(
		await crypto.subtle.digest(
			'SHA-256',
			new TextEncoder().encode(`private_key_jwt:${clientId}:${jti}`),
		),
	).slice(0, 24);
	const expectedId = btoa(String.fromCodePoint(...digest))
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replaceAll('=', '');
	async function present(): Promise<Response> {
		return provider.handler(
			new Request(endpoint, {
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({
					grant_type: 'client_credentials',
					client_id: clientId,
					scope: 'tool-portal:agent',
					resource: 'https://storage-portal.invalid/management',
					client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
					client_assertion: assertion,
				}),
			}),
		);
	}
	const first = await present();
	const firstBody = z.record(z.string(), z.unknown()).parse(await first.json());
	const firstRows = await context.openDatabase().select().from(oauthClientAssertion);
	const second = await present();
	const secondBody = z.record(z.string(), z.unknown()).parse(await second.json());
	const secondRows = await context.openDatabase().select().from(oauthClientAssertion);
	return {
		firstSpent: firstRows.length === 1,
		derivedDigestKept: firstRows[0]?.id === expectedId,
		replayRefused:
			!second.ok &&
			secondBody['error'] === 'invalid_client' &&
			secondBody['error_description'] === 'client assertion jti has already been used',
		sameKey: secondRows.length === 1 && secondRows[0]?.id === firstRows[0]?.id,
		notUuid: !z.uuid().safeParse(firstRows[0]?.id).success,
		noCredentials: !('access_token' in firstBody) && !('access_token' in secondBody),
	};
}
