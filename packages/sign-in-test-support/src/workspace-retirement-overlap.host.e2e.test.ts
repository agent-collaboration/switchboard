import * as signInTables from '@agent-collaboration/sign-in-core';
import { and, eq, sql as fixtureSql } from 'drizzle-orm';
import { expect, it } from 'vitest';

import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import { controlledSignInIds } from '#sign-in-test-support/test-fixtures/controlled-sign-in-clock';
import {
	organizationOne,
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

it.each(['retirement supersedes pending unlink', 'stale unlink retry reads retirement'] as const)(
	'agent: $0 without unlinking or repeating global disable',
	async (scenario) => {
		const harness = await startLocalAuthHarness();
		const retirementRequestId = controlledSignInIds.nextId();
		let retirement: Promise<Response> | undefined;
		let holdArmed = false;
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
						requestId: controlledSignInIds.nextId(),
						clientId: credential.clientId,
					})
				).status,
			).toBe(200);
			const old = await workspaceToken({ harness, credential, workspaceId: workspaceOne });
			await harness.setDatabaseFault({
				operation: 'delete',
				table: 'oauthClientResource',
				key: registeredClientId,
			});
			// Record successful real provider driver writes in the test host.
			await harness.observeDisableWrites(registeredClientId);
			const unlinkRequestId = controlledSignInIds.nextId();
			const removalPath = `/management/workspaces/${workspaceOne}/agents/${credential.clientId}`;
			const unlink = {
				method: 'DELETE',
				headers: { authorization: `Bearer ${owner}`, 'content-type': 'application/json' },
				body: JSON.stringify({ requestId: unlinkRequestId }),
			};
			expect((await harness.gateway(removalPath, unlink)).status).toBe(202);
			async function workspaceState(workspaceId: string): Promise<unknown> {
				return (
					await harness.gateway(
						`/__auth-proof?workspace=${workspaceId}&client=${credential.clientId}`,
					)
				).json();
			}
			expect(await workspaceState(workspaceOne)).toEqual({
				[`member:${credential.clientId}`]: { state: 'removed', persona: 'operator' },
				[`member-removal:${credential.clientId}`]: {
					kind: 'pending',
					operation: 'unlink',
					requestId: unlinkRequestId,
				},
			});
			const unlinkAuditBefore = await harness.database
				.select(storedRowProjection(signInTables.signInAudit))
				.from(signInTables.signInAudit)
				.where(
					and(
						eq(signInTables.signInAudit.kind, 'client-link-changed'),
						eq(signInTables.signInAudit.changeKind, 'unlinked'),
					),
				)
				.orderBy(signInTables.signInAudit.id);
			holdArmed = true;
			expect(await harness.managementHolds.armManagementHold(retirementRequestId)).toEqual({
				armed: true,
			});
			retirement = harness.gateway(
				`/management/organizations/${organizationOne}/agents/${credential.clientId}`,
				{
					method: 'DELETE',
					headers: { authorization: `Bearer ${owner}`, 'content-type': 'application/json' },
					body: JSON.stringify({ requestId: retirementRequestId }),
				},
			);
			void retirement.catch(() => undefined);
			expect(await harness.managementHolds.enteredManagementHold(retirementRequestId)).toEqual({
				point: 'before-provider-owner-read',
				requestId: retirementRequestId,
			});
			for (const state of await Promise.all([
				workspaceState(workspaceOne),
				workspaceState(workspaceTwo),
			])) {
				expect(state).toEqual({
					[`member:${credential.clientId}`]: { state: 'removed', persona: 'operator' },
					[`member-removal:${credential.clientId}`]: {
						kind: 'pending',
						operation: 'disable',
						requestId: retirementRequestId,
					},
				});
			}
			const effectsBefore = [...harness.effects];
			expect(
				(
					await callWorkspaceTool({
						harness,
						workspaceId: workspaceOne,
						token: old,
						correlation: 'retirement-pending',
					})
				).status,
			).toBe(401);
			expect(harness.effects).toEqual(effectsBefore);
			expect(
				(await workspaceTokenResponse({ harness, credential, workspaceId: workspaceOne })).status,
			).toBe(200);
			await harness.managementHolds.releaseManagementHold(retirementRequestId);
			holdArmed = false;
			const result = await retirement;
			expect(result.status).toBe(200);
			expect(await result.json()).toEqual({ kind: 'removed', clientId: credential.clientId });
			const completedStates = await Promise.all([
				workspaceState(workspaceOne),
				workspaceState(workspaceTwo),
			]);
			for (const state of completedStates)
				expect(state).toEqual({
					[`member:${credential.clientId}`]: { state: 'removed', persona: 'operator' },
					[`member-removal:${credential.clientId}`]: {
						kind: 'complete',
						operation: 'disable',
						requestId: retirementRequestId,
					},
				});
			if (scenario === 'stale unlink retry reads retirement') {
				const stale = await harness.gateway(removalPath, unlink);
				expect(stale.status).toBe(200);
				expect(await stale.json()).toEqual({
					kind: 'removed',
					clientId: credential.clientId,
				});
				expect(
					await Promise.all([workspaceState(workspaceOne), workspaceState(workspaceTwo)]),
				).toEqual(completedStates);
			}
			expect(await harness.readDisableWrites()).toEqual([{ client_id: credential.clientId }]);
			expect(
				await harness.database
					.select(storedRowProjection(signInTables.signInAudit))
					.from(signInTables.signInAudit)
					.where(
						and(
							eq(signInTables.signInAudit.kind, 'client-link-changed'),
							eq(signInTables.signInAudit.changeKind, 'unlinked'),
						),
					)
					.orderBy(signInTables.signInAudit.id),
			).toEqual(unlinkAuditBefore);
			expect(
				await harness.database
					.select({ resourceId: fixtureSql`${signInTables.oauthClientResource.resourceId}` })
					.from(signInTables.oauthClientResource)
					.where(eq(signInTables.oauthClientResource.clientId, credential.clientId))
					.orderBy(signInTables.oauthClientResource.resourceId),
			).toEqual(
				[workspaceOne, workspaceTwo].map((workspaceId) => ({
					resourceId: workspaceAudience(workspaceId),
				})),
			);
			expect(
				await harness.database
					.select({ disabled: fixtureSql`coalesce(${signInTables.oauthClient.disabled}, ${0})` })
					.from(signInTables.oauthClient)
					.where(eq(signInTables.oauthClient.clientId, credential.clientId))
					.limit(1)
					.then((storedRows) => storedRows[0] ?? null),
			).toEqual({ disabled: 1 });
			expect(
				await (
					await workspaceTokenResponse({ harness, credential, workspaceId: workspaceTwo })
				).json(),
			).toMatchObject({ error: 'invalid_client' });
		} finally {
			if (holdArmed) await harness.managementHolds.releaseManagementHold(retirementRequestId);
			await retirement?.catch(() => undefined);
			await harness.close();
		}
	},
);

it('agent: retirement after completed unlinks keeps an incomplete disable ID for GET recovery', async () => {
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
		const headers = { authorization: `Bearer ${owner}`, 'content-type': 'application/json' };
		await Promise.all(
			[workspaceOne, workspaceTwo].map(async (workspaceId): Promise<void> => {
				expect(
					(
						await harness.gateway(
							`/management/workspaces/${workspaceId}/agents/${credential.clientId}`,
							{
								method: 'DELETE',
								headers,
								body: JSON.stringify({ requestId: controlledSignInIds.nextId() }),
							},
						)
					).status,
				).toBe(200);
				expect(
					await (
						await harness.gateway(
							`/__auth-proof?workspace=${workspaceId}&client=${credential.clientId}`,
						)
					).json(),
				).toMatchObject({
					[`member:${credential.clientId}`]: { state: 'removed', persona: 'operator' },
					[`member-removal:${credential.clientId}`]: { kind: 'complete', operation: 'unlink' },
				});
			}),
		);
		const retirementId = controlledSignInIds.nextId();
		const endpoint = `/management/organizations/${organizationOne}/agents/${credential.clientId}`;
		await harness.setDatabaseFault({
			operation: 'update',
			table: 'oauthClient',
			key: registeredClientId,
			column: 'disabled',
		});
		try {
			const pending = await harness.gateway(endpoint, {
				method: 'DELETE',
				headers,
				body: JSON.stringify({ requestId: retirementId }),
			});
			expect(pending.status).toBe(202);
			expect(await pending.json()).toEqual({
				kind: 'removal-pending',
				clientId: credential.clientId,
			});
			await Promise.all(
				[workspaceOne, workspaceTwo].map(async (workspaceId): Promise<void> => {
					expect(
						await (
							await harness.gateway(
								`/__auth-proof?workspace=${workspaceId}&client=${credential.clientId}`,
							)
						).json(),
					).toEqual({
						[`member:${credential.clientId}`]: { state: 'removed', persona: 'operator' },
						[`member-removal:${credential.clientId}`]: {
							kind: 'pending',
							operation: 'disable',
							requestId: retirementId,
						},
					});
				}),
			);
			expect((await harness.gateway(endpoint, { headers })).status).toBe(202);
			expect(
				await harness.database
					.select({ disabled: fixtureSql`coalesce(${signInTables.oauthClient.disabled}, ${0})` })
					.from(signInTables.oauthClient)
					.where(eq(signInTables.oauthClient.clientId, credential.clientId))
					.limit(1)
					.then((storedRows) => storedRows[0] ?? null),
			).toEqual({ disabled: 0 });
		} finally {
			await harness.setDatabaseFault(null);
		}
		const completed = await harness.gateway(endpoint, { headers });
		expect(completed.status).toBe(200);
		expect(await completed.json()).toEqual({ kind: 'removed', clientId: credential.clientId });
		await Promise.all(
			[workspaceOne, workspaceTwo].map(async (workspaceId): Promise<void> => {
				expect(
					await (
						await harness.gateway(
							`/__auth-proof?workspace=${workspaceId}&client=${credential.clientId}`,
						)
					).json(),
				).toEqual({
					[`member:${credential.clientId}`]: { state: 'removed', persona: 'operator' },
					[`member-removal:${credential.clientId}`]: {
						kind: 'complete',
						operation: 'disable',
						requestId: retirementId,
					},
				});
			}),
		);
		expect(
			await harness.database
				.select({ disabled: fixtureSql`coalesce(${signInTables.oauthClient.disabled}, ${0})` })
				.from(signInTables.oauthClient)
				.where(eq(signInTables.oauthClient.clientId, credential.clientId))
				.limit(1)
				.then((storedRows) => storedRows[0] ?? null),
		).toEqual({ disabled: 1 });
	} finally {
		await harness.close();
	}
});
