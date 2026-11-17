import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import {
	agentRegistrationSchema,
	type AgentRegistration,
} from '#sign-in-core/agent-clients/agent-registration';
import type { SignInPlatform } from '#sign-in-core/contracts/sign-in-platform';
import type { AgentAuditChange } from '#sign-in-core/security-audit/agent-client-audit';
import { jsonTextSchema } from '#sign-in-core/storage/json-text-schema';
import type {
	SignInDatabaseFactory,
	SignInStoreResult,
} from '#sign-in-core/storage/models/sign-in-database';
import {
	oauthClient,
	oauthClientResource,
	signInAudit,
} from '#sign-in-core/storage/sign-in-schema';
import {
	availableStoreValue,
	readStoreValue,
	storeFailure,
} from '#sign-in-core/storage/store-query-results';

export type ManagementRecordConflict = { readonly kind: 'operation-conflict' };
export type ManagementWriteResult = SignInStoreResult<void> | ManagementRecordConflict;
export interface AgentRegistrationRecords {
	readonly clientExists: (clientId: string) => Promise<SignInStoreResult<boolean>>;
	readonly read: (clientId: string) => Promise<SignInStoreResult<AgentRegistration | null>>;
	readonly record: (
		change: AgentAuditChange,
		phase: 'intent' | 'outcome',
	) => Promise<ManagementWriteResult>;
	readonly complete: (
		change: AgentAuditChange,
	) => Promise<SignInStoreResult<boolean> | ManagementRecordConflict>;
}

const clientRowSchema = agentRegistrationSchema
	.pick({
		clientId: true,
		metadata: true,
		grantTypes: true,
		clientCredentialsScopes: true,
		tokenEndpointAuthMethod: true,
	})
	.extend({
		metadata: jsonTextSchema(agentRegistrationSchema.shape.metadata),
		grantTypes: jsonTextSchema(agentRegistrationSchema.shape.grantTypes),
		clientCredentialsScopes: jsonTextSchema(agentRegistrationSchema.shape.clientCredentialsScopes),
		disabled: z.boolean().nullable().transform(Boolean),
	});
const auditRowSchema = z.object({
	actorUserId: z.string(),
	targetId: z.string(),
	changeKind: z.string(),
});

export function createAgentRegistrationStore(props: {
	readonly openDatabase: SignInDatabaseFactory;
	readonly platform: SignInPlatform;
}): AgentRegistrationRecords {
	const database = props.openDatabase;
	async function hasRecord(
		change: AgentAuditChange,
		phase: 'intent' | 'outcome',
	): Promise<SignInStoreResult<boolean> | ManagementRecordConflict> {
		const record = await readStoreValue(
			async () =>
				(
					await database()
						.select({
							actorUserId: signInAudit.actorUserId,
							targetId: signInAudit.targetId,
							changeKind: signInAudit.changeKind,
						})
						.from(signInAudit)
						.where(eq(signInAudit.id, `${change.requestId}:${change.change}:${phase}`))
						.limit(1)
				)[0] ?? null,
			auditRowSchema.nullable(),
		);
		if (record.kind !== 'available') return record;
		if (record.value === null) return availableStoreValue(false);
		if (
			record.value.actorUserId !== change.actorUserId ||
			record.value.targetId !== change.clientId ||
			record.value.changeKind !== change.change
		)
			return { kind: 'operation-conflict' };
		return availableStoreValue(true);
	}
	return {
		async clientExists(clientId): Promise<SignInStoreResult<boolean>> {
			const rows = await readStoreValue(
				async () =>
					await database()
						.select({ clientId: oauthClient.clientId })
						.from(oauthClient)
						.where(eq(oauthClient.clientId, clientId))
						.limit(1),
				z.array(z.object({ clientId: z.string() })),
			);
			return rows.kind === 'available' ? availableStoreValue(rows.value.length > 0) : rows;
		},
		async read(clientId): Promise<SignInStoreResult<AgentRegistration | null>> {
			const client = await readStoreValue(
				async () =>
					(
						await database()
							.select({
								clientId: oauthClient.clientId,
								metadata: oauthClient.metadata,
								grantTypes: oauthClient.grantTypes,
								clientCredentialsScopes: oauthClient.clientCredentialsScopes,
								tokenEndpointAuthMethod: oauthClient.tokenEndpointAuthMethod,
								disabled: oauthClient.disabled,
							})
							.from(oauthClient)
							.where(eq(oauthClient.clientId, clientId))
							.limit(1)
					)[0] ?? null,
				clientRowSchema.nullable(),
			);
			if (client.kind !== 'available') return client;
			if (client.value === null) return availableStoreValue(null);
			const links = await readStoreValue(
				async () =>
					await database()
						.select({ resourceId: oauthClientResource.resourceId })
						.from(oauthClientResource)
						.where(eq(oauthClientResource.clientId, clientId))
						.orderBy(oauthClientResource.resourceId),
				z.array(z.object({ resourceId: z.string() })),
			);
			if (links.kind !== 'available') return links;
			const completion = await readStoreValue(
				async () =>
					await database()
						.select({ id: signInAudit.id })
						.from(signInAudit)
						.where(
							and(
								eq(signInAudit.kind, 'client-changed'),
								eq(signInAudit.targetId, clientId),
								eq(signInAudit.changeKind, 'registered'),
								eq(signInAudit.phase, 'outcome'),
							),
						)
						.limit(1),
				z.array(z.object({ id: z.string() })),
			);
			if (completion.kind !== 'available') return completion;
			const registration = agentRegistrationSchema.safeParse({
				...client.value,
				resourceIds: links.value.map((link) => link.resourceId),
				registrationComplete: completion.value.length > 0,
			});
			return registration.success
				? availableStoreValue(registration.data)
				: { kind: 'store-unavailable', reason: 'row-unparseable' };
		},
		async record(change, phase): Promise<ManagementWriteResult> {
			try {
				await database()
					.insert(signInAudit)
					.values({
						id: `${change.requestId}:${change.change}:${phase}`,
						kind: 'client-changed',
						actorUserId: change.actorUserId,
						requestId: change.requestId,
						phase,
						changeKind: change.change,
						targetId: change.clientId,
						at: props.platform.clock.now(),
					})
					.onConflictDoNothing()
					.returning({ id: signInAudit.id });
				const recorded = await hasRecord(change, phase);
				if (recorded.kind !== 'available') return recorded;
				return recorded.value
					? availableStoreValue(undefined)
					: { kind: 'store-unavailable', reason: 'database-error' };
			} catch (error) {
				return storeFailure(error);
			}
		},
		async complete(change): Promise<SignInStoreResult<boolean> | ManagementRecordConflict> {
			const intent = await hasRecord(change, 'intent');
			if (intent.kind !== 'available' || !intent.value) return intent;
			return hasRecord(change, 'outcome');
		},
	};
}
