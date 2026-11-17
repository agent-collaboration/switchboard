import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';

import {
	epochMillisecondsSchema,
	uuid7Schema,
	type SignInPlatform,
	type Uuid7,
} from '#sign-in-core/contracts/sign-in-platform';
import {
	socialLoginProviderSchema,
	type SocialLoginProvider,
} from '#sign-in-core/contracts/social-login-provider';
import type {
	SignInDatabaseFactory,
	SignInStoreResult,
} from '#sign-in-core/storage/models/sign-in-database';
import { personIdSchema, type PersonId } from '#sign-in-core/storage/models/sign-in-store';
import { account, signInAudit } from '#sign-in-core/storage/sign-in-schema';
import {
	availableStoreValue,
	readStoreValue,
	storeFailure,
} from '#sign-in-core/storage/store-query-results';

export interface LoginLinkAuditChange {
	readonly requestId: Uuid7;
	readonly personId: PersonId;
	readonly provider: SocialLoginProvider;
}
const linkedLoginAuditRowSchema = z.strictObject({
	id: z.string().min(1),
	kind: z.literal('login-linked'),
	actorUserId: personIdSchema,
	requestId: uuid7Schema,
	phase: z.enum(['intent', 'outcome']),
	changeKind: z.literal('linked'),
	targetId: socialLoginProviderSchema,
	at: epochMillisecondsSchema,
});
const linkedLoginAccountSchema = z.strictObject({
	id: uuid7Schema,
	userId: personIdSchema,
	providerId: socialLoginProviderSchema,
});
export interface LinkedLoginAuditRecords {
	readonly record: (
		change: LoginLinkAuditChange,
		phase: 'intent' | 'outcome',
	) => Promise<SignInStoreResult<void>>;
	readonly read: (
		requestId: Uuid7,
	) => Promise<SignInStoreResult<readonly z.infer<typeof linkedLoginAuditRowSchema>[]>>;
	readonly readAccount: (
		accountId: Uuid7,
	) => Promise<SignInStoreResult<z.infer<typeof linkedLoginAccountSchema> | null>>;
}

export function createLinkedLoginAudit(props: {
	readonly openDatabase: SignInDatabaseFactory;
	readonly platform: SignInPlatform;
}): LinkedLoginAuditRecords {
	return {
		async record(
			change: LoginLinkAuditChange,
			phase: 'intent' | 'outcome',
		): Promise<SignInStoreResult<void>> {
			try {
				await props
					.openDatabase()
					.insert(signInAudit)
					.values({
						id: `${change.requestId}:login-linked:${phase}`,
						kind: 'login-linked',
						actorUserId: change.personId,
						requestId: change.requestId,
						phase,
						changeKind: 'linked',
						targetId: change.provider,
						at: props.platform.clock.now(),
					})
					.returning({ id: signInAudit.id });
				return availableStoreValue(undefined);
			} catch (error) {
				return storeFailure(error);
			}
		},
		read(
			requestId: Uuid7,
		): Promise<SignInStoreResult<readonly z.infer<typeof linkedLoginAuditRowSchema>[]>> {
			return readStoreValue(
				async () =>
					await props
						.openDatabase()
						.select({
							id: signInAudit.id,
							kind: signInAudit.kind,
							actorUserId: signInAudit.actorUserId,
							requestId: signInAudit.requestId,
							phase: signInAudit.phase,
							changeKind: signInAudit.changeKind,
							targetId: signInAudit.targetId,
							at: signInAudit.at,
						})
						.from(signInAudit)
						.where(
							inArray(signInAudit.id, [
								`${requestId}:login-linked:intent`,
								`${requestId}:login-linked:outcome`,
							]),
						),
				z.array(linkedLoginAuditRowSchema),
			);
		},
		readAccount(
			accountId: Uuid7,
		): Promise<SignInStoreResult<z.infer<typeof linkedLoginAccountSchema> | null>> {
			return readStoreValue(
				async () =>
					(
						await props
							.openDatabase()
							.select({ id: account.id, userId: account.userId, providerId: account.providerId })
							.from(account)
							.where(eq(account.id, accountId))
							.limit(1)
					)[0] ?? null,
				linkedLoginAccountSchema.nullable(),
			);
		},
	};
}
