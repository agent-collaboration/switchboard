import { oauthClient, signInAudit } from '@agent-collaboration/sign-in-core';
import { eq } from 'drizzle-orm';

import type { StorageCaseContext } from '#sign-in-test-support/storage-cases/storage-case-context';
import {
	readManagementClientRows,
	readManagementAuditRows,
} from '#sign-in-test-support/test-fixtures/management-refusal-readback';

export async function storedSecretOnlyUpdate(context: StorageCaseContext): Promise<unknown> {
	const clientId = 'readback-agent';
	await context.openDatabase().insert(oauthClient).values({
		id: context.platform.ids.nextId(),
		clientId,
		clientSecret: 'original-stored-hash',
		disabled: false,
		metadata: '{}',
		grantTypes: '["client_credentials"]',
		redirectUris: '[]',
	});
	const beforeProtected = await readManagementClientRows(context.openDatabase());
	await context
		.openDatabase()
		.update(oauthClient)
		.set({ clientSecret: 'unauthorized-changed-hash' })
		.where(eq(oauthClient.clientId, clientId));
	return {
		beforeProtected,
		afterProtected: await readManagementClientRows(context.openDatabase()),
		beforeAudit: [],
		afterAudit: [],
		attributableActors: [clientId],
		forbiddenValues: [],
	};
}

export async function appendedAttributableRefusal(context: StorageCaseContext): Promise<unknown> {
	await context.openDatabase().insert(signInAudit).values({
		id: context.platform.ids.nextId(),
		kind: 'client-changed',
		actorUserId: 'owner',
		requestId: 'registered',
		phase: 'outcome',
		changeKind: 'registered',
		targetId: 'agent',
		at: 1,
	});
	const beforeAudit = await readManagementAuditRows(context.openDatabase());
	await context.openDatabase().insert(signInAudit).values({
		id: context.platform.ids.nextId(),
		kind: 'sign-in',
		actorUserId: 'agent',
		requestId: 'attempt',
		phase: 'outcome',
		changeKind: 'failed',
		targetId: 'management',
		at: 2,
	});
	return {
		beforeProtected: ['unchanged-stored-hash'],
		afterProtected: ['unchanged-stored-hash'],
		beforeAudit,
		afterAudit: await readManagementAuditRows(context.openDatabase()),
		attributableActors: ['agent'],
		forbiddenValues: [],
	};
}
