import { z } from 'zod';

import { organizationIdSchema, personIdSchema } from '#sign-in-core/storage/models/sign-in-store';

export const organizationMembershipSchema = z.strictObject({
	organizationId: organizationIdSchema,
	organizationName: z.string(),
	personId: personIdSchema,
	role: z.enum(['owner', 'member']),
});
export type OrganizationMembership = z.infer<typeof organizationMembershipSchema>;
export const organizationChoiceSchema = organizationMembershipSchema.pick({
	organizationId: true,
	organizationName: true,
	role: true,
});
export type OrganizationChoice = z.infer<typeof organizationChoiceSchema>;
export const personOrganizationContextSchema = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('signed-out') }),
	z.strictObject({ kind: z.literal('unavailable') }),
	z.strictObject({
		kind: z.literal('available'),
		choices: z.array(organizationChoiceSchema).readonly(),
		activeOrganizationId: organizationIdSchema.nullable(),
	}),
]);
export type PersonOrganizationContext = z.infer<typeof personOrganizationContextSchema>;
export const personMembershipAnswerSchema = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('member'), role: organizationMembershipSchema.shape.role }),
	z.strictObject({ kind: z.literal('invited') }),
	z.strictObject({ kind: z.literal('not-member') }),
]);
export type PersonMembershipAnswer = z.infer<typeof personMembershipAnswerSchema>;
const refusedOrUnavailable = [
	z.strictObject({ kind: z.literal('refused') }),
	z.strictObject({ kind: z.literal('unavailable') }),
] as const;
export const organizationPersonLookupRequestSchema = z.strictObject({
	organizationId: organizationIdSchema,
	email: z.string().trim().toLowerCase().pipe(z.email()),
});
export type OrganizationPersonLookupRequest = z.infer<typeof organizationPersonLookupRequestSchema>;
export const organizationPersonLookupReplySchema = z.discriminatedUnion('kind', [
	...personMembershipAnswerSchema.options,
	...refusedOrUnavailable,
]);
export type OrganizationPersonLookupReply = z.infer<typeof organizationPersonLookupReplySchema>;
export const PEOPLE_PAGE_SIZE = 50;
export const organizationPeopleListRequestSchema = z.strictObject({
	organizationId: organizationIdSchema,
	offset: z.coerce.number().int().nonnegative().multipleOf(PEOPLE_PAGE_SIZE),
});
export type OrganizationPeopleListRequest = z.infer<typeof organizationPeopleListRequestSchema>;
export const organizationPeopleMemberSchema = z.strictObject({
	name: z.string(),
	email: z.email(),
	role: organizationMembershipSchema.shape.role,
});
export const organizationPeopleInvitationSchema = z.strictObject({
	email: z.email(),
	role: organizationMembershipSchema.shape.role,
});
export const organizationPeopleListReplySchema = z.discriminatedUnion('kind', [
	z.strictObject({
		kind: z.literal('available'),
		members: z.array(organizationPeopleMemberSchema).max(PEOPLE_PAGE_SIZE).readonly(),
		memberTotal: z.number().int().nonnegative(),
		nextOffset: z.number().int().nonnegative().nullable(),
		invitations: z.array(organizationPeopleInvitationSchema).readonly(),
	}),
	...refusedOrUnavailable,
]);
export type OrganizationPeopleListReply = z.infer<typeof organizationPeopleListReplySchema>;
