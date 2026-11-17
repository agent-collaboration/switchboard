import { z } from 'zod';

import { uuid7Schema } from '#sign-in-core/contracts/sign-in-platform';
import type { SignInStoreResult } from '#sign-in-core/storage/models/sign-in-database';
import { organizationIdSchema, personIdSchema } from '#sign-in-core/storage/models/sign-in-store';

const changeIdentitySchema = z.strictObject({
	requestId: uuid7Schema,
	actorUserId: personIdSchema,
	organizationId: organizationIdSchema,
});
export const organizationPeopleChangeSchema = z.discriminatedUnion('change', [
	changeIdentitySchema.extend({ change: z.literal('invited'), targetId: z.email() }),
	changeIdentitySchema.extend({ change: z.literal('invitation-cancelled'), targetId: uuid7Schema }),
	changeIdentitySchema.extend({ change: z.literal('invitation-accepted'), targetId: uuid7Schema }),
	changeIdentitySchema.extend({ change: z.literal('member-removed'), targetId: personIdSchema }),
]);
export type OrganizationPeopleChange = z.infer<typeof organizationPeopleChangeSchema>;
export const organizationChangePhaseSchema = z.enum(['intent', 'outcome']);
export type OrganizationChangePhase = z.infer<typeof organizationChangePhaseSchema>;

export interface OrganizationChangeRecords {
	readonly record: (
		change: OrganizationPeopleChange,
		phase: OrganizationChangePhase,
	) => Promise<SignInStoreResult<void>>;
}

/** The request ID identifies one native operation; a lost outcome never changes the intent. */
export function organizationChangeRecordId(
	change: OrganizationPeopleChange,
	phase: OrganizationChangePhase,
): string {
	return `${change.requestId}:${change.change}:${phase}`;
}
