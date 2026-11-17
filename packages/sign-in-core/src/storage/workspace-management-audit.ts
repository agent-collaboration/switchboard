import { eq } from 'drizzle-orm';
import { z } from 'zod';

import type { AgentManagementOperation } from '#sign-in-core/agent-clients/agent-registration';
import type { SignInPlatform } from '#sign-in-core/contracts/sign-in-platform';
import type { ManagementWriteResult } from '#sign-in-core/storage/agent-registration-store';
import type {
	SignInDatabaseFactory,
	SignInStoreResult,
} from '#sign-in-core/storage/models/sign-in-database';
import { signInAudit } from '#sign-in-core/storage/sign-in-schema';
import {
	availableStoreValue,
	readStoreValue,
	storeFailure,
} from '#sign-in-core/storage/store-query-results';

export interface WorkspaceManagementAuditEvent {
	readonly requestId: string;
	readonly actorUserId: string;
	readonly kind: 'client-management' | 'resource-changed' | 'client-link-changed';
	readonly change: string;
	readonly targetId: string;
	readonly phase: 'intent' | 'outcome';
}
export interface WorkspaceManagementRecords {
	readonly checkOperation: (
		operation: AgentManagementOperation,
		actorUserId: string,
		clientId: string,
	) => Promise<ManagementWriteResult>;
	readonly reserve: (
		operation: AgentManagementOperation,
		actorUserId: string,
		clientId: string,
	) => Promise<ManagementWriteResult>;
	readonly finish: (
		operation: AgentManagementOperation,
		actorUserId: string,
		clientId: string,
	) => Promise<ManagementWriteResult>;
	readonly record: (event: WorkspaceManagementAuditEvent) => Promise<ManagementWriteResult>;
}
const auditIdentitySchema = z.object({
	kind: z.string(),
	actorUserId: z.string(),
	requestId: z.string(),
	phase: z.string(),
	changeKind: z.string(),
	targetId: z.string(),
});

function operationTarget(operation: AgentManagementOperation, clientId: string): string {
	return JSON.stringify({
		kind: operation.kind,
		organizationId: operation.organizationId,
		clientId,
		...(operation.kind === 'disable' ? {} : { workspaceId: operation.workspaceId }),
	});
}
function operationEvent(
	operation: AgentManagementOperation,
	actorUserId: string,
	clientId: string,
): Omit<WorkspaceManagementAuditEvent, 'phase'> {
	return {
		requestId: operation.requestId,
		actorUserId,
		kind: 'client-management',
		change: operation.kind,
		targetId: operationTarget(operation, clientId),
	};
}
function sameAuditIdentity(
	actual: z.infer<typeof auditIdentitySchema>,
	event: WorkspaceManagementAuditEvent,
): boolean {
	return (
		actual.kind === event.kind &&
		actual.actorUserId === event.actorUserId &&
		actual.requestId === event.requestId &&
		actual.phase === event.phase &&
		actual.changeKind === event.change &&
		actual.targetId === event.targetId
	);
}

export function createWorkspaceManagementAudit(props: {
	readonly openDatabase: SignInDatabaseFactory;
	readonly platform: SignInPlatform;
}): WorkspaceManagementRecords {
	const database = props.openDatabase;
	async function readIdentity(
		id: string,
	): Promise<SignInStoreResult<z.infer<typeof auditIdentitySchema> | null>> {
		return readStoreValue(
			async () =>
				(
					await database()
						.select({
							kind: signInAudit.kind,
							actorUserId: signInAudit.actorUserId,
							requestId: signInAudit.requestId,
							phase: signInAudit.phase,
							changeKind: signInAudit.changeKind,
							targetId: signInAudit.targetId,
						})
						.from(signInAudit)
						.where(eq(signInAudit.id, id))
						.limit(1)
				)[0] ?? null,
			auditIdentitySchema.nullable(),
		);
	}
	async function record(event: WorkspaceManagementAuditEvent): Promise<ManagementWriteResult> {
		const id = `${event.requestId}:${event.kind}:${event.phase}`;
		try {
			await database()
				.insert(signInAudit)
				.values({
					id,
					kind: event.kind,
					actorUserId: event.actorUserId,
					requestId: event.requestId,
					phase: event.phase,
					changeKind: event.change,
					targetId: event.targetId,
					at: props.platform.clock.now(),
				})
				.onConflictDoNothing()
				.returning({ id: signInAudit.id });
			const actual = await readIdentity(id);
			if (actual.kind !== 'available') return actual;
			if (actual.value === null) return { kind: 'store-unavailable', reason: 'database-error' };
			return sameAuditIdentity(actual.value, event)
				? availableStoreValue(undefined)
				: { kind: 'operation-conflict' };
		} catch (error) {
			return storeFailure(error);
		}
	}
	return {
		record,
		async checkOperation(operation, actorUserId, clientId): Promise<ManagementWriteResult> {
			const actual = await readIdentity(`${operation.requestId}:client-management:intent`);
			if (actual.kind !== 'available') return actual;
			if (actual.value === null) return availableStoreValue(undefined);
			const expected = {
				...operationEvent(operation, actorUserId, clientId),
				phase: 'intent',
			} satisfies WorkspaceManagementAuditEvent;
			return sameAuditIdentity(actual.value, expected)
				? availableStoreValue(undefined)
				: { kind: 'operation-conflict' };
		},
		reserve: async (operation, actorUserId, clientId): Promise<ManagementWriteResult> =>
			record({ ...operationEvent(operation, actorUserId, clientId), phase: 'intent' }),
		finish: async (operation, actorUserId, clientId): Promise<ManagementWriteResult> =>
			record({ ...operationEvent(operation, actorUserId, clientId), phase: 'outcome' }),
	};
}
