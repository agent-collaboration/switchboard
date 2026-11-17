import * as hegel from '@hegeldev/hegel';
import * as generators from '@hegeldev/hegel/generators';
import { expect, it } from 'vitest';

import {
	epochMillisecondsSchema,
	uuid7Schema,
} from '../../../sign-in-core/src/contracts/sign-in-platform';
import {
	transitionInvitationView,
	type InvitationViewEvent,
	type InvitationViewState,
} from '../../../sign-in-core/src/organizations/invitation-view';

const expiry = epochMillisecondsSchema.parse(1_800_000_000_000);
const id = uuid7Schema.parse('019a3dce-2000-7000-8000-0000000000a1');
const rows = (['pending', 'accepted', 'canceled', 'rejected'] as const).map((status) =>
	Object.freeze({ id, status, expiresAt: expiry }),
);
const events: readonly InvitationViewEvent[] = [
	...rows.map((row) => Object.freeze({ kind: 'row-read' as const, row })),
	Object.freeze({ kind: 'clock-moved' as const }),
];
const offsets = [-500, -1, 0, 1, 500] as const;
function reference(
	state: InvitationViewState,
	event: InvitationViewEvent,
	now: number,
): InvitationViewState {
	if (event.kind === 'clock-moved') {
		if (state.kind === 'pending' || state.kind === 'expired')
			return { kind: state.expiresAt > now ? 'pending' : 'expired', expiresAt: state.expiresAt };
		return state;
	}
	if (event.row.status === 'pending')
		return {
			kind: event.row.expiresAt > now ? 'pending' : 'expired',
			expiresAt: event.row.expiresAt,
		};
	if (event.row.status === 'canceled') return { kind: 'cancelled' };
	return { kind: event.row.status };
}
function step(
	state: InvitationViewState,
	event: InvitationViewEvent,
	now: number,
): InvitationViewState {
	Object.freeze(state);
	const expected = reference(state, event, now);
	const result = transitionInvitationView(state, event, {
		now: epochMillisecondsSchema.parse(now),
	});
	expect(result).toEqual({ kind: 'next', state: expected });
	return result.state;
}
it('matches the independent invitation table after every generated prefix', () => {
	hegel.test(
		(testCase) => {
			let state: InvitationViewState = { kind: 'accepted' };
			const count = testCase.draw(generators.integers({ minValue: 0, maxValue: 40 }));
			for (let index = 0; index < count; index++) {
				const event =
					events[testCase.draw(generators.integers({ minValue: 0, maxValue: events.length - 1 }))];
				const offset =
					offsets[
						testCase.draw(generators.integers({ minValue: 0, maxValue: offsets.length - 1 }))
					];
				if (event === undefined || offset === undefined) throw new Error('Invalid event index');
				state = step(state, event, expiry + offset);
			}
		},
		{ testCases: 1000, derandomize: true, database: hegel.Database.disabled },
	);
});
it('covers every invitation state and event kind at the expiry boundary', () => {
	const states: InvitationViewState[] = [
		{ kind: 'pending', expiresAt: expiry },
		{ kind: 'expired', expiresAt: expiry },
		{ kind: 'accepted' },
		{ kind: 'cancelled' },
		{ kind: 'rejected' },
	];
	for (const state of states)
		for (const event of events) for (const offset of offsets) step(state, event, expiry + offset);
});
