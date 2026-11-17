import { eq } from 'drizzle-orm';
import { z } from 'zod';

import {
	epochMillisecondsSchema,
	type SignInPlatform,
} from '#sign-in-core/contracts/sign-in-platform';
import {
	factorChangeSchema,
	type FactorChangeRecords,
} from '#sign-in-core/second-factors/factor-change-record';
import type { SignInDatabaseFactory } from '#sign-in-core/storage/models/sign-in-database';
import { signInAudit } from '#sign-in-core/storage/sign-in-schema';
import {
	availableStoreValue,
	readStoreValue,
	storeFailure,
} from '#sign-in-core/storage/store-query-results';

/** Personal factors span organizations, so their audit organization is null.
 * No code, secret, credential public key, user-supplied name or challenge is recorded. */
export function createFactorChangeAudit(props: {
	readonly openDatabase: SignInDatabaseFactory;
	readonly platform: Pick<SignInPlatform, 'clock'>;
}): FactorChangeRecords {
	return {
		async record(change, phase) {
			if (!factorChangeSchema.safeParse(change).success)
				return { kind: 'store-unavailable', reason: 'row-unparseable' };
			const id = `${change.requestId}:${change.action}:${phase}`;
			try {
				await props
					.openDatabase()
					.insert(signInAudit)
					.values({
						id,
						kind: 'second-factor-changed',
						actorUserId: change.actorPersonId,
						requestId: change.requestId,
						phase,
						changeKind: change.action,
						targetId: change.targetId,
						organizationId: null,
						at: props.platform.clock.now(),
					})
					.onConflictDoNothing()
					.returning({ id: signInAudit.id });
				const row = await readStoreValue(
					async () =>
						(
							await props
								.openDatabase()
								.select({
									id: signInAudit.id,
									kind: signInAudit.kind,
									at: signInAudit.at,
									actorPersonId: signInAudit.actorUserId,
									requestId: signInAudit.requestId,
									action: signInAudit.changeKind,
									targetId: signInAudit.targetId,
									phase: signInAudit.phase,
									organizationId: signInAudit.organizationId,
								})
								.from(signInAudit)
								.where(eq(signInAudit.id, id))
						)[0] ?? null,
					factorChangeSchema
						.extend({
							id: z.string(),
							kind: z.literal('second-factor-changed'),
							at: epochMillisecondsSchema,
							phase: z.enum(['intent', 'outcome']),
							organizationId: z.null(),
						})
						.nullable(),
				);
				if (row.kind === 'store-unavailable') return row;
				if (
					row.value === null ||
					row.value.actorPersonId !== change.actorPersonId ||
					row.value.requestId !== change.requestId ||
					row.value.action !== change.action ||
					row.value.targetId !== change.targetId ||
					row.value.phase !== phase
				)
					return { kind: 'store-unavailable', reason: 'row-unparseable' };
				return availableStoreValue(undefined);
			} catch (error) {
				return storeFailure(error);
			}
		},
	};
}
