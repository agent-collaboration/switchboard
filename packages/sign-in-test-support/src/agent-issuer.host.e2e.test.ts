import * as signInTables from '@agent-collaboration/sign-in-core';
import { and, count, eq, sql as fixtureSql } from 'drizzle-orm';
import { jwtVerify } from 'jose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { expectBasicClientAuthenticationRefusal } from '#sign-in-test-support/test-fixtures/client-authentication-refusal';
import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import { controlledSignInIds } from '#sign-in-test-support/test-fixtures/controlled-sign-in-clock';
import { expectNoIssuedCredentials } from '#sign-in-test-support/test-fixtures/credential-free-refusal';
import { createObservedProofJwks } from '#sign-in-test-support/test-fixtures/jwks-fetch-observation';
import {
	agentAudience,
	organizationOne,
	organizationTwo,
	registeredClientId,
	registrationRequestId,
	startLocalAuthHarness,
	workspaceOne,
	workspaceThree,
} from '#sign-in-test-support/test-fixtures/local-auth-harness';
import { storedRowProjection } from '#sign-in-test-support/test-fixtures/stored-row-projection';

useControlledSignInClock();

let harness: Awaited<ReturnType<typeof startLocalAuthHarness>>;
const registrationSchema = z.strictObject({
	kind: z.literal('registered'),
	clientId: z.string(),
	clientSecret: z.string(),
	workspaceId: z.literal(workspaceOne),
	resource: z.literal(agentAudience),
});

function managementPath(clientId?: string): string {
	return clientId === undefined
		? `/management/workspaces/${workspaceOne}/agents`
		: `/management/organizations/${organizationOne}/agents/${encodeURIComponent(clientId)}`;
}
async function register(owner: string): Promise<z.infer<typeof registrationSchema>> {
	const response = await harness.gateway(managementPath(), {
		method: 'POST',
		headers: { authorization: `Bearer ${owner}`, 'content-type': 'application/json' },
		body: JSON.stringify({ requestId: registrationRequestId, persona: 'operator' }),
	});
	expect(response.status).toBe(200);
	return registrationSchema.parse(await response.json());
}
async function tokenResponse(
	credentials: { readonly clientId: string; readonly clientSecret: string },
	changes: Readonly<Record<string, string>> = {},
): Promise<Response> {
	return harness.auth('/api/auth/oauth2/token', {
		method: 'POST',
		headers: {
			authorization: `Basic ${btoa(`${credentials.clientId}:${credentials.clientSecret}`)}`,
			'content-type': 'application/x-www-form-urlencoded',
		},
		body: new URLSearchParams({
			grant_type: 'client_credentials',
			scope: 'tool-portal:agent',
			resource: agentAudience,
			...changes,
		}),
	});
}
async function accessToken(credentials: {
	readonly clientId: string;
	readonly clientSecret: string;
}): Promise<string> {
	const response = await tokenResponse(credentials);
	expect(response.status).toBe(200);
	return z
		.object({
			access_token: z.string(),
			expires_in: z.number().positive().max(300),
			refresh_token: z.never().optional(),
		})
		.parse(await response.json()).access_token;
}
async function toolCall(token: string, correlation: string, secondHeap = false): Promise<Response> {
	return harness.gateway(
		`/workspaces/${workspaceOne}/mcp`,
		{
			method: 'POST',
			headers: {
				authorization: `Bearer ${token}`,
				'content-type': 'application/json',
				accept: 'application/json, text/event-stream',
				'MCP-Protocol-Version': '2026-07-28',
				'Mcp-Method': 'tools/call',
				'Mcp-Name': 'mcp_portal_call',
			},
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: correlation,
				method: 'tools/call',
				params: {
					_meta: {
						'io.modelcontextprotocol/protocolVersion': '2026-07-28',
						'io.modelcontextprotocol/clientCapabilities': {},
					},
					name: 'mcp_portal_call',
					arguments: {
						calls: [
							{
								id: correlation,
								namespace: 'proof-upstream',
								toolName: 'record_effect',
								arguments: { correlation },
							},
						],
					},
				},
			}),
		},
		secondHeap,
	);
}

it.each([
	{ scenario: 'a verified non-owner', email: 'first-arrival@example.invalid', verified: true },
	{ scenario: 'an unverified configured owner', email: 'owner@example.invalid', verified: false },
])(
	'bootstrap: refuses $scenario first arrival before admitting the configured owner',
	async ({ email, verified }: { readonly email: string; readonly verified: boolean }) => {
		const emptyDeployment = await startLocalAuthHarness();
		try {
			// Arrange: real migrations and usable public keys, with no admitted Person or native client.
			const jwks = await emptyDeployment.auth('/api/auth/jwks');
			expect(jwks.status).toBe(200);
			z.object({ keys: z.array(z.object({ kid: z.string(), kty: z.string() })).min(1) }).parse(
				await jwks.json(),
			);
			async function identityRows(): Promise<readonly unknown[]> {
				const database = emptyDeployment.database;
				return Promise.all([
					database.select({ id: signInTables.user.id }).from(signInTables.user),
					database.select({ id: signInTables.account.id }).from(signInTables.account),
					database.select({ id: signInTables.session.id }).from(signInTables.session),
					database
						.select({ user_id: signInTables.member.userId })
						.from(signInTables.member)
						.where(eq(signInTables.member.role, 'owner')),
					database
						.select({ clientId: signInTables.oauthClient.clientId })
						.from(signInTables.oauthClient),
					database.select({ id: signInTables.organization.id }).from(signInTables.organization),
				]);
			}
			expect(await identityRows()).toEqual([[], [], [], [], [], []]);
			// Act/Assert: provider protocol stays real; a rejected first arrival leaves no identity authority.
			await expect(emptyDeployment.personToken(email, verified)).rejects.toThrow();
			expect(await identityRows()).toEqual([[], [], [], [], [], []]);
			expect(emptyDeployment.effects).toHaveLength(0);
			// An allowed later arrival must still complete the delivered CLI and become the sole owner.
			const owner = await emptyDeployment.ownerToken();
			const signed = await jwtVerify(
				owner,
				createObservedProofJwks(new URL('/api/auth/jwks', emptyDeployment.issuer)),
				{
					issuer: emptyDeployment.issuer,
					audience: emptyDeployment.target.managementAudience,
				},
			);
			const personId = z.string().parse(signed.payload.sub);
			expect(
				await emptyDeployment.database
					.select({ user_id: fixtureSql`${signInTables.member.userId}` })
					.from(signInTables.member)
					.where(eq(signInTables.member.role, 'owner')),
			).toEqual([{ user_id: personId }]);
			expect(
				await emptyDeployment.database
					.select({
						email: fixtureSql`${signInTables.user.email}`,
						person_id: fixtureSql`${signInTables.member.userId}`,
					})
					.from(signInTables.member)
					.innerJoin(signInTables.user, eq(signInTables.user.id, signInTables.member.userId))
					.where(eq(signInTables.member.role, 'owner')),
			).toEqual([{ email: 'owner@example.invalid', person_id: personId }]);
			// The owner's bootstrap creates exactly its three system clients (B2 adds the admin page's and the fleet CLI's).
			expect(
				(
					await emptyDeployment.database
						.select({ clientId: fixtureSql`${signInTables.oauthClient.clientId}` })
						.from(signInTables.oauthClient)
				).toSorted((left, right) => String(left.clientId).localeCompare(String(right.clientId))),
			).toEqual([
				{ clientId: 'admin-page-local' },
				{ clientId: emptyDeployment.target.ownerCliClientId },
				{ clientId: 'owner-fleet-cli-local' },
			]);
		} finally {
			await emptyDeployment.close();
		}
	},
);

// T3 observes actual local storage and protocol effects. External Google is controlled; hosted login/CPU are unverified.
describe('S1 real agent issuer through the Gateway', () => {
	beforeEach(async () => {
		harness = await startLocalAuthHarness();
	});
	afterEach(async () => {
		await harness?.close();
	});
	it('bootstrap: native S256 loopback creates the fixed owner client once with real owner cookie and audit', async () => {
		const token = await harness.ownerToken();
		const verified = await jwtVerify(
			token,
			createObservedProofJwks(new URL('/api/auth/jwks', harness.issuer)),
			{ issuer: harness.issuer, audience: harness.target.managementAudience },
		);
		const person = z
			.object({
				sub: z.string(),
				sid: z.string(),
				iat: z.number(),
				exp: z.number(),
				aud: z.literal(harness.target.managementAudience),
				client_id: z.literal(harness.target.ownerCliClientId),
			})
			.parse(verified.payload);
		expect(verified.protectedHeader.typ).toBe('at+jwt');
		expect(person.exp - person.iat).toBeLessThanOrEqual(300);
		expect(
			await harness.database
				.select({ user_id: fixtureSql`${signInTables.member.userId}` })
				.from(signInTables.member)
				.where(eq(signInTables.member.role, 'owner')),
		).toEqual([{ user_id: person.sub }]);
		expect(
			await harness.database
				.select({
					id: fixtureSql`${signInTables.session.id}`,
					userId: fixtureSql`${signInTables.session.userId}`,
				})
				.from(signInTables.session)
				.where(eq(signInTables.session.id, person.sid))
				.limit(1)
				.then((storedRows) => storedRows[0] ?? null),
		).toEqual({ id: person.sid, userId: person.sub });
		const client = z
			.object({
				clientId: z.literal(harness.target.ownerCliClientId),
				clientSecret: z.null(),
				tokenEndpointAuthMethod: z.literal('none'),
				applicationType: z.literal('native'),
				grantTypes: z.string(),
				responseTypes: z.string(),
				redirectUris: z.string(),
				scopes: z.string(),
				requirePKCE: z.literal(1),
			})
			.parse(
				await harness.database
					.select(storedRowProjection(signInTables.oauthClient))
					.from(signInTables.oauthClient)
					.where(eq(signInTables.oauthClient.clientId, harness.target.ownerCliClientId))
					.limit(1)
					.then((storedRows) => storedRows[0] ?? null),
			);
		expect(JSON.parse(client.grantTypes)).toEqual(['authorization_code']);
		expect(JSON.parse(client.responseTypes)).toEqual(['code']);
		expect(JSON.parse(client.redirectUris)).toEqual([harness.target.ownerCliRedirectUri]);
		expect(JSON.parse(client.scopes)).toEqual(['tool-portal:management']);
		expect(
			await harness.database
				.select({ resourceId: fixtureSql`${signInTables.oauthClientResource.resourceId}` })
				.from(signInTables.oauthClientResource)
				.where(eq(signInTables.oauthClientResource.clientId, client.clientId)),
		).toEqual([{ resourceId: harness.target.managementAudience }]);
		expect(
			await harness.database
				.select({
					phase: fixtureSql`${signInTables.signInAudit.phase}`,
					actor_user_id: fixtureSql`${signInTables.signInAudit.actorUserId}`,
				})
				.from(signInTables.signInAudit)
				.where(eq(signInTables.signInAudit.requestId, `owner-cli:${client.clientId}`))
				.orderBy(signInTables.signInAudit.phase),
		).toEqual([
			{ phase: 'intent', actor_user_id: person.sub },
			{ phase: 'outcome', actor_user_id: person.sub },
		]);
		expect(
			await harness.database
				.select({ id: fixtureSql`${signInTables.oauthRefreshToken.id}` })
				.from(signInTables.oauthRefreshToken),
		).toHaveLength(0);
		async function protectedBootstrapRows(): Promise<unknown> {
			const queryResults = await Promise.all([
				harness.database
					.select(storedRowProjection(signInTables.oauthClient))
					.from(signInTables.oauthClient)
					.orderBy(signInTables.oauthClient.clientId),
				harness.database
					.select(storedRowProjection(signInTables.oauthClientResource))
					.from(signInTables.oauthClientResource)
					.orderBy(
						signInTables.oauthClientResource.clientId,
						signInTables.oauthClientResource.resourceId,
					),
				harness.database
					.select(storedRowProjection(signInTables.member))
					.from(signInTables.member)
					.where(eq(signInTables.member.role, 'owner')),
			]);
			return queryResults.map((queryResult) => queryResult);
		}
		const before = await protectedBootstrapRows();
		const repeated = await harness.auth('/api/auth/owner/bootstrap', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{}',
		});
		if (!repeated.ok) {
			const diagnostics = z
				.object({
					driverFailures: z.array(
						z.object({
							operation: z.string(),
							table: z.string(),
							reason: z.enum(['unique-key', 'other-database-error']),
						}),
					),
				})
				.parse(await (await harness.auth('/__auth-proof/database-control')).json());
			process.stderr.write(
				JSON.stringify({ event: 'repeat-bootstrap-diagnostic', ...diagnostics }) + '\n',
			);
		}
		expect(repeated.status).toBe(200);
		expect(await protectedBootstrapRows()).toEqual(before);
		const denied = await harness.auth('/api/auth/owner/bootstrap', {
			method: 'POST',
			headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
			body: '{}',
		});
		expect(denied.status).toBe(403);
		expect(await protectedBootstrapRows()).toEqual(before);
	});
	it('agent: real HTTP registration, token and JWKS authorize exactly one O1 effect and zero O2 effects', async () => {
		const owner = await harness.ownerToken();
		const credentials = await register(owner);
		expect(credentials.clientId).toBe(registeredClientId);
		const rows = await harness.database
			.select({
				clientId: fixtureSql`${signInTables.oauthClient.clientId}`,
				grantTypes: fixtureSql`${signInTables.oauthClient.grantTypes}`,
				clientCredentialsScopes: fixtureSql`${signInTables.oauthClient.clientCredentialsScopes}`,
				metadata: fixtureSql`${signInTables.oauthClient.metadata}`,
				tokenEndpointAuthMethod: fixtureSql`${signInTables.oauthClient.tokenEndpointAuthMethod}`,
			})
			.from(signInTables.oauthClient)
			.where(eq(signInTables.oauthClient.clientId, credentials.clientId))
			.limit(1)
			.then((storedRows) => storedRows[0] ?? null);
		expect(rows).toMatchObject({
			clientId: registeredClientId,
			grantTypes: '["client_credentials"]',
			clientCredentialsScopes: '["tool-portal:agent"]',
			metadata: JSON.stringify({ kind: 'agent', organizationId: organizationOne }),
			tokenEndpointAuthMethod: 'client_secret_basic',
		});
		expect(
			await harness.database
				.select({ resourceId: fixtureSql`${signInTables.oauthClientResource.resourceId}` })
				.from(signInTables.oauthClientResource)
				.where(eq(signInTables.oauthClientResource.clientId, credentials.clientId)),
		).toEqual([{ resourceId: agentAudience }]);
		expect(
			await harness.database
				.select({ phase: fixtureSql`${signInTables.signInAudit.phase}` })
				.from(signInTables.signInAudit)
				.where(
					and(
						eq(signInTables.signInAudit.requestId, registrationRequestId),
						eq(signInTables.signInAudit.kind, 'client-changed'),
						eq(signInTables.signInAudit.changeKind, 'registered'),
					),
				)
				.orderBy(signInTables.signInAudit.phase),
		).toEqual([{ phase: 'intent' }, { phase: 'outcome' }]);
		const proof = await accessToken(credentials);
		const signed = await jwtVerify(
			proof,
			createObservedProofJwks(new URL('/api/auth/jwks', harness.issuer)),
			{
				issuer: harness.issuer,
				audience: agentAudience,
			},
		);
		const claims = z
			.object({
				sub: z.literal(registeredClientId),
				client_id: z.literal(registeredClientId),
				azp: z.literal(registeredClientId),
				aud: z.literal(agentAudience),
				organization_id: z.literal(organizationOne),
				workspace_id: z.literal(workspaceOne),
				scope: z.literal('tool-portal:agent'),
				iat: z.number(),
				exp: z.number(),
			})
			.parse(signed.payload);
		expect(signed.protectedHeader.typ).toBe('at+jwt');
		expect(Object.hasOwn(signed.payload, 'sid')).toBe(false);
		expect(claims.exp - claims.iat).toBeLessThanOrEqual(300);
		const before = harness.effects.length;
		const correlation = controlledSignInIds.nextId();
		expect((await toolCall(proof, correlation)).status).toBe(200);
		expect(harness.effects.slice(before)).toEqual([
			{ credential: 'Bearer organization-one-canary', arguments: { correlation } },
		]);
		expect(
			harness.effects.filter((effect) => effect.credential === 'Bearer organization-two-canary'),
		).toHaveLength(0);
		expect(
			await (
				await harness.gateway(
					`/__auth-proof?workspace=${workspaceOne}&client=${registeredClientId}`,
				)
			).json(),
		).toMatchObject({ [`member:${registeredClientId}`]: { state: 'member', persona: 'operator' } });
		async function foreignTargetState(): Promise<unknown> {
			return {
				client: await harness.database
					.select(storedRowProjection(signInTables.oauthClient))
					.from(signInTables.oauthClient)
					.where(eq(signInTables.oauthClient.clientId, registeredClientId))
					.limit(1)
					.then((storedRows) => storedRows[0] ?? null),
				resources: await harness.database
					.select(storedRowProjection(signInTables.oauthClientResource))
					.from(signInTables.oauthClientResource)
					.where(eq(signInTables.oauthClientResource.clientId, registeredClientId))
					.orderBy(signInTables.oauthClientResource.resourceId),
				admission: await Promise.all(
					[workspaceOne, workspaceThree].map(async (workspaceId: string): Promise<unknown> =>
						(
							await harness.gateway(
								`/__auth-proof?workspace=${workspaceId}&client=${registeredClientId}`,
							)
						).json(),
					),
				),
			};
		}
		const protectedBeforeForeign = await foreignTargetState();
		const effectsBeforeForeign = [...harness.effects];
		const foreign = await harness.gateway(
			`/management/organizations/${organizationTwo}/agents/${registeredClientId}`,
			{
				method: 'DELETE',
				headers: { authorization: `Bearer ${owner}`, 'content-type': 'application/json' },
				body: JSON.stringify({ requestId: controlledSignInIds.nextId() }),
			},
		);
		expect(foreign.status).toBe(403);
		expectNoIssuedCredentials(await foreign.json());
		expect(await foreignTargetState()).toEqual(protectedBeforeForeign);
		expect(harness.effects).toEqual(effectsBeforeForeign);
	});
	it('agent: wrong grant, resource and dynamic registration never return a token or client', async () => {
		const credentials = await register(await harness.ownerToken());
		const codesBefore = await harness.database
			.select({ count: count() })
			.from(signInTables.verification)
			.where(
				and(
					fixtureSql`json_valid(${signInTables.verification.value})`,
					fixtureSql`json_extract(${signInTables.verification.value}, '$.type') = ${'authorization_code'}`,
				),
			)
			.limit(1)
			.then((storedRows) => storedRows[0] ?? null);
		const authorization = new URL('/api/auth/oauth2/authorize', harness.issuer);
		authorization.search = new URLSearchParams({
			client_id: credentials.clientId,
			response_type: 'code',
			redirect_uri: harness.target.ownerCliRedirectUri,
			scope: 'tool-portal:agent',
			resource: agentAudience,
			code_challenge: 'a'.repeat(43),
			code_challenge_method: 'S256',
			state: controlledSignInIds.nextId(),
		}).toString();
		const forbiddenCode = await harness.auth(authorization.toString(), {
			headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate' },
		});
		expect(forbiddenCode.status).toBe(302);
		const refusedAuthorization = new URL(
			z.string().parse(forbiddenCode.headers.get('location')),
			harness.issuer,
		);
		expect(refusedAuthorization.searchParams.get('error')).toBe('unauthorized_client');
		expect(refusedAuthorization.searchParams.has('code')).toBe(false);
		expect(
			await harness.database
				.select({ count: count() })
				.from(signInTables.verification)
				.where(
					and(
						fixtureSql`json_valid(${signInTables.verification.value})`,
						fixtureSql`json_extract(${signInTables.verification.value}, '$.type') = ${'authorization_code'}`,
					),
				)
				.limit(1)
				.then((storedRows) => storedRows[0] ?? null),
		).toEqual(codesBefore);
		const denied = await Promise.all(
			[
				{ grant_type: 'refresh_token', refresh_token: 'unknown' },
				{ grant_type: 'authorization_code', code: 'unknown' },
				{ resource: 'https://other.invalid/mcp' },
			].map((changes) => tokenResponse(credentials, changes)),
		);
		expect(denied.every((response) => !response.ok)).toBe(true);
		const deniedBodies: unknown[] = await Promise.all(
			denied.map((response: Response): Promise<unknown> => response.json()),
		);
		for (const body of deniedBodies) expectNoIssuedCredentials(body);
		expect(deniedBodies[2]).toMatchObject({ error: 'invalid_target' });
		const clientsBeforeDynamic = await harness.database
			.select(storedRowProjection(signInTables.oauthClient))
			.from(signInTables.oauthClient)
			.orderBy(signInTables.oauthClient.clientId);
		const dynamic = await harness.auth('/api/auth/oauth2/register', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				client_name: 'forbidden',
				grant_types: ['authorization_code'],
				response_types: ['code'],
				redirect_uris: [harness.target.ownerCliRedirectUri],
				token_endpoint_auth_method: 'none',
				application_type: 'native',
			}),
		});
		const clientsAfterDynamic = await harness.database
			.select(storedRowProjection(signInTables.oauthClient))
			.from(signInTables.oauthClient)
			.orderBy(signInTables.oauthClient.clientId);
		expect(clientsAfterDynamic).toEqual(clientsBeforeDynamic);
		expect(clientsAfterDynamic).toHaveLength(clientsBeforeDynamic.length);
		expect(dynamic.ok).toBe(false);
		expectNoIssuedCredentials(await dynamic.json());
	});
	it('agent: failed disable keeps admission removed in two warm Gateway heaps and a later owner request completes it', async () => {
		const owner = await harness.ownerToken();
		const credentials = await register(owner);
		const proof = await accessToken(credentials);
		await toolCall(proof, 'warm-one');
		await toolCall(proof, 'warm-two', true);
		await harness.setDatabaseFault({
			operation: 'update',
			table: 'oauthClient',
			key: registeredClientId,
			column: 'disabled',
		});
		try {
			const removal = await harness.gateway(managementPath(registeredClientId), {
				method: 'DELETE',
				headers: { authorization: `Bearer ${owner}`, 'content-type': 'application/json' },
				body: JSON.stringify({ requestId: controlledSignInIds.nextId() }),
			});
			expect(removal.status).toBe(202);
			const effectsBeforeDisable = harness.effects.length;
			expect((await toolCall(proof, 'removed-one')).status).toBe(401);
			expect((await toolCall(proof, 'removed-two', true)).status).toBe(401);
			expect(harness.effects).toHaveLength(effectsBeforeDisable);
			expect((await tokenResponse(credentials)).status).toBe(200);
		} finally {
			await harness.setDatabaseFault(null);
		}
		const completed = await harness.gateway(managementPath(registeredClientId), {
			headers: { authorization: `Bearer ${owner}` },
		});
		expect(await completed.json()).toEqual({ kind: 'removed', clientId: registeredClientId });
		await expectBasicClientAuthenticationRefusal(await tokenResponse(credentials));
		expect(
			await (
				await harness.gateway(
					`/__auth-proof?workspace=${workspaceOne}&client=${registeredClientId}`,
				)
			).json(),
		).toMatchObject({
			[`member:${registeredClientId}`]: { state: 'removed', persona: 'operator' },
			[`member-removal:${registeredClientId}`]: { kind: 'complete' },
		});
	});
});
