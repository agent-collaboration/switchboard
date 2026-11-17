import * as signInTables from '@agent-collaboration/sign-in-core';
import { and, eq, sql as fixtureSql } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { z } from 'zod';

import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import {
	registeredClientId,
	registrationRequestId,
	startLocalAuthHarness,
	workspaceAudience,
	workspaceOne,
} from '#sign-in-test-support/test-fixtures/local-auth-harness';
import {
	addWorkspaceAgent,
	agentCredentialSchema,
	workspaceToken,
} from '#sign-in-test-support/test-fixtures/workspace-agent-proof';

useControlledSignInClock();

it.each([
	{ entity: 'resource-changed', phase: 'intent', resources: 0, clients: 0, links: 0 },
	{ entity: 'resource-changed', phase: 'outcome', resources: 1, clients: 0, links: 0 },
	{ entity: 'client-link-changed', phase: 'intent', resources: 1, clients: 1, links: 0 },
	{ entity: 'client-link-changed', phase: 'outcome', resources: 1, clients: 1, links: 1 },
])(
	'agent: an actual $entity $phase audit failure withholds workspace credentials until the same-operation retry',
	async (fault) => {
		const harness = await startLocalAuthHarness();
		try {
			const owner = await harness.ownerToken();
			await harness.setDatabaseFault({
				operation: 'insert',
				table: 'sign_in_audit',
				key: registrationRequestId,
				auditKind: fault.entity,
				phase: z.enum(['intent', 'outcome']).parse(fault.phase),
			});
			const failed = await addWorkspaceAgent({
				harness,
				owner,
				workspaceId: workspaceOne,
				requestId: registrationRequestId,
			});
			expect(failed.status).toBe(503);
			// An incomplete result identifies the retry but never includes a credential.
			expect(await failed.json()).toEqual({ kind: 'incomplete', clientId: registeredClientId });
			expect(
				await harness.database
					.select({ identifier: fixtureSql`${signInTables.oauthResource.identifier}` })
					.from(signInTables.oauthResource)
					.where(eq(signInTables.oauthResource.identifier, workspaceAudience(workspaceOne))),
			).toHaveLength(fault.resources);
			expect(
				await harness.database
					.select({ clientId: fixtureSql`${signInTables.oauthClient.clientId}` })
					.from(signInTables.oauthClient)
					.where(eq(signInTables.oauthClient.clientId, registeredClientId)),
			).toHaveLength(fault.clients);
			expect(
				await harness.database
					.select({ resourceId: fixtureSql`${signInTables.oauthClientResource.resourceId}` })
					.from(signInTables.oauthClientResource)
					.where(eq(signInTables.oauthClientResource.clientId, registeredClientId)),
			).toHaveLength(fault.links);
			expect(
				await (
					await harness.gateway(
						`/__auth-proof?workspace=${workspaceOne}&client=${registeredClientId}`,
					)
				).json(),
			).not.toHaveProperty(`member:${registeredClientId}`);
			const failedRecord = await harness.database
				.select({ id: fixtureSql`${signInTables.signInAudit.id}` })
				.from(signInTables.signInAudit)
				.where(
					and(
						eq(signInTables.signInAudit.requestId, registrationRequestId),
						eq(signInTables.signInAudit.kind, fault.entity),
						eq(signInTables.signInAudit.phase, fault.phase),
					),
				);
			expect(failedRecord).toEqual([]);
			await harness.setDatabaseFault(null);
			const retried = await addWorkspaceAgent({
				harness,
				owner,
				workspaceId: workspaceOne,
				requestId: registrationRequestId,
			});
			expect(retried.status).toBe(200);
			const credential = agentCredentialSchema.parse(await retried.json());
			expect(credential.clientId).toBe(registeredClientId);
			expect(
				await harness.database
					.select({ clientId: fixtureSql`${signInTables.oauthClient.clientId}` })
					.from(signInTables.oauthClient)
					.where(eq(signInTables.oauthClient.clientId, registeredClientId)),
			).toEqual([{ clientId: registeredClientId }]);
			await Promise.all(
				['resource-changed', 'client-link-changed', 'client-changed', 'client-management'].map(
					async (entity): Promise<void> => {
						const rows = await harness.database
							.selectDistinct({ phase: fixtureSql`${signInTables.signInAudit.phase}` })
							.from(signInTables.signInAudit)
							.where(
								and(
									eq(signInTables.signInAudit.requestId, registrationRequestId),
									eq(signInTables.signInAudit.kind, entity),
								),
							)
							.orderBy(signInTables.signInAudit.phase);
						expect(rows).toEqual([{ phase: 'intent' }, { phase: 'outcome' }]);
					},
				),
			);
			expect(await workspaceToken({ harness, credential, workspaceId: workspaceOne })).toBeTypeOf(
				'string',
			);
		} finally {
			await harness.close();
		}
	},
);
