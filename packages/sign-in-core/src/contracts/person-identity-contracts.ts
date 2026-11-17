import { personTokenClaimsSchema } from '@agent-collaboration/tool-access/contracts';
import { z } from 'zod';

import { epochMillisecondsSchema, uuid7Schema } from '#sign-in-core/contracts/sign-in-platform';
import { fleetPermissionSchema } from '#sign-in-core/organizations/fleet-permission';
import { secondFactorMethodSchema } from '#sign-in-core/second-factors/second-factor-step-up';
import { organizationIdSchema, personIdSchema } from '#sign-in-core/storage/models/sign-in-store';

const unixSecondsSchema = z
	.number()
	.int()
	.nonnegative()
	.brand<'UnixSeconds'>()
	.describe('Seconds since the Unix epoch');
const personSessionIdSchema = uuid7Schema.brand<'PersonSessionId'>();

/** K6 carries the issuer's current session organization and the session's own
 * recorded second-factor confirmation. Relying services check its live status. */
const commonPersonTokenClaimsSchema = personTokenClaimsSchema.extend({
	iss: z.url(),
	sub: personIdSchema,
	aud: z.url().describe('Exactly one relying-service audience; arrays are refused'),
	iat: unixSecondsSchema,
	exp: unixSecondsSchema,
	sid: personSessionIdSchema,
	organization_id: organizationIdSchema,
	// K6 otherwise preserves registered extra claims. Explicitly forbid this
	// superseded claim so its JSON Schema and Zod parser reject the same tokens.
	amr: z.never().optional(),
});
const absentFactorClaimsSchema = z.strictObject({
	second_factor_at: z.never().optional(),
	second_factor_method: z.never().optional(),
});
const confirmedFactorClaimsSchema = z.strictObject({
	second_factor_at: unixSecondsSchema,
	second_factor_method: secondFactorMethodSchema,
});
export const personTokenSecondFactorClaimsSchema = z.union([
	absentFactorClaimsSchema,
	confirmedFactorClaimsSchema,
]);
export const organizationPersonTokenClaimsSchema = z.union([
	commonPersonTokenClaimsSchema.extend(absentFactorClaimsSchema.shape),
	commonPersonTokenClaimsSchema.extend(confirmedFactorClaimsSchema.shape),
]);
export type OrganizationPersonTokenClaims = z.infer<typeof organizationPersonTokenClaimsSchema>;

const activePersonSessionConfirmationSchema = z.looseObject({
	active: z.literal(true),
	sub: commonPersonTokenClaimsSchema.shape.sub,
	sid: commonPersonTokenClaimsSchema.shape.sid,
	aud: commonPersonTokenClaimsSchema.shape.aud,
	exp: commonPersonTokenClaimsSchema.shape.exp,
	organization_id: commonPersonTokenClaimsSchema.shape.organization_id,
	permission: fleetPermissionSchema.describe('The permission checked live for this request'),
	checkedAt: epochMillisecondsSchema.describe(
		'Milliseconds since the Unix epoch at the first session read',
	),
});

/** K5 binds a live session confirmation to its checked route permission. Inactive answers reveal only active:false. */
export const personSessionConfirmationSchema = z.discriminatedUnion('active', [
	z.strictObject({ active: z.literal(false) }),
	activePersonSessionConfirmationSchema,
]);
export type PersonSessionConfirmation = z.infer<typeof personSessionConfirmationSchema>;
