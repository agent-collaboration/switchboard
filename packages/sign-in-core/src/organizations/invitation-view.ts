import { z } from 'zod';

import {
	epochMillisecondsSchema,
	uuid7Schema,
	type EpochMilliseconds,
} from '#sign-in-core/contracts/sign-in-platform';

export const invitationRowSchema = z.strictObject({
	id: uuid7Schema,
	status: z.enum(['pending', 'accepted', 'canceled', 'rejected']),
	expiresAt: epochMillisecondsSchema,
});
export type InvitationRow = z.infer<typeof invitationRowSchema>;
export const invitationViewStateSchema = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('pending'), expiresAt: epochMillisecondsSchema }),
	z.strictObject({ kind: z.literal('expired'), expiresAt: epochMillisecondsSchema }),
	z.strictObject({ kind: z.literal('accepted') }),
	z.strictObject({ kind: z.literal('cancelled') }),
	z.strictObject({ kind: z.literal('rejected') }),
]);
export type InvitationViewState = z.infer<typeof invitationViewStateSchema>;
export const invitationViewEventSchema = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('row-read'), row: invitationRowSchema }),
	z.strictObject({ kind: z.literal('clock-moved') }),
]);
export type InvitationViewEvent = z.infer<typeof invitationViewEventSchema>;
export function transitionInvitationView(
	state: InvitationViewState,
	event: InvitationViewEvent,
	context: { readonly now: EpochMilliseconds },
): { kind: 'next'; state: InvitationViewState } {
	switch (event.kind) {
		case 'row-read':
			switch (event.row.status) {
				case 'pending':
					return {
						kind: 'next',
						state: {
							kind: event.row.expiresAt > context.now ? 'pending' : 'expired',
							expiresAt: event.row.expiresAt,
						},
					};
				case 'accepted':
					return { kind: 'next', state: { kind: 'accepted' } };
				case 'canceled':
					return { kind: 'next', state: { kind: 'cancelled' } };
				case 'rejected':
					return { kind: 'next', state: { kind: 'rejected' } };
				default:
					event.row.status satisfies never;
					throw new Error('Unknown invitation status');
			}
		case 'clock-moved':
			switch (state.kind) {
				case 'pending':
				case 'expired':
					return {
						kind: 'next',
						state: {
							kind: state.expiresAt > context.now ? 'pending' : 'expired',
							expiresAt: state.expiresAt,
						},
					};
				case 'accepted':
				case 'cancelled':
				case 'rejected':
					return { kind: 'next', state };
				default:
					state satisfies never;
					throw new Error('Unknown invitation view state');
			}
		default:
			event satisfies never;
			throw new Error('Unknown invitation view event');
	}
}
