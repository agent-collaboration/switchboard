import * as hegel from '@hegeldev/hegel';
import * as generators from '@hegeldev/hegel/generators';
import { expect, it } from 'vitest';
import type { z } from 'zod';

import {
	organizationPersonLookupRequestSchema,
	organizationPersonLookupReplySchema,
	organizationPeopleListRequestSchema,
	organizationPeopleListReplySchema,
} from '../../../sign-in-core/src/contracts/organization-membership';
import { createRequestLifecycle } from '../../../sign-in-core/src/pages/islands/request-lifecycle-transitions';
import { organizationIdSchema } from '../../../sign-in-core/src/storage/models/sign-in-store';

const organizationId = organizationIdSchema.parse('019a3dce-2000-7000-8000-0000000000a1');
const lookup = createRequestLifecycle(
	organizationPersonLookupRequestSchema,
	organizationPersonLookupReplySchema,
);
const list = createRequestLifecycle(
	organizationPeopleListRequestSchema,
	organizationPeopleListReplySchema,
);

function freeze(value: object): void {
	Object.freeze(value);
	for (const child of Object.values(value))
		if (child !== null && typeof child === 'object' && !Object.isFrozen(child)) freeze(child);
}

function checkFamily<TRequest, TReply extends { readonly kind: string }>(props: {
	readonly machine: ReturnType<typeof createRequestLifecycle<TRequest, TReply>>;
	readonly requests: readonly TRequest[];
	readonly replies: readonly TReply[];
}): void {
	const { machine, requests, replies } = props;
	type State = z.infer<typeof machine.stateSchema>;
	type Event = z.infer<typeof machine.eventSchema>;
	type Result = z.infer<typeof machine.resultSchema>;
	const firstRequest = requests[0];
	const firstReply = replies[0];
	if (firstRequest === undefined || firstReply === undefined)
		throw new Error('Family requires a request and reply');
	// This table is the specification's model, independent of the production transition.
	function reference(state: State, event: Event): Result {
		if (state.kind === 'disposed') return { kind: 'refused', reason: 'disposed' };
		if (event.kind === 'unmounted')
			return { kind: 'next', state: { kind: 'disposed', generation: state.generation } };
		if (
			event.kind === 'edited' ||
			event.kind === 'organization-changed' ||
			event.kind === 'submit-invalid'
		)
			return {
				kind: 'next',
				state: {
					kind: event.kind === 'submit-invalid' ? 'invalid' : 'idle',
					generation: state.generation + 1,
				},
			};
		if (event.kind === 'submit-valid' || event.kind === 'navigated') {
			if (event.kind === 'submit-valid' && state.kind === 'pending')
				return { kind: 'refused', reason: 'already-pending' };
			return {
				kind: 'next',
				state: { kind: 'pending', generation: state.generation + 1, request: event.request },
			};
		}
		if (state.kind !== 'pending' || event.generation !== state.generation)
			return { kind: 'refused', reason: 'stale' };
		if (event.kind === 'failed')
			return { kind: 'next', state: { kind: 'unavailable', generation: state.generation } };
		if (event.reply.kind === 'refused' || event.reply.kind === 'unavailable')
			return { kind: 'next', state: { kind: event.reply.kind, generation: state.generation } };
		return {
			kind: 'next',
			state: { kind: 'answered', generation: state.generation, reply: event.reply },
		};
	}
	function eventsAt(state: State): readonly Event[] {
		return [
			{ kind: 'edited' },
			{ kind: 'organization-changed' },
			{ kind: 'submit-invalid' },
			{ kind: 'unmounted' },
			...requests.flatMap((request): Event[] => [
				{ kind: 'submit-valid', request },
				{ kind: 'navigated', request },
			]),
			...[Math.max(0, state.generation - 1), state.generation, state.generation + 1].flatMap(
				(generation): Event[] => [
					{ kind: 'failed', generation },
					...replies.map((reply): Event => ({ kind: 'reply', generation, reply })),
				],
			),
		];
	}
	function step(state: State, event: Event, prefix: readonly Event[] = []): State {
		freeze(state);
		freeze(event);
		const expected = reference(state, event);
		const result = machine.transition(state, event, {});
		expect(result, JSON.stringify({ prefix, state, event })).toEqual(expected);
		if (result.kind === 'refused') return state;
		expect(result.state.generation).toBeGreaterThanOrEqual(state.generation);
		expect('reply' in result.state).toBe(result.state.kind === 'answered');
		if (event.kind === 'edited' || event.kind === 'organization-changed' || event.kind === 'failed')
			expect(result.state).not.toHaveProperty('reply');
		return result.state;
	}
	hegel.test(
		(testCase): void => {
			let state: State = { kind: 'idle', generation: 0 };
			const prefix: Event[] = [];
			const count = testCase.draw(generators.integers({ minValue: 0, maxValue: 40 }));
			for (let index = 0; index < count; index++) {
				const catalogue = eventsAt(state);
				const event =
					catalogue[
						testCase.draw(generators.integers({ minValue: 0, maxValue: catalogue.length - 1 }))
					];
				if (event === undefined) throw new Error('Invalid event index');
				prefix.push(event);
				state = step(state, event, prefix);
			}
		},
		{ testCases: 1000, derandomize: true, database: hegel.Database.disabled },
	);
	const census: State[] = [
		{ kind: 'idle', generation: 3 },
		{ kind: 'invalid', generation: 3 },
		{ kind: 'pending', generation: 3, request: firstRequest },
		{ kind: 'answered', generation: 3, reply: firstReply },
		{ kind: 'refused', generation: 3 },
		{ kind: 'unavailable', generation: 3 },
		{ kind: 'disposed', generation: 3 },
	];
	for (const state of census) for (const event of eventsAt(state)) step(state, event);
}

it('matches the independent lifecycle table for lookup after every prefix and every state/event pair', () => {
	checkFamily({
		machine: lookup,
		requests: [
			organizationPersonLookupRequestSchema.parse({ organizationId, email: 'a@example.invalid' }),
			organizationPersonLookupRequestSchema.parse({ organizationId, email: 'b@example.invalid' }),
		],
		replies: [
			{ kind: 'member', role: 'owner' },
			{ kind: 'member', role: 'member' },
			{ kind: 'invited' },
			{ kind: 'not-member' },
			{ kind: 'refused' },
			{ kind: 'unavailable' },
		],
	});
});
it('matches the independent lifecycle table for list navigation after every prefix and every state/event pair', () => {
	checkFamily({
		machine: list,
		requests: [0, 50, 100].map((offset) =>
			organizationPeopleListRequestSchema.parse({ organizationId, offset }),
		),
		replies: [
			{ kind: 'available', members: [], memberTotal: 101, nextOffset: 50, invitations: [] },
			{ kind: 'available', members: [], memberTotal: 101, nextOffset: null, invitations: [] },
			{ kind: 'refused' },
			{ kind: 'unavailable' },
		],
	});
});
