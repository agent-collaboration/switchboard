import { z } from 'zod';

/** Closed schemas and a pure transition for one request's lifetime. */
class RequestLifecycle<TRequest, TReply extends { readonly kind: string }> {
	readonly stateSchema;
	readonly eventSchema;
	readonly resultSchema;
	readonly contextSchema;
	constructor(requestSchema: z.ZodType<TRequest>, replySchema: z.ZodType<TReply>) {
		const generationSchema = z.number().int().nonnegative();
		this.stateSchema = z.discriminatedUnion('kind', [
			z.strictObject({ kind: z.literal('idle'), generation: generationSchema }),
			z.strictObject({ kind: z.literal('invalid'), generation: generationSchema }),
			z.strictObject({
				kind: z.literal('pending'),
				generation: generationSchema,
				request: requestSchema,
			}),
			z.strictObject({
				kind: z.literal('answered'),
				generation: generationSchema,
				reply: replySchema,
			}),
			z.strictObject({ kind: z.literal('refused'), generation: generationSchema }),
			z.strictObject({ kind: z.literal('unavailable'), generation: generationSchema }),
			z.strictObject({ kind: z.literal('disposed'), generation: generationSchema }),
		]);
		this.eventSchema = z.discriminatedUnion('kind', [
			z.strictObject({ kind: z.literal('edited') }),
			z.strictObject({ kind: z.literal('organization-changed') }),
			z.strictObject({ kind: z.literal('submit-valid'), request: requestSchema }),
			z.strictObject({ kind: z.literal('submit-invalid') }),
			z.strictObject({
				kind: z.literal('reply'),
				generation: generationSchema,
				reply: replySchema,
			}),
			z.strictObject({ kind: z.literal('failed'), generation: generationSchema }),
			z.strictObject({ kind: z.literal('navigated'), request: requestSchema }),
			z.strictObject({ kind: z.literal('unmounted') }),
		]);
		this.resultSchema = z.discriminatedUnion('kind', [
			z.strictObject({ kind: z.literal('next'), state: this.stateSchema }),
			z.strictObject({
				kind: z.literal('refused'),
				reason: z.enum(['already-pending', 'stale', 'disposed']),
			}),
		]);
		// The context is empty: the lifecycle reads no clock or browser global.
		this.contextSchema = z.strictObject({});
	}
	transition(
		state: z.infer<RequestLifecycle<TRequest, TReply>['stateSchema']>,
		event: z.infer<RequestLifecycle<TRequest, TReply>['eventSchema']>,
		_context: z.infer<RequestLifecycle<TRequest, TReply>['contextSchema']>,
	): z.infer<RequestLifecycle<TRequest, TReply>['resultSchema']> {
		switch (state.kind) {
			case 'disposed':
				return { kind: 'refused', reason: 'disposed' };
			case 'idle':
			case 'invalid':
			case 'pending':
			case 'answered':
			case 'refused':
			case 'unavailable':
				break;
			default:
				return state satisfies never;
		}
		switch (event.kind) {
			case 'edited':
			case 'organization-changed':
				return { kind: 'next', state: { kind: 'idle', generation: state.generation + 1 } };
			case 'submit-invalid':
				return { kind: 'next', state: { kind: 'invalid', generation: state.generation + 1 } };
			case 'submit-valid':
				if (state.kind === 'pending') return { kind: 'refused', reason: 'already-pending' };
				return {
					kind: 'next',
					state: { kind: 'pending', generation: state.generation + 1, request: event.request },
				};
			case 'navigated':
				return {
					kind: 'next',
					state: { kind: 'pending', generation: state.generation + 1, request: event.request },
				};
			case 'reply':
				if (state.kind !== 'pending' || event.generation !== state.generation)
					return { kind: 'refused', reason: 'stale' };
				if (event.reply.kind === 'refused')
					return { kind: 'next', state: { kind: 'refused', generation: state.generation } };
				if (event.reply.kind === 'unavailable')
					return { kind: 'next', state: { kind: 'unavailable', generation: state.generation } };
				return {
					kind: 'next',
					state: { kind: 'answered', generation: state.generation, reply: event.reply },
				};
			case 'failed':
				if (state.kind !== 'pending' || event.generation !== state.generation)
					return { kind: 'refused', reason: 'stale' };
				return { kind: 'next', state: { kind: 'unavailable', generation: state.generation } };
			case 'unmounted':
				return { kind: 'next', state: { kind: 'disposed', generation: state.generation } };
			default:
				return event satisfies never;
		}
	}
}

export function createRequestLifecycle<TRequest, TReply extends { readonly kind: string }>(
	requestSchema: z.ZodType<TRequest>,
	replySchema: z.ZodType<TReply>,
): RequestLifecycle<TRequest, TReply> {
	return new RequestLifecycle(requestSchema, replySchema);
}
