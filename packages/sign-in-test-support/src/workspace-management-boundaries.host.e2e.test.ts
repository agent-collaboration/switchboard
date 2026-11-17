import * as signInTables from '@agent-collaboration/sign-in-core';
import { eq, sql as fixtureSql } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { z } from 'zod';

import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import { controlledSignInIds } from '#sign-in-test-support/test-fixtures/controlled-sign-in-clock';
import { expectNoIssuedCredentials } from '#sign-in-test-support/test-fixtures/credential-free-refusal';
import {
	organizationOne,
	organizationTwo,
	registeredClientId,
	registrationRequestId,
	startLocalAuthHarness,
	workspaceAudience,
	workspaceOne,
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

useControlledSignInClock();

it('agent: a pending W1 unlink refuses warm calls until retry while a new W2 token still works', async () => {
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
		const credential = agentCredentialSchema.parse(await registered.json());
		expect(
			(
				await addWorkspaceAgent({
					harness,
					owner,
					workspaceId: workspaceTwo,
					clientId: credential.clientId,
					requestId: controlledSignInIds.nextId(),
				})
			).status,
		).toBe(200);
		const old = await workspaceToken({ harness, credential, workspaceId: workspaceOne });
		expect(
			(
				await callWorkspaceTool({
					harness,
					workspaceId: workspaceOne,
					token: old,
					correlation: 'warm-before-unlink',
				})
			).status,
		).toBe(200);
		await harness.setDatabaseFault({
			operation: 'delete',
			table: 'oauthClientResource',
			key: registeredClientId,
		});
		const endpoint = `/management/workspaces/${workspaceOne}/agents/${credential.clientId}`;
		const operation = {
			method: 'DELETE',
			headers: { authorization: `Bearer ${owner}`, 'content-type': 'application/json' },
			body: JSON.stringify({ requestId: controlledSignInIds.nextId() }),
		};
		try {
			const pending = await harness.gateway(endpoint, operation);
			expect(pending.status).toBe(202);
			expect(await pending.json()).toEqual({
				kind: 'removal-pending',
				clientId: credential.clientId,
			});
			const before = [...harness.effects];
			expect(
				(
					await callWorkspaceTool({
						harness,
						workspaceId: workspaceOne,
						token: old,
						correlation: 'pending-unlink-refuses',
					})
				).status,
			).toBe(401);
			expect(harness.effects).toEqual(before);
			// The named between-writes gap is issuance, not admission: link deletion really failed.
			expect(
				(await workspaceTokenResponse({ harness, credential, workspaceId: workspaceOne })).status,
			).toBe(200);
		} finally {
			await harness.setDatabaseFault(null);
		}
		const completed = await harness.gateway(endpoint, {
			headers: { authorization: `Bearer ${owner}` },
		});
		expect(await completed.json()).toEqual({
			kind: 'removed',
			clientId: credential.clientId,
			workspaceId: workspaceOne,
		});
		expect(
			await (
				await workspaceTokenResponse({ harness, credential, workspaceId: workspaceOne })
			).json(),
		).toMatchObject({ error: 'invalid_target' });
		const w2 = await workspaceToken({ harness, credential, workspaceId: workspaceTwo });
		expect(
			(
				await callWorkspaceTool({
					harness,
					workspaceId: workspaceTwo,
					token: w2,
					correlation: 'other-workspace-after-unlink',
				})
			).status,
		).toBe(200);
		expect(harness.effects.at(-1)).toEqual({
			credential: 'Bearer workspace-two-canary',
			arguments: { correlation: 'other-workspace-after-unlink' },
		});
		expect(
			await harness.database
				.select({ resourceId: fixtureSql`${signInTables.oauthClientResource.resourceId}` })
				.from(signInTables.oauthClientResource)
				.where(eq(signInTables.oauthClientResource.clientId, credential.clientId)),
		).toEqual([{ resourceId: workspaceAudience(workspaceTwo) }]);
		expect(
			await harness.database
				.select({ disabled: fixtureSql`coalesce(${signInTables.oauthClient.disabled}, ${0})` })
				.from(signInTables.oauthClient)
				.where(eq(signInTables.oauthClient.clientId, credential.clientId))
				.limit(1)
				.then((storedRows) => storedRows[0] ?? null),
		).toEqual({ disabled: 0 });
	} finally {
		await harness.close();
	}
});

it('agent: a named management request ID cannot change operation, client, organization or workspace intent', async () => {
	const harness = await startLocalAuthHarness();
	try {
		const owner = await harness.ownerToken();
		const binding = { SIGN_IN: await harness.signInManagement() };
		const original = {
			token: owner,
			organizationId: organizationOne,
			workspaceId: workspaceOne,
			requestId: registrationRequestId,
		};
		const registration = await addWorkspaceAgent({
			harness,
			owner,
			workspaceId: workspaceOne,
			requestId: registrationRequestId,
		});
		expect(registration.status).toBe(200);
		const first = agentCredentialSchema
			.extend({
				kind: z.literal('registered'),
				workspaceId: z.literal(workspaceOne),
				resource: z.literal(workspaceAudience(workspaceOne)),
			})
			.strict()
			.parse(await registration.json());
		async function protectedState(): Promise<unknown> {
			return Promise.all([
				harness.database
					.select(storedRowProjection(signInTables.oauthClient))
					.from(signInTables.oauthClient)
					.orderBy(signInTables.oauthClient.clientId),
				harness.database
					.select(storedRowProjection(signInTables.oauthResource))
					.from(signInTables.oauthResource)
					.orderBy(signInTables.oauthResource.identifier),
				harness.database
					.select(storedRowProjection(signInTables.oauthClientResource))
					.from(signInTables.oauthClientResource)
					.orderBy(
						signInTables.oauthClientResource.clientId,
						signInTables.oauthClientResource.resourceId,
					),
				harness.database
					.select(storedRowProjection(signInTables.signInAudit))
					.from(signInTables.signInAudit)
					.orderBy(signInTables.signInAudit.id),
			]);
		}
		const before = await protectedState();
		const conflicts = await Promise.all([
			binding.SIGN_IN.registerAndLink({ ...original, workspaceId: workspaceTwo }),
			binding.SIGN_IN.registerAndLink({ ...original, organizationId: organizationTwo }),
			binding.SIGN_IN.link({ ...original, clientId: first.clientId }),
			binding.SIGN_IN.unlink({ ...original, clientId: 'other-client' }),
			binding.SIGN_IN.disable({
				token: owner,
				organizationId: organizationOne,
				clientId: first.clientId,
				requestId: registrationRequestId,
			}),
		]);
		for (const result of conflicts) {
			expect(result).toEqual({ kind: 'refused', reason: 'operation-conflict' });
			expectNoIssuedCredentials(result);
		}
		expect(await protectedState()).toEqual(before);
	} finally {
		await harness.close();
	}
});

it('agent: a Portal unlink reports a reused registration ID and recovers with a fresh removal ID', async () => {
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
		const endpoint = `/management/workspaces/${workspaceOne}/agents/${credential.clientId}`;
		async function remove(requestId: string): Promise<Response> {
			return harness.gateway(endpoint, {
				method: 'DELETE',
				headers: { authorization: `Bearer ${owner}`, 'content-type': 'application/json' },
				body: JSON.stringify({ requestId }),
			});
		}
		async function workspaceState(): Promise<unknown> {
			return (
				await harness.gateway(
					`/__auth-proof?workspace=${workspaceOne}&client=${credential.clientId}`,
				)
			).json();
		}
		async function issuerState(): Promise<unknown> {
			return Promise.all([
				harness.database
					.select({ disabled: fixtureSql`coalesce(${signInTables.oauthClient.disabled}, ${0})` })
					.from(signInTables.oauthClient)
					.where(eq(signInTables.oauthClient.clientId, credential.clientId))
					.limit(1)
					.then((storedRows) => storedRows[0] ?? null),
				harness.database
					.select({ resourceId: fixtureSql`${signInTables.oauthClientResource.resourceId}` })
					.from(signInTables.oauthClientResource)
					.where(eq(signInTables.oauthClientResource.clientId, credential.clientId))
					.orderBy(signInTables.oauthClientResource.resourceId)
					.then((result) => result),
			]);
		}
		const beforeIssuer = await issuerState();
		const refused = await remove(registrationRequestId);
		expect(refused.status).toBe(403);
		const refusal = await refused.json();
		expect(refusal).toEqual({ kind: 'refused', reason: 'operation-conflict' });
		expectNoIssuedCredentials(refusal);
		expect(await issuerState()).toEqual(beforeIssuer);
		expect(await workspaceState()).toEqual({
			[`member:${credential.clientId}`]: { state: 'removed', persona: 'operator' },
			[`member-removal:${credential.clientId}`]: {
				kind: 'pending',
				operation: 'unlink',
				requestId: registrationRequestId,
			},
		});
		const recoveryId = controlledSignInIds.nextId();
		const recovered = await remove(recoveryId);
		expect(recovered.status).toBe(200);
		expect(await recovered.json()).toEqual({
			kind: 'removed',
			clientId: credential.clientId,
			workspaceId: workspaceOne,
		});
		expect(await workspaceState()).toEqual({
			[`member:${credential.clientId}`]: { state: 'removed', persona: 'operator' },
			[`member-removal:${credential.clientId}`]: {
				kind: 'complete',
				operation: 'unlink',
				requestId: recoveryId,
			},
		});
		expect(await issuerState()).toEqual([{ disabled: 0 }, []]);
	} finally {
		await harness.close();
	}
});

it('agent: an incompatible workspace resource is never overwritten or linked by management', async () => {
	const harness = await startLocalAuthHarness();
	try {
		const owner = await harness.ownerToken();
		const one = await addWorkspaceAgent({
			harness,
			owner,
			workspaceId: workspaceOne,
			requestId: registrationRequestId,
		});
		expect(one.status).toBe(200);
		const credential = agentCredentialSchema.parse(await one.json());
		const resourceOwner = await addWorkspaceAgent({
			harness,
			owner,
			workspaceId: workspaceTwo,
			requestId: controlledSignInIds.nextId(),
		});
		expect(resourceOwner.status).toBe(200);
		const foreignMetadata = JSON.stringify({
			kind: 'workspace',
			organizationId: organizationTwo,
			workspaceId: workspaceTwo,
		});
		await harness.database
			.update(signInTables.oauthResource)
			.set({ metadata: fixtureSql`${foreignMetadata}` })
			.where(eq(signInTables.oauthResource.identifier, workspaceAudience(workspaceTwo)))
			.run();
		const beforeResource = await harness.database
			.select(storedRowProjection(signInTables.oauthResource))
			.from(signInTables.oauthResource)
			.where(eq(signInTables.oauthResource.identifier, workspaceAudience(workspaceTwo)))
			.limit(1)
			.then((storedRows) => storedRows[0] ?? null);
		const beforeLinks = await harness.database
			.select(storedRowProjection(signInTables.oauthClientResource))
			.from(signInTables.oauthClientResource)
			.orderBy(
				signInTables.oauthClientResource.clientId,
				signInTables.oauthClientResource.resourceId,
			);
		const bindings = { SIGN_IN: await harness.signInManagement() };
		const refused = await bindings.SIGN_IN.link({
			token: owner,
			organizationId: organizationOne,
			workspaceId: workspaceTwo,
			clientId: credential.clientId,
			requestId: controlledSignInIds.nextId(),
		});
		expect(refused).toEqual({ kind: 'refused', reason: 'resource-conflict' });
		expectNoIssuedCredentials(refused);
		expect(
			await harness.database
				.select(storedRowProjection(signInTables.oauthResource))
				.from(signInTables.oauthResource)
				.where(eq(signInTables.oauthResource.identifier, workspaceAudience(workspaceTwo)))
				.limit(1)
				.then((storedRows) => storedRows[0] ?? null),
		).toEqual(beforeResource);
		expect(
			await harness.database
				.select(storedRowProjection(signInTables.oauthClientResource))
				.from(signInTables.oauthClientResource)
				.orderBy(
					signInTables.oauthClientResource.clientId,
					signInTables.oauthClientResource.resourceId,
				),
		).toEqual(beforeLinks);
	} finally {
		await harness.close();
	}
});

it('agent: retirement refuses a locally reused unlink ID without writes and recovers its forced racy leftover', async () => {
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
		expect(
			(
				await addWorkspaceAgent({
					harness,
					owner,
					workspaceId: workspaceTwo,
					clientId: credential.clientId,
					requestId: controlledSignInIds.nextId(),
				})
			).status,
		).toBe(200);
		const unlinkId = controlledSignInIds.nextId();
		const recoveryId = controlledSignInIds.nextId();
		const headers = { authorization: `Bearer ${owner}`, 'content-type': 'application/json' };
		async function remove(endpoint: string, requestId: string): Promise<Response> {
			return harness.gateway(endpoint, {
				method: 'DELETE',
				headers,
				body: JSON.stringify({ requestId }),
			});
		}
		async function workspaceState(workspaceId: string): Promise<unknown> {
			return (
				await harness.gateway(
					`/__auth-proof?workspace=${workspaceId}&client=${credential.clientId}`,
				)
			).json();
		}
		async function issuerState(): Promise<unknown> {
			return Promise.all([
				harness.database
					.select({ disabled: fixtureSql`coalesce(${signInTables.oauthClient.disabled}, ${0})` })
					.from(signInTables.oauthClient)
					.where(eq(signInTables.oauthClient.clientId, credential.clientId))
					.limit(1)
					.then((storedRows) => storedRows[0] ?? null),
				harness.database
					.select({ resourceId: fixtureSql`${signInTables.oauthClientResource.resourceId}` })
					.from(signInTables.oauthClientResource)
					.where(eq(signInTables.oauthClientResource.clientId, credential.clientId))
					.orderBy(signInTables.oauthClientResource.resourceId)
					.then((result) => result),
				harness.database
					.select(storedRowProjection(signInTables.signInAudit))
					.from(signInTables.signInAudit)
					.orderBy(signInTables.signInAudit.id)
					.then((result) => result),
			]);
		}
		const unlinkEndpoint = `/management/workspaces/${workspaceOne}/agents/${credential.clientId}`;
		const retirementEndpoint = `/management/organizations/${organizationOne}/agents/${credential.clientId}`;
		expect((await remove(unlinkEndpoint, unlinkId)).status).toBe(200);
		const history = await workspaceState(workspaceOne);
		expect(history).toEqual({
			[`member:${credential.clientId}`]: { state: 'removed', persona: 'operator' },
			[`member-removal:${credential.clientId}`]: {
				kind: 'complete',
				operation: 'unlink',
				requestId: unlinkId,
			},
		});
		const beforeOther = await workspaceState(workspaceTwo);
		expect(beforeOther).toEqual({
			[`member:${credential.clientId}`]: { state: 'member', persona: 'operator' },
		});
		const beforeIssuer = await issuerState();
		const refused = await remove(retirementEndpoint, unlinkId);
		expect.soft(refused.status).toBe(403);
		const refusal = await refused.json();
		expect.soft(refusal).toEqual({ kind: 'refused', reason: 'operation-conflict' });
		expectNoIssuedCredentials(refusal);
		expect.soft(await workspaceState(workspaceOne)).toEqual(history);
		expect.soft(await workspaceState(workspaceTwo)).toEqual(beforeOther);
		expect.soft(await issuerState()).toEqual(beforeIssuer);

		// Seed only the ruled race history through the real DO method; requests below use production fetch.
		const bindings = await harness.miniflare.getBindings<{
			readonly WORKSPACES: {
				readonly idFromName: (name: string) => DurableObjectId;
				readonly get: (id: DurableObjectId) => {
					readonly beginAgentRemoval: (
						clientId: string,
						requestId: string,
						intent: { readonly operation: 'disable' },
					) => Promise<unknown>;
				};
			};
		}>('gateway-one');
		expect(
			await bindings.WORKSPACES.get(bindings.WORKSPACES.idFromName(workspaceTwo)).beginAgentRemoval(
				credential.clientId,
				unlinkId,
				{ operation: 'disable' },
			),
		).toEqual({ kind: 'pending', operation: 'disable', requestId: unlinkId });
		const leftover = await workspaceState(workspaceTwo);
		expect(leftover).toEqual({
			[`member:${credential.clientId}`]: { state: 'removed', persona: 'operator' },
			[`member-removal:${credential.clientId}`]: {
				kind: 'pending',
				operation: 'disable',
				requestId: unlinkId,
			},
		});
		const status = await harness.gateway(retirementEndpoint, { headers });
		expect.soft(status.status).toBe(403);
		const statusBody = await status.json();
		expect.soft(statusBody).toEqual({ kind: 'refused', reason: 'operation-conflict' });
		expectNoIssuedCredentials(statusBody);
		expect.soft(await workspaceState(workspaceOne)).toEqual(history);
		expect.soft(await workspaceState(workspaceTwo)).toEqual(leftover);
		expect.soft(await issuerState()).toEqual(beforeIssuer);
		const recovered = await remove(retirementEndpoint, recoveryId);
		expect.soft(recovered.status).toBe(200);
		const recoveredBody = await recovered.json();
		expect.soft(recoveredBody).toEqual({ kind: 'removed', clientId: credential.clientId });
		expect.soft(await workspaceState(workspaceOne)).toEqual({
			[`member:${credential.clientId}`]: { state: 'removed', persona: 'operator' },
			[`member-removal:${credential.clientId}`]: {
				kind: 'complete',
				operation: 'disable',
				requestId: recoveryId,
			},
		});
		expect.soft(await workspaceState(workspaceTwo)).toEqual({
			[`member:${credential.clientId}`]: { state: 'removed', persona: 'operator' },
			[`member-removal:${credential.clientId}`]: {
				kind: 'complete',
				operation: 'disable',
				requestId: recoveryId,
			},
		});
		expect
			.soft(
				await harness.database
					.select({ disabled: fixtureSql`coalesce(${signInTables.oauthClient.disabled}, ${0})` })
					.from(signInTables.oauthClient)
					.where(eq(signInTables.oauthClient.clientId, credential.clientId))
					.limit(1)
					.then((storedRows) => storedRows[0] ?? null),
			)
			.toEqual({ disabled: 1 });
		expect
			.soft(
				await harness.database
					.select({ resourceId: fixtureSql`${signInTables.oauthClientResource.resourceId}` })
					.from(signInTables.oauthClientResource)
					.where(eq(signInTables.oauthClientResource.clientId, credential.clientId))
					.orderBy(signInTables.oauthClientResource.resourceId),
			)
			.toEqual([{ resourceId: workspaceAudience(workspaceTwo) }]);
	} finally {
		await harness.close();
	}
});
