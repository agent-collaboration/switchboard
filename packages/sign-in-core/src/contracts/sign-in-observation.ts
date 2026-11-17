import { z } from 'zod';

import { uuid7Schema } from '#sign-in-core/contracts/sign-in-platform';
import { signInRequestClassSchema } from '#sign-in-core/request-limits/request-limit-policy';

export const turnstileActionSchema = z.enum(['sign_in_social', 'passkey_sign_in']);
export type TurnstileAction = z.infer<typeof turnstileActionSchema>;

export const captchaRefusalReasonSchema = z.enum([
	'missing',
	'rejected',
	'wrong-action',
	'wrong-hostname',
	'duplicate',
	'unavailable',
]);
export type CaptchaRefusalReason = z.infer<typeof captchaRefusalReasonSchema>;

export const requestLimitObservationSchema = z.discriminatedUnion('kind', [
	z.strictObject({
		kind: z.literal('request-limited'),
		requestClass: signInRequestClassSchema,
		layer: z.enum(['outer', 'provider']),
	}),
	z.strictObject({
		kind: z.literal('request-limit-unavailable'),
		requestClass: signInRequestClassSchema,
	}),
]);
export type RequestLimitObservation = z.infer<typeof requestLimitObservationSchema>;

export const signInObservationSchema = z
	.discriminatedUnion('kind', [
		...requestLimitObservationSchema.options,
		z.strictObject({
			kind: z.literal('authorization-drain-summary'),
			acknowledged: z.number().int().nonnegative(),
			deferred: z.number().int().nonnegative(),
			discrepancies: z.number().int().nonnegative(),
		}),
		z.strictObject({
			kind: z.literal('authorization-drain-unavailable'),
			reason: z.enum(['database-error', 'migration-incomplete', 'row-unparseable', 'job-error']),
		}),
		z.strictObject({
			kind: z.literal('authorization-backfill-complete'),
			organizationFencesAdded: z.number().int().nonnegative(),
			personPairsAdded: z.number().int().nonnegative(),
		}),
		z.strictObject({
			kind: z.literal('authorization-backfill-unavailable'),
			reason: z.enum(['database-error', 'migration-incomplete', 'row-unparseable']),
		}),
		z.strictObject({
			kind: z.literal('captcha-refused'),
			action: turnstileActionSchema,
			reason: captchaRefusalReasonSchema,
		}),
		z.strictObject({
			kind: z.literal('organization-setup-unconfirmed'),
			organizationId: uuid7Schema,
			reason: z.enum([
				'unavailable',
				'timeout',
				'malformed-reply',
				'database-error',
				'migration-incomplete',
				'row-unparseable',
				'not-found',
				'signing-unavailable',
				'organization-mismatch',
				'invalid-statement',
				'stale',
			]),
		}),
		z.strictObject({
			kind: z.literal('people-change-unconfirmed'),
			organizationId: uuid7Schema,
			requestId: uuid7Schema,
			reason: z.enum(['database-error', 'migration-incomplete', 'row-unparseable']),
		}),
	])
	.readonly();
export type SignInObservation = z.infer<typeof signInObservationSchema>;
