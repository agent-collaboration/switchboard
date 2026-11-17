import * as signInTables from '@agent-collaboration/sign-in-core';
import { and, eq, sql as fixtureSql } from 'drizzle-orm';
import { jwtVerify } from 'jose';
import { expect, it } from 'vitest';
import { z } from 'zod';

import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import {
	controlledSignInClock,
	controlledSignInIds,
} from '#sign-in-test-support/test-fixtures/controlled-sign-in-clock';
import { expectNoIssuedCredentials } from '#sign-in-test-support/test-fixtures/credential-free-refusal';
import { createObservedProofJwks } from '#sign-in-test-support/test-fixtures/jwks-fetch-observation';
import {
	organizationOne,
	organizationTwo,
	registeredClientId,
	registrationRequestId,
	startLocalAuthHarness,
	workspaceAudience,
	workspaceOne,
	workspaceThree,
	workspaceTwo,
} from '#sign-in-test-support/test-fixtures/local-auth-harness';
import { storedRowProjection } from '#sign-in-test-support/test-fixtures/stored-row-projection';
import {
	addWorkspaceAgent,
	agentCredentialSchema,
	callWorkspaceTool,
	workspaceToken,
	workspaceTokenResponse,
} from '#sign-in-test-support/test-fixtures/workspace-agent-proof';
import {
	readWorkspaceClientState,
	readStoredClientCredential,
} from '#sign-in-test-support/test-fixtures/workspace-client-readbacks';

useControlledSignInClock();

it('agent: one real issuer client keeps two workspace links, removes only W1, and retires without unlinking W2', async () => {
	const harness = await startLocalAuthHarness();
	try {
		const owner = await harness.ownerToken();
		const registered = await addWorkspaceAgent({
			harness,
			owner,
			workspaceId: workspaceOne,
			requestId: registrationRequestId,
		});
		expect(registered.status).toBe(200);
		const registration: unknown = await registered.json();
		expect(registration).toMatchObject({
			kind: 'registered',
			clientId: registeredClientId,
			workspaceId: workspaceOne,
			resource: workspaceAudience(workspaceOne),
		});
		const credential = agentCredentialSchema.parse(registration);
		const secretBeforeLink = await readStoredClientCredential(
			harness.database,
			credential.clientId,
		);
		const linked = await addWorkspaceAgent({
			harness,
			owner,
			workspaceId: workspaceTwo,
			requestId: controlledSignInIds.nextId(),
			clientId: credential.clientId,
		});
		expect(linked.status).toBe(200);
		const linkResult: unknown = await linked.json();
		expect(linkResult).toEqual({
			kind: 'linked',
			clientId: credential.clientId,
			workspaceId: workspaceTwo,
			resource: workspaceAudience(workspaceTwo),
		});
		// A link result identifies the existing client; it must not carry a secret or token.
		expect(linkResult).not.toHaveProperty('clientSecret');
		expect(linkResult).not.toHaveProperty('client_secret');
		expect(linkResult).not.toHaveProperty('access_token');
		expect(await readStoredClientCredential(harness.database, credential.clientId)).toEqual(
			secretBeforeLink,
		);
		const links = async (): Promise<unknown> =>
			await harness.database
				.select({ resourceId: fixtureSql`${signInTables.oauthClientResource.resourceId}` })
				.from(signInTables.oauthClientResource)
				.where(eq(signInTables.oauthClientResource.clientId, credential.clientId))
				.orderBy(signInTables.oauthClientResource.resourceId);
		expect(await links()).toEqual(
			[workspaceOne, workspaceTwo].map((workspaceId) => ({
				resourceId: workspaceAudience(workspaceId),
			})),
		);
		await Promise.all(
			[workspaceOne, workspaceTwo].map(async (workspaceId): Promise<void> => {
				const resource = await harness.database
					.select({
						identifier: fixtureSql`${signInTables.oauthResource.identifier}`,
						metadata: fixtureSql`${signInTables.oauthResource.metadata}`,
						allowedScopes: fixtureSql`${signInTables.oauthResource.allowedScopes}`,
						customClaims: fixtureSql`${signInTables.oauthResource.customClaims}`,
					})
					.from(signInTables.oauthResource)
					.where(eq(signInTables.oauthResource.identifier, workspaceAudience(workspaceId)))
					.limit(1)
					.then((storedRows) => storedRows[0] ?? null);
				expect(resource).toMatchObject({
					identifier: workspaceAudience(workspaceId),
					metadata: JSON.stringify({
						kind: 'workspace',
						organizationId: organizationOne,
						workspaceId,
					}),
					allowedScopes: '["tool-portal:agent"]',
				});
				const customClaimsColumn = z
					.object({ customClaims: z.string().nullable() })
					.parse(resource).customClaims;
				// Better Auth's SQLite adapter JSON-encodes this field, including logical null.
				const customClaims: unknown =
					customClaimsColumn === null ? null : JSON.parse(customClaimsColumn);
				expect(customClaims).toBeNull();
			}),
		);
		const jwks = createObservedProofJwks(new URL('/api/auth/jwks', harness.issuer));
		const w1 = await workspaceToken({ harness, credential, workspaceId: workspaceOne });
		const w2 = await workspaceToken({ harness, credential, workspaceId: workspaceTwo });
		await Promise.all(
			[
				{ token: w1, workspaceId: workspaceOne },
				{ token: w2, workspaceId: workspaceTwo },
			].map(async ({ token, workspaceId }): Promise<void> => {
				const signed = await jwtVerify(token, jwks, {
					issuer: harness.issuer,
					audience: workspaceAudience(workspaceId),
				});
				expect(signed.payload).toMatchObject({
					sub: credential.clientId,
					client_id: credential.clientId,
					organization_id: organizationOne,
					workspace_id: workspaceId,
					aud: workspaceAudience(workspaceId),
				});
				expect(signed.protectedHeader.typ).toBe('at+jwt');
				expect(signed.payload).not.toHaveProperty('sid');
			}),
		);
		const before = harness.effects.length;
		expect(
			(
				await callWorkspaceTool({
					harness,
					workspaceId: workspaceOne,
					token: w1,
					correlation: 'wcut-w1',
				})
			).status,
		).toBe(200);
		expect(
			(
				await callWorkspaceTool({
					harness,
					workspaceId: workspaceTwo,
					token: w2,
					correlation: 'wcut-w2',
				})
			).status,
		).toBe(200);
		expect(harness.effects.slice(before)).toEqual([
			{ credential: 'Bearer organization-one-canary', arguments: { correlation: 'wcut-w1' } },
			{ credential: 'Bearer workspace-two-canary', arguments: { correlation: 'wcut-w2' } },
		]);
		const effectsBeforeCross = [...harness.effects];
		expect(
			(
				await callWorkspaceTool({
					harness,
					workspaceId: workspaceTwo,
					token: w1,
					correlation: 'cross-w1-w2',
				})
			).status,
		).toBe(401);
		expect(
			(
				await callWorkspaceTool({
					harness,
					workspaceId: workspaceThree,
					token: w1,
					correlation: 'cross-w1-w3',
				})
			).status,
		).toBe(401);
		expect(harness.effects).toEqual(effectsBeforeCross);
		async function protectedWorkspaceState(): Promise<unknown> {
			return readWorkspaceClientState(harness, credential.clientId, [
				workspaceOne,
				workspaceTwo,
				workspaceThree,
			]);
		}
		const beforeForeign = await protectedWorkspaceState();
		const beforeForeignEffects = [...harness.effects];
		const foreign = await addWorkspaceAgent({
			harness,
			owner,
			workspaceId: workspaceThree,
			requestId: controlledSignInIds.nextId(),
			clientId: credential.clientId,
		});
		expect(foreign.status).toBe(403);
		expectNoIssuedCredentials(await foreign.json());
		expect(await protectedWorkspaceState()).toEqual(beforeForeign);
		expect(harness.effects).toEqual(beforeForeignEffects);
		const foreignToken = await workspaceTokenResponse({
			harness,
			credential,
			workspaceId: workspaceThree,
		});
		expect(foreignToken.status).toBe(400);
		const foreignTokenBody: unknown = await foreignToken.json();
		expect(foreignTokenBody).toMatchObject({ error: 'invalid_target' });
		expectNoIssuedCredentials(foreignTokenBody);
		const unlinkRequestId = controlledSignInIds.nextId();
		const removed = await harness.gateway(
			`/management/workspaces/${workspaceOne}/agents/${credential.clientId}`,
			{
				method: 'DELETE',
				headers: { authorization: `Bearer ${owner}`, 'content-type': 'application/json' },
				body: JSON.stringify({ requestId: unlinkRequestId }),
			},
		);
		expect(await removed.json()).toEqual({
			kind: 'removed',
			clientId: credential.clientId,
			workspaceId: workspaceOne,
		});
		const beforeRemovedW1Call = [...harness.effects];
		expect(
			(
				await callWorkspaceTool({
					harness,
					workspaceId: workspaceOne,
					token: w1,
					correlation: 'removed-w1',
				})
			).status,
		).toBe(401);
		expect(
			await (
				await workspaceTokenResponse({ harness, credential, workspaceId: workspaceOne })
			).json(),
		).toMatchObject({ error: 'invalid_target' });
		expect(harness.effects).toEqual(beforeRemovedW1Call);
		const newW2 = await workspaceToken({ harness, credential, workspaceId: workspaceTwo });
		expect(
			(
				await callWorkspaceTool({
					harness,
					workspaceId: workspaceTwo,
					token: newW2,
					correlation: 'new-w2-after-w1',
				})
			).status,
		).toBe(200);
		expect(harness.effects.slice(beforeRemovedW1Call.length)).toEqual([
			{
				credential: 'Bearer workspace-two-canary',
				arguments: { correlation: 'new-w2-after-w1' },
			},
		]);
		expect(await links()).toEqual([{ resourceId: workspaceAudience(workspaceTwo) }]);
		const afterUnlinkMembership = await Promise.all(
			[workspaceOne, workspaceTwo].map(async (workspaceId): Promise<unknown> =>
				(
					await harness.gateway(
						`/__auth-proof?workspace=${workspaceId}&client=${credential.clientId}`,
					)
				).json(),
			),
		);
		expect(afterUnlinkMembership).toEqual([
			{
				[`member:${credential.clientId}`]: { state: 'removed', persona: 'operator' },
				[`member-removal:${credential.clientId}`]: {
					kind: 'complete',
					operation: 'unlink',
					requestId: unlinkRequestId,
				},
			},
			{ [`member:${credential.clientId}`]: { state: 'member', persona: 'operator' } },
		]);

		expect(
			await harness.database
				.select({ disabled: fixtureSql`coalesce(${signInTables.oauthClient.disabled}, ${0})` })
				.from(signInTables.oauthClient)
				.where(eq(signInTables.oauthClient.clientId, credential.clientId))
				.limit(1)
				.then((storedRows) => storedRows[0] ?? null),
		).toMatchObject({ disabled: 0 });
		const retired = await harness.gateway(
			`/management/organizations/${organizationOne}/agents/${credential.clientId}`,
			{
				method: 'DELETE',
				headers: { authorization: `Bearer ${owner}`, 'content-type': 'application/json' },
				body: JSON.stringify({ requestId: controlledSignInIds.nextId() }),
			},
		);
		expect(await retired.json()).toEqual({ kind: 'removed', clientId: credential.clientId });
		const beforeRetiredCalls = [...harness.effects];
		expect(
			(
				await callWorkspaceTool({
					harness,
					workspaceId: workspaceTwo,
					token: newW2,
					correlation: 'retired-w2',
				})
			).status,
		).toBe(401);
		expect(
			await (
				await workspaceTokenResponse({ harness, credential, workspaceId: workspaceTwo })
			).json(),
		).toMatchObject({ error: 'invalid_client' });
		expect(harness.effects).toEqual(beforeRetiredCalls);
		// Global retirement disables without unlinking: W2's E11 remains a historical link.
		expect(await links()).toEqual([{ resourceId: workspaceAudience(workspaceTwo) }]);
		const changes = await harness.database
			.select({ phase: fixtureSql`${signInTables.signInAudit.phase}` })
			.from(signInTables.signInAudit)
			.where(
				and(
					eq(signInTables.signInAudit.kind, 'client-link-changed'),
					eq(signInTables.signInAudit.changeKind, 'unlinked'),
				),
			)
			.orderBy(signInTables.signInAudit.phase);
		expect(changes).toEqual([{ phase: 'intent' }, { phase: 'outcome' }]);
	} finally {
		await harness.close();
	}
});

it('agent: a real zero-link client can be disabled through the named port without a workspace field', async () => {
	const harness = await startLocalAuthHarness();
	try {
		const owner = await harness.ownerToken();
		const binding = { SIGN_IN: await harness.signInManagement() };
		const registration = await addWorkspaceAgent({
			harness,
			owner,
			workspaceId: workspaceOne,
			requestId: registrationRequestId,
		});
		expect(registration.status).toBe(200);
		const registered = agentCredentialSchema
			.extend({
				kind: z.literal('registered'),
				workspaceId: z.literal(workspaceOne),
				resource: z.literal(workspaceAudience(workspaceOne)),
			})
			.strict()
			.parse(await registration.json());
		const unlinked = await harness.gateway(
			`/management/workspaces/${workspaceOne}/agents/${registered.clientId}`,
			{
				method: 'DELETE',
				headers: { authorization: `Bearer ${owner}`, 'content-type': 'application/json' },
				body: JSON.stringify({ requestId: controlledSignInIds.nextId() }),
			},
		);
		expect(unlinked.status).toBe(200);
		expect(await unlinked.json()).toEqual({
			kind: 'removed',
			clientId: registered.clientId,
			workspaceId: workspaceOne,
		});
		expect(
			await harness.database
				.select(storedRowProjection(signInTables.oauthClientResource))
				.from(signInTables.oauthClientResource)
				.where(eq(signInTables.oauthClientResource.clientId, registered.clientId)),
		).toEqual([]);
		expect(
			await binding.SIGN_IN.ownsAgentClient({
				token: owner,
				organizationId: organizationOne,
				clientId: registered.clientId,
			}),
		).toBe(true);
		// The organization route calls real disable without a workspace field, even with no links.
		const disabled = await harness.gateway(
			`/management/organizations/${organizationOne}/agents/${registered.clientId}`,
			{
				method: 'DELETE',
				headers: { authorization: `Bearer ${owner}`, 'content-type': 'application/json' },
				body: JSON.stringify({ requestId: controlledSignInIds.nextId() }),
			},
		);
		expect(disabled.status).toBe(200);
		expect(await disabled.json()).toEqual({ kind: 'removed', clientId: registered.clientId });
		expect(
			await harness.database
				.select({ disabled: fixtureSql`coalesce(${signInTables.oauthClient.disabled}, ${0})` })
				.from(signInTables.oauthClient)
				.where(eq(signInTables.oauthClient.clientId, registered.clientId))
				.limit(1)
				.then((storedRows) => storedRows[0] ?? null),
		).toMatchObject({ disabled: 1 });
	} finally {
		await harness.close();
	}
});

it('agent: a forced cross-organization resource link is refused before signing', async () => {
	const harness = await startLocalAuthHarness();
	try {
		const owner = await harness.ownerToken();
		const registration = await addWorkspaceAgent({
			harness,
			owner,
			workspaceId: workspaceOne,
			requestId: registrationRequestId,
		});
		expect(registration.status).toBe(200);
		const credential = agentCredentialSchema.parse(await registration.json());
		const foreignRegistration = await addWorkspaceAgent({
			harness,
			owner,
			workspaceId: workspaceThree,
			requestId: controlledSignInIds.nextId(),
		});
		expect(foreignRegistration.status).toBe(200);
		await harness.database
			.insert(signInTables.oauthClientResource)
			.values({
				id: fixtureSql`${controlledSignInIds.nextId()}`,
				clientId: fixtureSql`${credential.clientId}`,
				resourceId: fixtureSql`${workspaceAudience(workspaceThree)}`,
				createdAt: fixtureSql`${controlledSignInClock.now()}`,
			})
			.run();
		expect(
			await harness.database
				.select({ resourceId: fixtureSql`${signInTables.oauthClientResource.resourceId}` })
				.from(signInTables.oauthClientResource)
				.where(
					and(
						eq(signInTables.oauthClientResource.clientId, credential.clientId),
						eq(signInTables.oauthClientResource.resourceId, workspaceAudience(workspaceThree)),
					),
				)
				.limit(1)
				.then((storedRows) => storedRows[0] ?? null),
		).toEqual({ resourceId: workspaceAudience(workspaceThree) });
		const control = `/__auth-proof/hold/`;
		await harness.auth(`${control}arm?client=${credential.clientId}`, { method: 'POST' });
		try {
			const refused = await workspaceTokenResponse({
				harness,
				credential,
				workspaceId: workspaceThree,
			});
			expect(refused.status).toBe(400);
			const body: unknown = await refused.json();
			expect(body).toMatchObject({ error: 'invalid_target' });
			expectNoIssuedCredentials(body);
			expect(
				await (await harness.auth(`${control}status?client=${credential.clientId}`)).json(),
			).toEqual({ armed: true, observed: false });
			expect(harness.effects).toEqual([]);
		} finally {
			await harness.auth(`${control}release?client=${credential.clientId}`, { method: 'POST' });
		}
	} finally {
		await harness.close();
	}
});

it('agent: an authentic legacy Worker audience without workspace identity cannot enter any workspace', async () => {
	const harness = await startLocalAuthHarness();
	try {
		const owner = await harness.ownerToken();
		const registration = await addWorkspaceAgent({
			harness,
			owner,
			workspaceId: workspaceOne,
			requestId: registrationRequestId,
		});
		expect(registration.status).toBe(200);
		const credential = agentCredentialSchema.parse(await registration.json());
		const response = await harness.auth('/api/auth/__proof/legacy-agent', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ clientId: credential.clientId, organizationId: organizationOne }),
		});
		expect(response.status).toBe(200);
		const { token } = z.object({ token: z.string() }).parse(await response.json());
		const signed = await jwtVerify(
			token,
			createObservedProofJwks(new URL('/api/auth/jwks', harness.issuer)),
			{ issuer: harness.issuer, audience: 'https://portal-test.invalid/mcp' },
		);
		expect(signed.payload).toMatchObject({
			client_id: credential.clientId,
			organization_id: organizationOne,
			scope: 'tool-portal:agent',
		});
		expect(signed.payload).not.toHaveProperty('workspace_id');
		const effectsBefore = [...harness.effects];
		await Promise.all(
			[workspaceOne, workspaceTwo, workspaceThree].map(async (workspaceId): Promise<void> => {
				expect(
					(
						await callWorkspaceTool({
							harness,
							workspaceId,
							token,
							correlation: 'legacy-agent-refusal',
						})
					).status,
				).toBe(401);
			}),
		);
		expect(harness.effects).toEqual(effectsBefore);
	} finally {
		await harness.close();
	}
});

it('agent: a real O2 W3 token dispatches exactly once under W3 credentials and never at W1 or W2', async () => {
	const harness = await startLocalAuthHarness();
	try {
		const owner = await harness.ownerToken();
		const registered = await addWorkspaceAgent({
			harness,
			owner,
			workspaceId: workspaceThree,
			requestId: controlledSignInIds.nextId(),
		});
		expect(registered.status).toBe(200);
		const credential = agentCredentialSchema.parse(await registered.json());
		const token = await workspaceToken({ harness, credential, workspaceId: workspaceThree });
		const signed = await jwtVerify(
			token,
			createObservedProofJwks(new URL('/api/auth/jwks', harness.issuer)),
			{
				issuer: harness.issuer,
				audience: workspaceAudience(workspaceThree),
			},
		);
		expect(signed.protectedHeader.typ).toBe('at+jwt');
		expect(signed.payload).toMatchObject({
			sub: credential.clientId,
			client_id: credential.clientId,
			azp: credential.clientId,
			organization_id: organizationTwo,
			workspace_id: workspaceThree,
			aud: workspaceAudience(workspaceThree),
		});
		expect(signed.payload).not.toHaveProperty('sid');
		const beforeAllowed = harness.effects.length;
		const allowed = await callWorkspaceTool({
			harness,
			workspaceId: workspaceThree,
			token,
			correlation: 'real-o2-w3-positive',
		});
		expect(allowed.status).toBe(200);
		expect(harness.effects.slice(beforeAllowed)).toEqual([
			{
				credential: 'Bearer organization-two-canary',
				arguments: { correlation: 'real-o2-w3-positive' },
			},
		]);
		const beforeCrossPresentation = [...harness.effects];
		const refused = await Promise.all(
			[workspaceOne, workspaceTwo].map(async (workspaceId): Promise<Response> =>
				callWorkspaceTool({
					harness,
					workspaceId,
					token,
					correlation: `cross-w3-${workspaceId}`,
				}),
			),
		);
		expect(refused.map((response) => response.status)).toEqual([401, 401]);
		expect(harness.effects).toEqual(beforeCrossPresentation);
	} finally {
		await harness.close();
	}
});
