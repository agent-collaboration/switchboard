import { and, eq, exists, gt, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';

import { uuid7Schema, type SignInPlatform } from '#sign-in-core/contracts/sign-in-platform';
import {
	storedPasskeyCredentialSchema,
	type PasskeyCredentialRecords,
} from '#sign-in-core/second-factors/passkey-credential-records';
import type { SignInDatabaseFactory } from '#sign-in-core/storage/models/sign-in-database';
import { passkey, session, user } from '#sign-in-core/storage/sign-in-schema';
import {
	availableStoreValue,
	readStoreValue,
	storeFailure,
} from '#sign-in-core/storage/store-query-results';

const credentialProjection = {
	id: passkey.id,
	personId: passkey.userId,
	credentialId: passkey.credentialID,
	publicKey: passkey.publicKey,
	counter: passkey.counter,
};
const confirmationRowsSchema = z.tuple([
	z.array(z.object({ id: uuid7Schema })),
	z.array(z.object({ id: uuid7Schema })),
	z.array(z.object({ id: uuid7Schema })),
]);

/** A verified assertion updates its credential counter and the same live session
 * as one native atomic unit. A removed key cannot leave a new confirmation. */
export function createPasskeyCredentialStore(props: {
	readonly openDatabase: SignInDatabaseFactory;
	readonly platform: Pick<SignInPlatform, 'clock' | 'runAtomically'>;
}): PasskeyCredentialRecords {
	const database = props.openDatabase;
	return {
		listForPerson: (personId) =>
			readStoreValue(
				async () =>
					database().select(credentialProjection).from(passkey).where(eq(passkey.userId, personId)),
				z.array(storedPasskeyCredentialSchema),
			),
		readForPerson: (personId, credentialId) =>
			readStoreValue(
				async () =>
					(
						await database()
							.select(credentialProjection)
							.from(passkey)
							.where(and(eq(passkey.userId, personId), eq(passkey.credentialID, credentialId)))
							.limit(1)
					)[0] ?? null,
				storedPasskeyCredentialSchema.nullable(),
			),
		async confirmSession(request) {
			try {
				if (!z.number().int().nonnegative().safeParse(request.verifiedCounter).success)
					return { kind: 'store-unavailable', reason: 'row-unparseable' };
				const at = props.platform.clock.now();
				const liveSession = and(
					eq(session.id, request.sessionId),
					eq(session.userId, request.personId),
					gt(session.expiresAt, new Date(at)),
					exists(
						database()
							.select({ id: user.id })
							.from(user)
							.where(and(eq(user.id, request.personId), eq(user.emailVerified, true))),
					),
				);
				const credential = and(
					eq(passkey.id, request.passkeyId),
					eq(passkey.userId, request.personId),
				);
				const result = await props.platform.runAtomically([
					database()
						.update(passkey)
						.set({ counter: sql`max(${passkey.counter},${request.verifiedCounter})` })
						.where(
							and(
								credential,
								exists(database().select({ id: session.id }).from(session).where(liveSession)),
							),
						)
						.returning({ id: passkey.id }),
					database()
						.update(session)
						.set({ secondFactorAt: at, secondFactorMethod: 'passkey' })
						.where(
							and(
								liveSession,
								exists(database().select({ id: passkey.id }).from(passkey).where(credential)),
							),
						)
						.returning({ id: session.id }),
					database()
						.update(user)
						.set({ secondFactorSetAt: at })
						.where(
							and(
								eq(user.id, request.personId),
								isNull(user.secondFactorSetAt),
								exists(database().select({ id: session.id }).from(session).where(liveSession)),
								exists(database().select({ id: passkey.id }).from(passkey).where(credential)),
							),
						)
						.returning({ id: user.id }),
				]);
				if (result.kind === 'failed') return { kind: 'store-unavailable', reason: result.reason };
				const rows = confirmationRowsSchema.safeParse(result.rows);
				if (!rows.success) return { kind: 'store-unavailable', reason: 'row-unparseable' };
				return availableStoreValue(
					rows.data[0].length === 1 && rows.data[1].length === 1
						? { kind: 'confirmed', at }
						: { kind: 'credential-or-session-not-live' },
				);
			} catch (error) {
				return storeFailure(error);
			}
		},
	};
}
