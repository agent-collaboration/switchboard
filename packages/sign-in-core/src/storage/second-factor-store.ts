import { and, count, eq, exists, gt, isNull, notExists, or, sql } from 'drizzle-orm';
import { z } from 'zod';

import { uuid7Schema, type SignInPlatform } from '#sign-in-core/contracts/sign-in-platform';
import {
	factorSessionState,
	storedFactorSessionSchema,
	type SecondFactorRecords,
} from '#sign-in-core/second-factors/second-factor-session';
import type { SignInDatabaseFactory } from '#sign-in-core/storage/models/sign-in-database';
import { passkey, session, twoFactor, user } from '#sign-in-core/storage/sign-in-schema';
import {
	availableStoreValue,
	readStoreValue,
	storeFailure,
} from '#sign-in-core/storage/store-query-results';

const mutationRowsSchema = z.array(z.object({ id: uuid7Schema }));

/** The removal predicates run inside the same native atomic unit as the write.
 * Hooks cannot authorize a deletion using an earlier count of usable factors. */
export function createSecondFactorStore(props: {
	readonly openDatabase: SignInDatabaseFactory;
	readonly platform: Pick<SignInPlatform, 'clock' | 'runAtomically'>;
}): SecondFactorRecords {
	const database = props.openDatabase;
	return {
		async readSession(personId, sessionId) {
			const now = new Date(props.platform.clock.now());
			const result = await readStoreValue(
				async () =>
					(
						await database()
							.select({
								secondFactorAt: session.secondFactorAt,
								secondFactorMethod: session.secondFactorMethod,
								secondFactorSetAt: user.secondFactorSetAt,
								twoFactorEnabled: user.twoFactorEnabled,
								hasVerifiedApp: exists(
									database()
										.select({ id: twoFactor.id })
										.from(twoFactor)
										.where(and(eq(twoFactor.userId, session.userId), eq(twoFactor.verified, true))),
								),
								hasPasskey: exists(
									database()
										.select({ id: passkey.id })
										.from(passkey)
										.where(eq(passkey.userId, session.userId)),
								),
							})
							.from(session)
							.innerJoin(user, eq(user.id, session.userId))
							.where(
								and(
									eq(session.id, sessionId),
									eq(session.userId, personId),
									gt(session.expiresAt, now),
									eq(user.emailVerified, true),
								),
							)
							.limit(1)
					)[0] ?? null,
				storedFactorSessionSchema.nullable(),
			);
			return result.kind === 'available'
				? availableStoreValue(result.value === null ? null : factorSessionState(result.value))
				: result;
		},
		async stampSession(request) {
			try {
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
				const result = await props.platform.runAtomically([
					database()
						.update(session)
						.set({ secondFactorAt: at, secondFactorMethod: request.method })
						.where(liveSession)
						.returning({ id: session.id }),
					database()
						.update(user)
						.set({ secondFactorSetAt: at })
						.where(
							and(
								eq(user.id, request.personId),
								isNull(user.secondFactorSetAt),
								exists(database().select({ id: session.id }).from(session).where(liveSession)),
							),
						)
						.returning({ id: user.id }),
				]);
				if (result.kind === 'failed') return { kind: 'store-unavailable', reason: result.reason };
				const rows = mutationRowsSchema.safeParse(result.rows[0]);
				if (!rows.success) return { kind: 'store-unavailable', reason: 'row-unparseable' };
				return availableStoreValue(
					rows.data.length === 1 ? { kind: 'stamped', at } : { kind: 'session-not-live' },
				);
			} catch (error) {
				return storeFailure(error);
			}
		},
		async removePasskey(request) {
			try {
				const verifiedApp = exists(
					database()
						.select({ id: twoFactor.id })
						.from(twoFactor)
						.where(and(eq(twoFactor.userId, request.personId), eq(twoFactor.verified, true))),
				);
				const passkeyCount = database()
					.select({ total: count() })
					.from(passkey)
					.where(eq(passkey.userId, request.personId));
				const result = await props.platform.runAtomically([
					database()
						.delete(passkey)
						.where(
							and(
								eq(passkey.id, request.passkeyId),
								eq(passkey.userId, request.personId),
								or(verifiedApp, gt(sql<number>`(${passkeyCount})`, 1)),
							),
						)
						.returning({ id: passkey.id }),
				]);
				if (result.kind === 'failed') return { kind: 'store-unavailable', reason: result.reason };
				const rows = mutationRowsSchema.safeParse(result.rows[0]);
				if (!rows.success) return { kind: 'store-unavailable', reason: 'row-unparseable' };
				return availableStoreValue(
					rows.data.length === 1 ? { kind: 'removed' } : { kind: 'not-removed' },
				);
			} catch (error) {
				return storeFailure(error);
			}
		},
		async removeAuthenticatorApp(personId) {
			try {
				const result = await props.platform.runAtomically([
					database()
						.delete(twoFactor)
						.where(
							and(
								eq(twoFactor.userId, personId),
								exists(
									database()
										.select({ id: passkey.id })
										.from(passkey)
										.where(eq(passkey.userId, personId)),
								),
							),
						)
						.returning({ id: twoFactor.id }),
					database()
						.update(user)
						.set({ twoFactorEnabled: false })
						.where(
							and(
								eq(user.id, personId),
								notExists(
									database()
										.select({ id: twoFactor.id })
										.from(twoFactor)
										.where(eq(twoFactor.userId, personId)),
								),
							),
						)
						.returning({ id: user.id }),
				]);
				if (result.kind === 'failed') return { kind: 'store-unavailable', reason: result.reason };
				const rows = mutationRowsSchema.safeParse(result.rows[0]);
				if (!rows.success) return { kind: 'store-unavailable', reason: 'row-unparseable' };
				return availableStoreValue(
					rows.data.length > 0 ? { kind: 'removed' } : { kind: 'not-removed' },
				);
			} catch (error) {
				return storeFailure(error);
			}
		},
	};
}
