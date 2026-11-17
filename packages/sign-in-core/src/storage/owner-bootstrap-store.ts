import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import type { SignInPlatform } from '#sign-in-core/contracts/sign-in-platform';
import type { ManagementWriteResult } from '#sign-in-core/storage/agent-registration-store';
import { jsonTextSchema } from '#sign-in-core/storage/json-text-schema';
import type {
	SignInDatabaseFactory,
	SignInStoreResult,
} from '#sign-in-core/storage/models/sign-in-database';
import {
	oauthClient,
	oauthClientResource,
	oauthResource,
	signInAudit,
} from '#sign-in-core/storage/sign-in-schema';
import {
	availableStoreValue,
	readStoreValue,
	storeFailure,
} from '#sign-in-core/storage/store-query-results';

const systemClientSchema = z.object({
	clientId: z.string(),
	scopes: jsonTextSchema(z.array(z.string()).nullable()).nullable(),
	skipConsent: z.boolean().nullable(),
	tokenEndpointAuthMethod: z.string().nullable(),
	applicationType: z.string().nullable(),
	grantTypes: jsonTextSchema(z.array(z.string()).nullable()).nullable(),
	redirectUris: jsonTextSchema(z.array(z.string())),
	requirePKCE: z.boolean().nullable(),
});
/** A system client the owner bootstrap creates: the management CLI, or the admin page. */
export type SystemClientRecord = z.infer<typeof systemClientSchema>;
const systemResourceSchema = z.object({
	identifier: z.url(),
	dpopBoundAccessTokensRequired: z.boolean().nullable().transform(Boolean),
	allowedScopes: jsonTextSchema(z.array(z.string()).nullable()).nullable(),
	accessTokenTtl: z.number().int().positive().nullable(),
	disabled: z.boolean().nullable().transform(Boolean),
	metadata: jsonTextSchema(z.null()).nullable(),
	customClaims: jsonTextSchema(z.record(z.string(), z.unknown()).nullable()).nullable(),
});
/** A statically seeded resource: the management audience, or the central admin audience. */
export type SystemResourceRecord = z.infer<typeof systemResourceSchema>;
export interface OwnerBootstrapRecords {
	readonly readSystemResource: (
		identifier: string,
	) => Promise<SignInStoreResult<SystemResourceRecord | null>>;
	readonly record: (props: {
		readonly clientId: string;
		readonly actorUserId: string;
		readonly phase: 'intent' | 'outcome';
	}) => Promise<ManagementWriteResult>;
	readonly readClient: (clientId: string) => Promise<SignInStoreResult<SystemClientRecord | null>>;
	readonly readLinks: (clientId: string) => Promise<SignInStoreResult<readonly string[]>>;
	readonly readAuditIds: (
		clientId: string,
		actorUserId: string,
	) => Promise<SignInStoreResult<readonly string[]>>;
	readonly recordSignIn: (props: {
		readonly actor: string;
		readonly outcome: 'succeeded' | 'failed';
		readonly method: string;
	}) => Promise<ManagementWriteResult>;
}

export function createOwnerBootstrapStore(props: {
	readonly openDatabase: SignInDatabaseFactory;
	readonly platform: SignInPlatform;
}): OwnerBootstrapRecords {
	return {
		async readSystemResource(identifier): Promise<SignInStoreResult<SystemResourceRecord | null>> {
			return readStoreValue(
				async () =>
					(
						await props
							.openDatabase()
							.select({
								identifier: oauthResource.identifier,
								dpopBoundAccessTokensRequired: oauthResource.dpopBoundAccessTokensRequired,
								allowedScopes: oauthResource.allowedScopes,
								accessTokenTtl: oauthResource.accessTokenTtl,
								disabled: oauthResource.disabled,
								metadata: oauthResource.metadata,
								customClaims: oauthResource.customClaims,
							})
							.from(oauthResource)
							.where(eq(oauthResource.identifier, identifier))
							.limit(1)
					)[0] ?? null,
				systemResourceSchema.nullable(),
			);
		},
		async record({ clientId, actorUserId, phase }): Promise<ManagementWriteResult> {
			const requestId = `owner-cli:${clientId}`;
			try {
				await props
					.openDatabase()
					.insert(signInAudit)
					.values({
						id: `${requestId}:${phase}`,
						kind: 'client-changed',
						actorUserId,
						requestId,
						phase,
						changeKind: 'registered',
						targetId: clientId,
						at: props.platform.clock.now(),
					})
					.onConflictDoNothing()
					.returning({ id: signInAudit.id });
				return availableStoreValue(undefined);
			} catch (error) {
				return storeFailure(error);
			}
		},
		async readClient(clientId): Promise<SignInStoreResult<SystemClientRecord | null>> {
			return readStoreValue(
				async () =>
					(
						await props
							.openDatabase()
							.select({
								clientId: oauthClient.clientId,
								scopes: oauthClient.scopes,
								skipConsent: oauthClient.skipConsent,
								tokenEndpointAuthMethod: oauthClient.tokenEndpointAuthMethod,
								applicationType: oauthClient.applicationType,
								grantTypes: oauthClient.grantTypes,
								redirectUris: oauthClient.redirectUris,
								requirePKCE: oauthClient.requirePKCE,
							})
							.from(oauthClient)
							.where(eq(oauthClient.clientId, clientId))
							.limit(1)
					)[0] ?? null,
				systemClientSchema.nullable(),
			);
		},
		async readLinks(clientId): Promise<SignInStoreResult<readonly string[]>> {
			const links = await readStoreValue(
				async () =>
					await props
						.openDatabase()
						.select({ resourceId: oauthClientResource.resourceId })
						.from(oauthClientResource)
						.where(eq(oauthClientResource.clientId, clientId)),
				z.array(z.object({ resourceId: z.string() })),
			);
			return links.kind === 'available'
				? availableStoreValue(links.value.map((link) => link.resourceId))
				: links;
		},
		async readAuditIds(clientId, actorUserId): Promise<SignInStoreResult<readonly string[]>> {
			const records = await readStoreValue(
				async () =>
					await props
						.openDatabase()
						.select({ id: signInAudit.id })
						.from(signInAudit)
						.where(
							and(
								eq(signInAudit.requestId, `owner-cli:${clientId}`),
								eq(signInAudit.actorUserId, actorUserId),
							),
						),
				z.array(z.object({ id: z.string() })),
			);
			return records.kind === 'available'
				? availableStoreValue(records.value.map((record) => record.id))
				: records;
		},
		async recordSignIn({ actor, outcome, method }): Promise<ManagementWriteResult> {
			const requestId = props.platform.ids.nextId();
			try {
				await props
					.openDatabase()
					.insert(signInAudit)
					.values({
						id: requestId,
						kind: 'sign-in',
						actorUserId: actor,
						requestId,
						phase: 'outcome',
						changeKind: outcome,
						targetId: method,
						at: props.platform.clock.now(),
					})
					.returning({ id: signInAudit.id });
				return availableStoreValue(undefined);
			} catch (error) {
				return storeFailure(error);
			}
		},
	};
}
