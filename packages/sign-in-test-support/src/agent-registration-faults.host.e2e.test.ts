import * as signInTables from '@agent-collaboration/sign-in-core';
import { and, eq, sql as fixtureSql } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { z } from 'zod';

import { expectBasicClientAuthenticationRefusal } from '#sign-in-test-support/test-fixtures/client-authentication-refusal';
import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import { controlledSignInIds } from '#sign-in-test-support/test-fixtures/controlled-sign-in-clock';
import {
	agentAudience,
	organizationOne,
	registeredClientId,
	registrationRequestId,
	startLocalAuthHarness,
	workspaceOne,
} from '#sign-in-test-support/test-fixtures/local-auth-harness';

useControlledSignInClock();

const faults = [
	{
		name: 'intent',
		clients: 0,
		links: 0,
		intents: 0,
	},
	{
		name: 'client',
		clients: 0,
		links: 0,
		intents: 1,
	},
	{
		name: 'link',
		clients: 1,
		links: 0,
		intents: 1,
	},
	{
		name: 'outcome',
		clients: 1,
		links: 1,
		intents: 1,
	},
] as const;

// Inject a driver failure by table plus client key and phase, before that write runs.
// Every successful statement uses real D1; this does not claim a SQLite-trigger rejection.
it.each(faults)(
	'agent: fails closed at the actual $name write and owner retry leaves exactly one linked working client',
	async (fault) => {
		const harness = await startLocalAuthHarness();
		try {
			const owner = await harness.ownerToken();
			const endpoint = `/management/workspaces/${workspaceOne}/agents`;
			const operation = {
				method: 'POST',
				headers: { authorization: `Bearer ${owner}`, 'content-type': 'application/json' },
				body: JSON.stringify({ requestId: registrationRequestId, persona: 'operator' }),
			};
			await harness.setDatabaseFault(
				fault.name === 'client'
					? { operation: 'insert', table: 'oauthClient', key: registeredClientId }
					: fault.name === 'link'
						? { operation: 'insert', table: 'oauthClientResource', key: registeredClientId }
						: {
								operation: 'insert',
								table: 'sign_in_audit',
								key: registeredClientId,
								phase: fault.name,
								changeKind: 'registered',
							},
			);
			const failed = await harness.gateway(endpoint, operation);
			expect(failed.status).toBe(503);
			expect(await failed.json()).not.toHaveProperty('clientSecret');
			const before = await harness.database
				.select({
					clientId: fixtureSql`${signInTables.oauthClient.clientId}`,
					clientSecret: fixtureSql`${signInTables.oauthClient.clientSecret}`,
				})
				.from(signInTables.oauthClient)
				.where(eq(signInTables.oauthClient.clientId, registeredClientId));
			expect(before).toHaveLength(fault.clients);
			expect(
				await harness.database
					.select({ resourceId: fixtureSql`${signInTables.oauthClientResource.resourceId}` })
					.from(signInTables.oauthClientResource)
					.where(eq(signInTables.oauthClientResource.clientId, registeredClientId)),
			).toHaveLength(fault.links);
			expect(
				await harness.database
					.select({ id: fixtureSql`${signInTables.signInAudit.id}` })
					.from(signInTables.signInAudit)
					.where(
						and(
							eq(signInTables.signInAudit.targetId, registeredClientId),
							eq(signInTables.signInAudit.phase, 'intent'),
						),
					),
			).toHaveLength(fault.intents);
			expect(
				await harness.database
					.select({ id: fixtureSql`${signInTables.signInAudit.id}` })
					.from(signInTables.signInAudit)
					.where(
						and(
							eq(signInTables.signInAudit.targetId, registeredClientId),
							eq(signInTables.signInAudit.phase, 'outcome'),
						),
					),
			).toHaveLength(0);
			expect(
				await (
					await harness.gateway(
						`/__auth-proof?workspace=${workspaceOne}&client=${registeredClientId}`,
					)
				).json(),
			).not.toHaveProperty(`member:${registeredClientId}`);
			await harness.setDatabaseFault(null);
			const repeated = await harness.gateway(endpoint, operation);
			expect(repeated.status).toBe(200);
			const credentials = z
				.strictObject({
					kind: z.literal('registered'),
					clientId: z.literal(registeredClientId),
					clientSecret: z.string().min(1),
					workspaceId: z.literal(workspaceOne),
					resource: z.literal(agentAudience),
				})
				.parse(await repeated.json());
			const after = await harness.database
				.select({
					clientId: fixtureSql`${signInTables.oauthClient.clientId}`,
					clientSecret: fixtureSql`${signInTables.oauthClient.clientSecret}`,
				})
				.from(signInTables.oauthClient)
				.where(eq(signInTables.oauthClient.clientId, registeredClientId));
			expect(after).toHaveLength(1);
			if (fault.clients > 0) expect(after[0]?.clientSecret).not.toBe(before[0]?.clientSecret);
			expect(
				await harness.database
					.select({ resourceId: fixtureSql`${signInTables.oauthClientResource.resourceId}` })
					.from(signInTables.oauthClientResource)
					.where(eq(signInTables.oauthClientResource.clientId, registeredClientId)),
			).toEqual([{ resourceId: agentAudience }]);
			const token = await harness.auth('/api/auth/oauth2/token', {
				method: 'POST',
				headers: {
					authorization: `Basic ${btoa(`${credentials.clientId}:${credentials.clientSecret}`)}`,
					'content-type': 'application/x-www-form-urlencoded',
				},
				body: new URLSearchParams({
					grant_type: 'client_credentials',
					scope: 'tool-portal:agent',
					resource: agentAudience,
				}),
			});
			expect(token.status).toBe(200);
			expect(await token.json()).toHaveProperty('access_token');
			expect(
				await (
					await harness.gateway(
						`/__auth-proof?workspace=${workspaceOne}&client=${registeredClientId}`,
					)
				).json(),
			).toMatchObject({
				[`member:${registeredClientId}`]: { state: 'member', persona: 'operator' },
			});
		} finally {
			await harness.close();
		}
	},
);

it.each(['intent', 'client', 'outcome'] as const)(
	'agent: disable remains pending after the actual %s write fails and same-operation retry completes both owners',
	async (fault) => {
		const harness = await startLocalAuthHarness();
		try {
			const owner = await harness.ownerToken();
			const base = `/management/organizations/${organizationOne}/agents`;
			const registered = await harness.gateway(`/management/workspaces/${workspaceOne}/agents`, {
				method: 'POST',
				headers: { authorization: `Bearer ${owner}`, 'content-type': 'application/json' },
				body: JSON.stringify({ requestId: registrationRequestId, persona: 'operator' }),
			});
			expect(registered.status).toBe(200);
			const credentials = z
				.object({ clientId: z.literal(registeredClientId), clientSecret: z.string() })
				.parse(await registered.json());
			async function exchange(): Promise<Response> {
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
					}),
				});
			}
			const permitted = await exchange();
			expect(permitted.status).toBe(200);
			const oldToken = z
				.object({ access_token: z.string() })
				.parse(await permitted.json()).access_token;

			await harness.setDatabaseFault(
				fault === 'client'
					? {
							operation: 'update',
							table: 'oauthClient',
							key: registeredClientId,
							column: 'disabled',
						}
					: {
							operation: 'insert',
							table: 'sign_in_audit',
							key: registeredClientId,
							phase: fault,
							changeKind: 'retired',
						},
			);
			const requestId = controlledSignInIds.nextId();
			const operation = {
				method: 'DELETE',
				headers: { authorization: `Bearer ${owner}`, 'content-type': 'application/json' },
				body: JSON.stringify({ requestId }),
			};
			const failed = await harness.gateway(`${base}/${registeredClientId}`, operation);
			expect(failed.status).toBe(202);
			expect(await failed.json()).toEqual({
				kind: 'removal-pending',
				clientId: registeredClientId,
			});
			expect(
				await harness.database
					.select({ disabled: fixtureSql`coalesce(${signInTables.oauthClient.disabled}, ${0})` })
					.from(signInTables.oauthClient)
					.where(eq(signInTables.oauthClient.clientId, registeredClientId))
					.limit(1)
					.then((storedRows) => storedRows[0] ?? null),
			).toEqual({ disabled: fault === 'outcome' ? 1 : 0 });
			expect(
				await harness.database
					.select({ phase: fixtureSql`${signInTables.signInAudit.phase}` })
					.from(signInTables.signInAudit)
					.where(
						and(
							eq(signInTables.signInAudit.requestId, requestId),
							eq(signInTables.signInAudit.changeKind, 'retired'),
						),
					)
					.orderBy(signInTables.signInAudit.phase),
			).toEqual(fault === 'intent' ? [] : [{ phase: 'intent' }]);
			const partial = await harness.gateway(
				`/__auth-proof?workspace=${workspaceOne}&client=${registeredClientId}`,
			);
			expect(await partial.json()).toMatchObject({
				[`member:${registeredClientId}`]: { state: 'removed', persona: 'operator' },
				[`member-removal:${registeredClientId}`]: { kind: 'pending', requestId },
			});
			const status = await harness.gateway(`${base}/${registeredClientId}`, {
				headers: { authorization: `Bearer ${owner}` },
			});
			expect(status.status).toBe(202);
			const denied = await Promise.all(
				[false, true].map((secondHeap) =>
					harness.gateway(
						`/workspaces/${workspaceOne}/mcp`,
						{
							method: 'POST',
							headers: { authorization: `Bearer ${oldToken}`, 'content-type': 'application/json' },
							body: '{}',
						},
						secondHeap,
					),
				),
			);
			expect(denied.map((response) => response.status)).toEqual([401, 401]);
			expect(await Promise.all(denied.map((response) => response.json()))).toEqual([
				{ error: 'unknown-caller' },
				{ error: 'unknown-caller' },
			]);
			const partialExchange = await exchange();
			if (fault === 'outcome') await expectBasicClientAuthenticationRefusal(partialExchange);
			else expect(partialExchange.status).toBe(200);
			await harness.setDatabaseFault(null);
			const retried = await harness.gateway(`${base}/${registeredClientId}`, operation);
			expect(retried.status).toBe(200);
			expect(await retried.json()).toEqual({ kind: 'removed', clientId: registeredClientId });
			expect(
				await harness.database
					.select({ phase: fixtureSql`${signInTables.signInAudit.phase}` })
					.from(signInTables.signInAudit)
					.where(
						and(
							eq(signInTables.signInAudit.requestId, requestId),
							eq(signInTables.signInAudit.changeKind, 'retired'),
						),
					)
					.orderBy(signInTables.signInAudit.phase),
			).toEqual([{ phase: 'intent' }, { phase: 'outcome' }]);
			expect(
				await harness.database
					.select({ clientId: fixtureSql`${signInTables.oauthClient.clientId}` })
					.from(signInTables.oauthClient)
					.where(eq(signInTables.oauthClient.clientId, registeredClientId)),
			).toHaveLength(1);
			expect(
				await harness.database
					.select({ resourceId: fixtureSql`${signInTables.oauthClientResource.resourceId}` })
					.from(signInTables.oauthClientResource)
					.where(eq(signInTables.oauthClientResource.clientId, registeredClientId)),
			).toEqual([{ resourceId: agentAudience }]);
			expect(
				await (
					await harness.gateway(
						`/__auth-proof?workspace=${workspaceOne}&client=${registeredClientId}`,
					)
				).json(),
			).toMatchObject({
				[`member-removal:${registeredClientId}`]: { kind: 'complete', requestId },
			});
			await expectBasicClientAuthenticationRefusal(await exchange());
			expect(harness.effects).toHaveLength(0);
		} finally {
			await harness.close();
		}
	},
);

it.each(['intent', 'client', 'outcome'] as const)(
	'agent: rotation retry fails closed at its actual %s write and invalidates the lost old secret',
	async (fault) => {
		const harness = await startLocalAuthHarness();
		try {
			const owner = await harness.ownerToken();
			const endpoint = `/management/workspaces/${workspaceOne}/agents`;
			const operation = {
				method: 'POST',
				headers: { authorization: `Bearer ${owner}`, 'content-type': 'application/json' },
				body: JSON.stringify({ requestId: registrationRequestId, persona: 'operator' }),
			};
			const credentialSchema = z.object({
				clientId: z.literal(registeredClientId),
				clientSecret: z.string().min(1),
			});
			const originalResponse = await harness.gateway(endpoint, operation);
			expect(originalResponse.status).toBe(200);
			const lost = credentialSchema.parse(await originalResponse.json());
			async function exchange(secret: string): Promise<Response> {
				return harness.auth('/api/auth/oauth2/token', {
					method: 'POST',
					headers: {
						authorization: `Basic ${btoa(`${registeredClientId}:${secret}`)}`,
						'content-type': 'application/x-www-form-urlencoded',
					},
					body: new URLSearchParams({
						grant_type: 'client_credentials',
						scope: 'tool-portal:agent',
						resource: agentAudience,
					}),
				});
			}
			expect((await exchange(lost.clientSecret)).status).toBe(200);
			const storedBefore = await harness.database
				.select({ clientSecret: fixtureSql`${signInTables.oauthClient.clientSecret}` })
				.from(signInTables.oauthClient)
				.where(eq(signInTables.oauthClient.clientId, registeredClientId))
				.limit(1)
				.then((storedRows) => storedRows[0] ?? null);

			await harness.setDatabaseFault(
				fault === 'client'
					? {
							operation: 'update',
							table: 'oauthClient',
							key: registeredClientId,
							column: 'clientSecret',
						}
					: {
							operation: 'insert',
							table: 'sign_in_audit',
							key: registeredClientId,
							phase: fault,
							changeKind: 'rotated',
						},
			);
			const failed = await harness.gateway(endpoint, operation);
			expect(failed.status).toBe(503);
			expect(await failed.json()).not.toHaveProperty('clientSecret');
			const partial = await harness.database
				.select({ clientSecret: fixtureSql`${signInTables.oauthClient.clientSecret}` })
				.from(signInTables.oauthClient)
				.where(eq(signInTables.oauthClient.clientId, registeredClientId))
				.limit(1)
				.then((storedRows) => storedRows[0] ?? null);
			if (fault === 'outcome') expect(partial).not.toEqual(storedBefore);
			else expect(partial).toEqual(storedBefore);

			expect(
				await harness.database
					.select({ phase: fixtureSql`${signInTables.signInAudit.phase}` })
					.from(signInTables.signInAudit)
					.where(
						and(
							eq(signInTables.signInAudit.requestId, registrationRequestId),
							eq(signInTables.signInAudit.changeKind, 'rotated'),
						),
					)
					.orderBy(signInTables.signInAudit.phase),
			).toEqual(fault === 'intent' ? [] : [{ phase: 'intent' }]);
			const partialExchange = await exchange(lost.clientSecret);
			if (fault === 'outcome') await expectBasicClientAuthenticationRefusal(partialExchange);
			else expect(partialExchange.status).toBe(200);
			await harness.setDatabaseFault(null);
			const recoveredResponse = await harness.gateway(endpoint, operation);
			expect(recoveredResponse.status).toBe(200);
			const recovered = credentialSchema.parse(await recoveredResponse.json());
			expect(recovered.clientSecret).not.toBe(lost.clientSecret);
			const rejectedOld = await exchange(lost.clientSecret);
			await expectBasicClientAuthenticationRefusal(rejectedOld);
			const permittedNew = await exchange(recovered.clientSecret);
			expect(permittedNew.status).toBe(200);
			expect(await permittedNew.json()).toHaveProperty('access_token');
			expect(
				await harness.database
					.select({ phase: fixtureSql`${signInTables.signInAudit.phase}` })
					.from(signInTables.signInAudit)
					.where(
						and(
							eq(signInTables.signInAudit.requestId, registrationRequestId),
							eq(signInTables.signInAudit.changeKind, 'rotated'),
						),
					)
					.orderBy(signInTables.signInAudit.phase),
			).toEqual([{ phase: 'intent' }, { phase: 'outcome' }]);
			expect(
				await harness.database
					.select({ clientId: fixtureSql`${signInTables.oauthClient.clientId}` })
					.from(signInTables.oauthClient)
					.where(eq(signInTables.oauthClient.clientId, registeredClientId)),
			).toEqual([{ clientId: registeredClientId }]);
			expect(
				await harness.database
					.select({ resourceId: fixtureSql`${signInTables.oauthClientResource.resourceId}` })
					.from(signInTables.oauthClientResource)
					.where(eq(signInTables.oauthClientResource.clientId, registeredClientId)),
			).toEqual([{ resourceId: agentAudience }]);
			expect(
				await (
					await harness.gateway(
						`/__auth-proof?workspace=${workspaceOne}&client=${registeredClientId}`,
					)
				).json(),
			).toMatchObject({
				[`member:${registeredClientId}`]: { state: 'member', persona: 'operator' },
			});
			expect(harness.effects).toHaveLength(0);
		} finally {
			await harness.close();
		}
	},
);
