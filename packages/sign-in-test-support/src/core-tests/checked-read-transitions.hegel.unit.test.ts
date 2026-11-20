import * as hegel from '@hegeldev/hegel';
import * as generators from '@hegeldev/hegel/generators';
import { expect, it } from 'vitest';

import {
	epochMillisecondsSchema,
	uuid7Schema,
} from '../../../sign-in-core/src/contracts/sign-in-platform';
import {
	transitionCheckedRead,
	type CheckedReadEvent,
	type CheckedReadState,
} from '../../../sign-in-core/src/organizations/checked-read-transitions';

const expiry = epochMillisecondsSchema.parse(1_800_000_000_000);
const id = uuid7Schema.parse('019a3dce-2000-7000-8000-0000000000a1');
const cancelled = Object.freeze({ id, status: 'canceled' as const, expiresAt: expiry });
const pending = Object.freeze({ id, status: 'pending' as const, expiresAt: expiry });
const events: readonly CheckedReadEvent[] = [
	{ kind: 'first-check-passed' },
	{ kind: 'second-check-passed' },
	{ kind: 'check-failed' },
	{ kind: 'store-failed' },
	{ kind: 'facts-read', facts: { kind: 'lookup', value: { kind: 'member', role: 'owner' } } },
	{
		kind: 'facts-read',
		facts: { kind: 'lookup', value: { kind: 'invitations', rows: [cancelled, pending] } },
	},
	{
		kind: 'facts-read',
		facts: {
			kind: 'list',
			value: {
				members: [],
				memberTotal: 50,
				offset: 0,
				invitations: [{ ...pending, email: 'a@example.com', role: 'member' }],
			},
		},
	},
	{
		kind: 'facts-read',
		facts: { kind: 'list', value: { members: [], memberTotal: 51, offset: 0, invitations: [] } },
	},
];
type Result = ReturnType<typeof transitionCheckedRead>;
function reference(state: CheckedReadState, event: CheckedReadEvent, now: number): Result {
	if (state.state === 'answered' || state.state === 'refused' || state.state === 'unavailable')
		return { kind: 'refused', reason: 'unexpected-event' };
	if (event.kind === 'check-failed') return { kind: 'next', state: { state: 'refused' } };
	if (event.kind === 'store-failed') return { kind: 'next', state: { state: 'unavailable' } };
	if (event.kind === 'first-check-passed' && state.state === 'start')
		return { kind: 'next', state: { state: 'checked', kind: state.kind } };
	if (event.kind === 'second-check-passed' && state.state === 'candidate')
		return { kind: 'next', state: { ...state, state: 'answered' } };
	if (event.kind !== 'facts-read' || state.state !== 'checked')
		return { kind: 'refused', reason: 'unexpected-event' };
	if (event.facts.kind !== state.kind) return { kind: 'refused', reason: 'wrong-kind' };
	if (event.facts.kind === 'lookup') {
		const facts = event.facts.value;
		const result =
			facts.kind === 'member'
				? { kind: 'member' as const, role: facts.role }
				: facts.rows.some((row) => row.status === 'pending' && row.expiresAt > now)
					? { kind: 'invited' as const }
					: { kind: 'not-member' as const };
		return { kind: 'next', state: { state: 'candidate', kind: 'lookup', result } };
	}
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
				nextOffset: page.offset + 50 < page.memberTotal ? page.offset + 50 : null,
				invitations: page.invitations
					.filter((row) => row.status === 'pending' && row.expiresAt > now)
					.map((row) => ({ email: row.email, role: row.role })),
			},
		},
	};
}
function freeze(value: object): void {
	Object.freeze(value);
	for (const child of Object.values(value))
		if (child !== null && typeof child === 'object' && !Object.isFrozen(child)) freeze(child);
}
function step(state: CheckedReadState, event: CheckedReadEvent, now: number): CheckedReadState {
	freeze(state);
	freeze(event);
	const expected = reference(state, event, now);
	const result = transitionCheckedRead(state, event, { now: epochMillisecondsSchema.parse(now) });
	expect(result).toEqual(expected);
	if (result.kind === 'next') {
		if (state.state === 'start' || state.state === 'checked' || state.state === 'candidate') {
			if (
				result.state.state === 'start' ||
				result.state.state === 'checked' ||
				result.state.state === 'candidate' ||
				result.state.state === 'answered'
			)
				expect(result.state.kind).toBe(state.kind);
		}
		return result.state;
	}
	return state;
}
it('matches the independent checked-read table after every generated prefix', () => {
	hegel.test(
		(testCase) => {
			let state: CheckedReadState = {
				state: 'start',
				kind:
					testCase.draw(generators.integers({ minValue: 0, maxValue: 1 })) === 0
						? 'lookup'
						: 'list',
			};
			const count = testCase.draw(generators.integers({ minValue: 0, maxValue: 40 }));
			for (let index = 0; index < count; index++) {
				const event =
					events[testCase.draw(generators.integers({ minValue: 0, maxValue: events.length - 1 }))];
				const offset = [-500, -1, 0, 1, 500][
					testCase.draw(generators.integers({ minValue: 0, maxValue: 4 }))
				];
				if (event === undefined || offset === undefined) throw new Error('Invalid event index');
				state = step(state, event, expiry + offset);
			}
		},
		{ testCases: 1000, derandomize: true, database: hegel.Database.disabled },
	);
});
it('covers every state and event kind for both read kinds', () => {
	const states: CheckedReadState[] = [
		{ state: 'start', kind: 'lookup' },
		{ state: 'start', kind: 'list' },
		{ state: 'checked', kind: 'lookup' },
		{ state: 'checked', kind: 'list' },
		{ state: 'candidate', kind: 'lookup', result: { kind: 'member', role: 'owner' } },
		{
			state: 'candidate',
			kind: 'list',
			result: { kind: 'available', members: [], memberTotal: 0, nextOffset: null, invitations: [] },
		},
		{ state: 'answered', kind: 'lookup', result: { kind: 'invited' } },
		{
			state: 'answered',
			kind: 'list',
			result: { kind: 'available', members: [], memberTotal: 0, nextOffset: null, invitations: [] },
		},
		{ state: 'refused' },
		{ state: 'unavailable' },
	];
	for (const state of states)
		for (const event of events)
			for (const offset of [-1, 0, 1]) step(state, event, expiry + offset);
});

it('keeps the first candidate private and discards it when the second check fails', () => {
	let state: CheckedReadState = { state: 'start', kind: 'lookup' };
	for (const event of [events[0], events[4], events[2]]) {
		if (event === undefined) throw new Error('Missing event');
		state = step(state, event, expiry - 1);
		if (event.kind === 'facts-read') expect(state.state).toBe('candidate');
	}
	expect(state).toEqual({ state: 'refused' });
});
