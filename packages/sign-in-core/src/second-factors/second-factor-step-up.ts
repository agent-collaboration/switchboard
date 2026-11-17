import { z } from 'zod';

import {
	epochMillisecondsSchema,
	type EpochMilliseconds,
} from '#sign-in-core/contracts/sign-in-platform';

export const secondFactorMethodSchema = z.enum(['app', 'recoveryCode', 'passkey']);
export type SecondFactorMethod = z.infer<typeof secondFactorMethodSchema>;
export const secondFactorConfirmationSchema = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('unconfirmed') }),
	z.strictObject({
		kind: z.literal('confirmed'),
		at: epochMillisecondsSchema,
		method: secondFactorMethodSchema,
	}),
]);
export type SecondFactorConfirmation = z.infer<typeof secondFactorConfirmationSchema>;
export type SecondFactorEnrollment =
	| { readonly kind: 'never-enrolled' }
	| { readonly kind: 'enrolled'; readonly setAt: EpochMilliseconds | null };
export type FactorChange =
	| 'begin-app-enrollment'
	| 'add-passkey'
	| 'rename-passkey'
	| 'remove-passkey'
	| 'remove-app'
	| 'rotate-recovery-codes';
export const secondFactorWindowSeconds = 15 * 60;
export type StepUpRequired = {
	readonly kind: 'second-factor-required';
	readonly withinSeconds: typeof secondFactorWindowSeconds;
};

/** A confirmation belongs to one session. The store supplies that session's
 * actual stamp; first-enrollment time never stands in for a confirmation. */
export function decideRecentSecondFactor(props: {
	readonly now: EpochMilliseconds;
	readonly confirmation: SecondFactorConfirmation;
}): Extract<SecondFactorConfirmation, { kind: 'confirmed' }> | StepUpRequired {
	if (
		props.confirmation.kind === 'confirmed' &&
		props.now - props.confirmation.at <= secondFactorWindowSeconds * 1000
	)
		return props.confirmation;
	return { kind: 'second-factor-required', withinSeconds: secondFactorWindowSeconds };
}
export function decideFactorChange(props: {
	readonly now: EpochMilliseconds;
	readonly enrollment: SecondFactorEnrollment;
	readonly confirmation: SecondFactorConfirmation;
	readonly change: FactorChange;
}): { readonly kind: 'allowed' } | { readonly kind: 'app-required' } | StepUpRequired {
	if (props.enrollment.kind === 'never-enrolled')
		return props.change === 'begin-app-enrollment' ? { kind: 'allowed' } : { kind: 'app-required' };
	const confirmation = decideRecentSecondFactor(props);
	return confirmation.kind === 'confirmed' ? { kind: 'allowed' } : confirmation;
}
