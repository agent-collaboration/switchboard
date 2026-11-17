import * as signInTables from '@agent-collaboration/sign-in-core';
import { and, eq, sql as fixtureSql } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { z } from 'zod';

import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import { controlledSignInIds } from '#sign-in-test-support/test-fixtures/controlled-sign-in-clock';
import {
	agentAudience,
	organizationOne,
	organizationTwo,
	registeredClientId,
	registrationRequestId,
	startLocalAuthHarness,
	workspaceOne,
	workspaceTwo,
} from '#sign-in-test-support/test-fixtures/local-auth-harness';
import { storedRowProjection } from '#sign-in-test-support/test-fixtures/stored-row-projection';

useControlledSignInClock();

it.each([
	'disable',
	'resource-organization',
	'unlink',
	'resource-workspace',
	'resource-organization-after-signing',
] as const)(
	'agent: discards the actual signed token after a held $0 race before the final D1 read',
	async (race) => {
		const harness = await startLocalAuthHarness();
		let pending: Promise<Response> | undefined;
		try {
			const owner = await harness.ownerToken();
			const registration = await harness.gateway(`/management/workspaces/${workspaceOne}/agents`, {
				method: 'POST',
				headers: { authorization: `Bearer ${owner}`, 'content-type': 'application/json' },
				body: JSON.stringify({ requestId: registrationRequestId, persona: 'operator' }),
			});
			expect(registration.status).toBe(200);
			const credentials = z
				.object({ clientId: z.literal(registeredClientId), clientSecret: z.string().min(1) })
				.parse(await registration.json());
			if (race === 'resource-organization') {
				await harness.database
					.update(signInTables.oauthResource)
					.set({
						customClaims: fixtureSql`${JSON.stringify({ organization_id: organizationTwo })}`,
					})
					.where(eq(signInTables.oauthResource.identifier, agentAudience))
					.run();
				expect(
					await harness.database
						.select({ customClaims: fixtureSql`${signInTables.oauthResource.customClaims}` })
						.from(signInTables.oauthResource)
						.where(eq(signInTables.oauthResource.identifier, agentAudience))
						.limit(1)
						.then((storedRows) => storedRows[0] ?? null),
				).toEqual({ customClaims: JSON.stringify({ organization_id: organizationTwo }) });
			}
			if (race === 'resource-workspace')
				await harness.database
					.update(signInTables.oauthResource)
					.set({ customClaims: fixtureSql`${JSON.stringify({ workspace_id: workspaceTwo })}` })
					.where(eq(signInTables.oauthResource.identifier, agentAudience))
					.run();
			const control = `/__auth-proof/hold/`;
			expect(
				(await harness.auth(`${control}arm?client=${registeredClientId}`, { method: 'POST' }))
					.status,
			).toBe(200);
			pending = harness.auth('/api/auth/oauth2/token', {
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
			// Attach rejection handling immediately while the protocol event is awaited.
			void pending.catch(() => undefined);
			const signed = await harness.auth(`${control}entered?client=${registeredClientId}`);
			expect(signed.status).toBe(200);
			expect(await signed.json()).toEqual({
				signed: true,
				clientId: registeredClientId,
				organizationId: race === 'resource-organization' ? organizationTwo : organizationOne,
				workspaceId: race === 'resource-workspace' ? workspaceTwo : workspaceOne,
			});
			if (race === 'unlink') {
				// Successful RPC stays inside production Workers: Node's first service-RPC proxy blocks its observer callback.
				const unlinked = await harness.gateway(
					`/management/workspaces/${workspaceOne}/agents/${registeredClientId}`,
					{
						method: 'DELETE',
						headers: { authorization: `Bearer ${owner}`, 'content-type': 'application/json' },
						body: JSON.stringify({ requestId: controlledSignInIds.nextId() }),
					},
				);
				expect(unlinked.status).toBe(200);
				expect(await unlinked.json()).toEqual({
					kind: 'removed',
					clientId: registeredClientId,
					workspaceId: workspaceOne,
				});
				expect(
					await harness.database
						.select(storedRowProjection(signInTables.oauthClientResource))
						.from(signInTables.oauthClientResource)
						.where(
							and(
								eq(signInTables.oauthClientResource.clientId, registeredClientId),
								eq(signInTables.oauthClientResource.resourceId, agentAudience),
							),
						),
				).toEqual([]);
			}
			if (race === 'resource-organization-after-signing') {
				const metadata = JSON.stringify({
					kind: 'workspace',
					organizationId: organizationTwo,
					workspaceId: workspaceOne,
				});
				await harness.database
					.update(signInTables.oauthResource)
					.set({ metadata: fixtureSql`${metadata}` })
					.where(eq(signInTables.oauthResource.identifier, agentAudience))
					.run();
				expect(
					await harness.database
						.select({ metadata: fixtureSql`${signInTables.oauthResource.metadata}` })
						.from(signInTables.oauthResource)
						.where(eq(signInTables.oauthResource.identifier, agentAudience))
						.limit(1)
						.then((storedRows) => storedRows[0] ?? null),
				).toEqual({ metadata });
			}
			if (race === 'disable') {
				await harness.database
					.update(signInTables.oauthClient)
					.set({ disabled: fixtureSql`${1}` })
					.where(eq(signInTables.oauthClient.clientId, registeredClientId))
					.run();
				expect(
					await harness.database
						.select({ disabled: fixtureSql`${signInTables.oauthClient.disabled}` })
						.from(signInTables.oauthClient)
						.where(eq(signInTables.oauthClient.clientId, registeredClientId))
						.limit(1)
						.then((storedRows) => storedRows[0] ?? null),
				).toEqual({ disabled: 1 });
			}
			expect(
				(await harness.auth(`${control}release?client=${registeredClientId}`, { method: 'POST' }))
					.status,
			).toBe(200);
			const refused = await pending;
			expect(refused.status).toBe(400);
			expect(await refused.json()).toEqual({
				error: race === 'unlink' ? 'invalid_target' : 'invalid_client',
			});
			expect(refused.headers.has('set-cookie')).toBe(false);
			expect(harness.effects).toHaveLength(0);
		} finally {
			try {
				await harness.auth(`/__auth-proof/hold/release?client=${registeredClientId}`, {
					method: 'POST',
				});
				await pending?.catch(() => undefined);
			} finally {
				await harness.close();
			}
		}
	},
);
