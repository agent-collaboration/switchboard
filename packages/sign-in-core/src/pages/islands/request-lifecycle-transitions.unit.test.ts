import { expect, it } from 'vitest';
import { z } from 'zod';

import { createRequestLifecycle } from '#sign-in-core/pages/islands/request-lifecycle-transitions';

const lifecycle = createRequestLifecycle(
	z.strictObject({ email: z.email() }),
	z.discriminatedUnion('kind', [
		z.strictObject({ kind: z.literal('member') }),
		z.strictObject({ kind: z.literal('refused') }),
		z.strictObject({ kind: z.literal('unavailable') }),
	]),
);
type State = z.infer<typeof lifecycle.stateSchema>;
type Event = z.infer<typeof lifecycle.eventSchema>;
function next(state: State, event: Event): State {
	const result = lifecycle.transition(state, event, {});
	if (result.kind === 'refused') throw new Error(`Unexpected refusal: ${result.reason}`);
	return result.state;
}
const request = { email: 'person@example.invalid' };

it('refuses a duplicate submit and stale replies after an edit and a newer submit', () => {
	const pending = next({ kind: 'idle', generation: 0 }, { kind: 'submit-valid', request });
	expect(lifecycle.transition(pending, { kind: 'submit-valid', request }, {})).toEqual({
		kind: 'refused',
		reason: 'already-pending',
	});
	const edited = next(pending, { kind: 'edited' });
	const newer = next(edited, { kind: 'submit-valid', request });
	expect(
		lifecycle.transition(
			newer,
			{ kind: 'reply', generation: pending.generation, reply: { kind: 'member' } },
			{},
		),
	).toEqual({ kind: 'refused', reason: 'stale' });
	expect(newer).toEqual({ kind: 'pending', generation: 3, request });
});
it('clears the old result on edits, invalid input, new requests, refusal and unavailable replies', () => {
	const answered = { kind: 'answered', generation: 1, reply: { kind: 'member' } } satisfies State;
	for (const event of [
		{ kind: 'edited' },
		{ kind: 'organization-changed' },
		{ kind: 'submit-invalid' },
		{ kind: 'submit-valid', request },
	] satisfies Event[])
		expect(next(answered, event)).not.toHaveProperty('reply');
	for (const reply of [{ kind: 'refused' }, { kind: 'unavailable' }] as const) {
		const pending = next(answered, { kind: 'submit-valid', request });
		expect(next(pending, { kind: 'reply', generation: pending.generation, reply })).toEqual({
			kind: reply.kind,
			generation: 2,
		});
	}
});
it('supersedes a pending list navigation and makes unmount final', () => {
	const first = next({ kind: 'idle', generation: 0 }, { kind: 'navigated', request });
	const second = next(first, { kind: 'navigated', request });
	expect(second.generation).toBe(2);
	expect(
		lifecycle.transition(second, { kind: 'reply', generation: 1, reply: { kind: 'member' } }, {}),
	).toEqual({ kind: 'refused', reason: 'stale' });
	const disposed = next(second, { kind: 'unmounted' });
	expect(lifecycle.transition(disposed, { kind: 'failed', generation: 2 }, {})).toEqual({
		kind: 'refused',
		reason: 'disposed',
	});
});
it('strictly rejects additional state/event keys and invalid generations at the input boundary', () => {
	expect(
		lifecycle.stateSchema.safeParse({ kind: 'idle', generation: 0, reply: { kind: 'member' } })
			.success,
	).toBe(false);
	expect(lifecycle.eventSchema.safeParse({ kind: 'edited', email: request.email }).success).toBe(
		false,
	);
	expect(
		lifecycle.stateSchema.safeParse({ kind: 'pending', generation: -1, request }).success,
	).toBe(false);
});
