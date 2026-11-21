import { z } from 'zod';

import {
	organizationMembershipSchema,
	organizationPeopleMemberSchema,
	organizationPeopleListReplySchema,
	PEOPLE_PAGE_SIZE,
	personMembershipAnswerSchema,
} from '#sign-in-core/contracts/organization-membership';
import { type EpochMilliseconds } from '#sign-in-core/contracts/sign-in-platform';
import {
	invitationRowSchema,
	transitionInvitationView,
	type InvitationRow,
} from '#sign-in-core/organizations/invitation-view';

export const personMembershipFactsSchema = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('member'), role: organizationMembershipSchema.shape.role }),
	z.strictObject({ kind: z.literal('invitations'), rows: z.array(invitationRowSchema).readonly() }),
]);
export type PersonMembershipFacts = z.infer<typeof personMembershipFactsSchema>;
export const organizationPeoplePageSchema = z.strictObject({
	members: z.array(organizationPeopleMemberSchema).max(PEOPLE_PAGE_SIZE).readonly(),
	memberTotal: z.number().int().nonnegative(),
	offset: z.number().int().nonnegative().multipleOf(PEOPLE_PAGE_SIZE),
	invitations: z
		.array(
			invitationRowSchema.extend({
				email: z.email(),
				role: organizationMembershipSchema.shape.role,
			}),
		)
		.readonly(),
});
export type OrganizationPeoplePage = z.infer<typeof organizationPeoplePageSchema>;
const readKindSchema = z.enum(['lookup', 'list']);
const listResultSchema = organizationPeopleListReplySchema.options[0];
export const checkedReadStateSchema = z.union([
	z.strictObject({ state: z.literal('start'), kind: readKindSchema }),
	z.strictObject({ state: z.literal('checked'), kind: readKindSchema }),
	z.strictObject({
		state: z.literal('candidate'),
		kind: z.literal('lookup'),
		result: personMembershipAnswerSchema,
	}),
	z.strictObject({
		state: z.literal('candidate'),
		kind: z.literal('list'),
		result: listResultSchema,
	}),
	z.strictObject({
		state: z.literal('answered'),
		kind: z.literal('lookup'),
		result: personMembershipAnswerSchema,
	}),
	z.strictObject({
		state: z.literal('answered'),
		kind: z.literal('list'),
		result: listResultSchema,
	}),
	z.strictObject({ state: z.literal('refused') }),
	z.strictObject({ state: z.literal('unavailable') }),
]);
export type CheckedReadState = z.infer<typeof checkedReadStateSchema>;
export const checkedReadEventSchema = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('first-check-passed') }),
	z.strictObject({
		kind: z.literal('facts-read'),
		facts: z.discriminatedUnion('kind', [
			z.strictObject({ kind: z.literal('lookup'), value: personMembershipFactsSchema }),
			z.strictObject({ kind: z.literal('list'), value: organizationPeoplePageSchema }),
		]),
	}),
	z.strictObject({ kind: z.literal('second-check-passed') }),
	z.strictObject({ kind: z.literal('check-failed') }),
	z.strictObject({ kind: z.literal('store-failed') }),
]);
export type CheckedReadEvent = z.infer<typeof checkedReadEventSchema>;
function invitationIsPending(row: InvitationRow, now: EpochMilliseconds): boolean {
	return (
		transitionInvitationView({ kind: 'accepted' }, { kind: 'row-read', row }, { now }).state
			.kind === 'pending'
	);
}
export function transitionCheckedRead(
	state: CheckedReadState,
	event: CheckedReadEvent,
	context: { readonly now: EpochMilliseconds },
):
	| { kind: 'next'; state: CheckedReadState }
	| { kind: 'refused'; reason: 'wrong-kind' | 'unexpected-event' } {
	switch (state.state) {
		case 'answered':
		case 'refused':
		case 'unavailable':
			return { kind: 'refused', reason: 'unexpected-event' };
		case 'start':
		case 'checked':
		case 'candidate':
			break;
		default:
			state satisfies never;
			throw new Error('Unknown checked read state');
	}
	switch (event.kind) {
		case 'first-check-passed':
			if (state.state === 'start')
				return { kind: 'next', state: { state: 'checked', kind: state.kind } };
			break;
		case 'facts-read':
			if (state.state !== 'checked') break;
			if (state.kind !== event.facts.kind) return { kind: 'refused', reason: 'wrong-kind' };
			switch (event.facts.kind) {
				case 'lookup': {
					const facts = event.facts.value;
					const result =
						facts.kind === 'member'
							? { kind: 'member' as const, role: facts.role }
							: facts.rows.some((row) => invitationIsPending(row, context.now))
								? { kind: 'invited' as const }
								: { kind: 'not-member' as const };
					return { kind: 'next', state: { state: 'candidate', kind: 'lookup', result } };
				}
				case 'list': {
					const page = event.facts.value;
					return {
						kind: 'next',
						state: {
							state: 'candidate',
							kind: 'list',
							result: {
								kind: 'available',
								members: page.members,
								memberTotal: page.memberTotal,
								nextOffset:
									page.offset + PEOPLE_PAGE_SIZE < page.memberTotal
										? page.offset + PEOPLE_PAGE_SIZE
										: null,
								invitations: page.invitations
									.filter((row) => invitationIsPending(row, context.now))
									.map(({ email, role }) => ({ email, role })),
							},
						},
					};
				}
				default:
					event.facts satisfies never;
					throw new Error('Unknown facts kind');
			}
		case 'second-check-passed':
			if (state.state === 'candidate')
				return { kind: 'next', state: { ...state, state: 'answered' } };
			break;
		case 'check-failed':
			return { kind: 'next', state: { state: 'refused' } };
		case 'store-failed':
			return { kind: 'next', state: { state: 'unavailable' } };
		default:
			event satisfies never;
			throw new Error('Unknown checked read event');
	}
	return { kind: 'refused', reason: 'unexpected-event' };
}
