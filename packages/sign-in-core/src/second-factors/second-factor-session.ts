import { z } from 'zod';

import {
	epochMillisecondsSchema,
	type EpochMilliseconds,
	type Uuid7,
} from '#sign-in-core/contracts/sign-in-platform';
import {
	secondFactorConfirmationSchema,
	secondFactorMethodSchema,
	type SecondFactorConfirmation,
	type SecondFactorEnrollment,
	type SecondFactorMethod,
} from '#sign-in-core/second-factors/second-factor-step-up';
import type { SignInStoreResult } from '#sign-in-core/storage/models/sign-in-database';
import type { PersonId } from '#sign-in-core/storage/models/sign-in-store';

export interface FactorSessionState {
	readonly confirmation: SecondFactorConfirmation;
	readonly enrollment: SecondFactorEnrollment;
}
export const storedFactorSessionSchema = z
	.strictObject({
		secondFactorAt: epochMillisecondsSchema.nullable(),
		secondFactorMethod: secondFactorMethodSchema.nullable(),
		secondFactorSetAt: epochMillisecondsSchema.nullable(),
		twoFactorEnabled: z.boolean().nullable(),
		hasVerifiedApp: z.union([z.literal(0), z.literal(1)]).transform((value) => value === 1),
		hasPasskey: z.union([z.literal(0), z.literal(1)]).transform((value) => value === 1),
	})
	.refine((row) => (row.secondFactorAt === null) === (row.secondFactorMethod === null), {
		message: 'Session confirmation requires both method and time',
	});

export function factorSessionState(
	row: z.infer<typeof storedFactorSessionSchema>,
): FactorSessionState {
	const confirmation =
		row.secondFactorAt === null || row.secondFactorMethod === null
			? secondFactorConfirmationSchema.parse({ kind: 'unconfirmed' })
			: secondFactorConfirmationSchema.parse({
					kind: 'confirmed',
					at: row.secondFactorAt,
					method: row.secondFactorMethod,
				});
	return {
		confirmation,
		enrollment:
			row.secondFactorSetAt === null &&
			row.twoFactorEnabled !== true &&
			!row.hasVerifiedApp &&
			!row.hasPasskey
				? { kind: 'never-enrolled' }
				: { kind: 'enrolled', setAt: row.secondFactorSetAt },
	};
}
export type FactorRemoval = { readonly kind: 'removed' } | { readonly kind: 'not-removed' };
export interface SecondFactorRecords {
	readonly readSession: (
		personId: PersonId,
		sessionId: Uuid7,
	) => Promise<SignInStoreResult<FactorSessionState | null>>;
	readonly stampSession: (request: {
		readonly personId: PersonId;
		readonly sessionId: Uuid7;
		readonly method: SecondFactorMethod;
	}) => Promise<
		SignInStoreResult<
			| { readonly kind: 'stamped'; readonly at: EpochMilliseconds }
			| { readonly kind: 'session-not-live' }
		>
	>;
	readonly removePasskey: (request: {
		readonly personId: PersonId;
		readonly passkeyId: Uuid7;
	}) => Promise<SignInStoreResult<FactorRemoval>>;
	readonly removeAuthenticatorApp: (
		personId: PersonId,
	) => Promise<SignInStoreResult<FactorRemoval>>;
}
