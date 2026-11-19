import * as hegel from '@hegeldev/hegel';
import * as generators from '@hegeldev/hegel/generators';
import { expect, it } from 'vitest';

import {
	turnstileQueueTransition,
	type QueueState,
	type QueueEvent,
	type QueueEffect,
} from '#sign-in-core/pages/islands/passkey-sign-in-turnstile-queue';

const eventKinds = [
	'scriptReady',
	'scriptFailed',
	'tokenRequested',
	'widgetToken',
	'widgetFailed',
] as const;
const coverage = new Set<string>();

/** The specification's independent FIFO model, with no production helper calls. */
function modelStep(
	model: { script: QueueState['script']; executing: number | null; waiting: number[] },
	event: QueueEvent,
): QueueEffect[] {
	const effects: QueueEffect[] = [];
	const startNext = (): void => {
		model.executing = model.waiting.shift() ?? null;
		if (model.executing !== null)
			effects.push({ kind: 'ensureWidget' }, { kind: 'resetAndExecute' });
	};
	switch (event.kind) {
		case 'scriptReady':
			coverage.add(
				model.script === 'loading'
					? `ready:${model.waiting.length > 0 ? 'waiting' : 'empty'}`
					: 'noop:ready',
			);
			if (model.script === 'loading') {
				model.script = 'ready';
				startNext();
			}
			break;
		case 'scriptFailed':
			coverage.add(
				`failed:${model.script === 'failed' ? 'noop' : model.script === 'loading' ? 'loading' : model.executing === null ? 'idle' : model.waiting.length > 0 ? 'busy-waiting' : 'busy'}`,
			);
			if (model.script !== 'failed') {
				const pending =
					model.executing === null ? [...model.waiting] : [model.executing, ...model.waiting];
				effects.push(
					...pending.map((id): QueueEffect => ({
						kind: 'reject',
						id,
						reason: 'verification-unavailable',
					})),
				);
				model.script = 'failed';
				model.executing = null;
				model.waiting = [];
			}
			break;
		case 'tokenRequested':
			coverage.add(
				`request:${model.script === 'ready' ? (model.executing === null ? 'idle' : 'busy') : model.script}`,
			);
			if (model.script === 'failed')
				effects.push({ kind: 'reject', id: event.id, reason: 'verification-unavailable' });
			else {
				model.waiting.push(event.id);
				if (model.script === 'ready' && model.executing === null) startNext();
			}
			break;
		case 'widgetToken':
		case 'widgetFailed':
			coverage.add(
				`${event.kind}:${model.executing === null ? 'noop' : model.waiting.length > 0 ? 'waiting' : 'empty'}`,
			);
			if (model.executing !== null) {
				effects.push(
					event.kind === 'widgetToken'
						? { kind: 'resolve', id: model.executing, token: event.token }
						: { kind: 'reject', id: model.executing, reason: 'verification-unavailable' },
				);
				startNext();
			}
			break;
		default:
			event satisfies never;
	}
	return effects;
}

it.each(['tokens', 'failure'] as const)(
	'Hegel: FIFO token queue matches its model and drains through %s',
	(drain) => {
		hegel.test(
			(testCase) => {
				const kinds = testCase.draw(
					generators.arrays(generators.sampledFrom(eventKinds), { minSize: 0, maxSize: 40 }),
				);
				let nextId = 0,
					nextToken = 0;
				let state: QueueState = { script: 'loading', executing: null, waiting: [] };
				const model: { script: QueueState['script']; executing: number | null; waiting: number[] } =
					{ script: 'loading', executing: null, waiting: [] };
				const requested: number[] = [],
					settled: number[] = [];
				const tokens = new Set<string>();
				let liveExecution = false;
				const trace: QueueEvent[] = [];
				function step(event: QueueEvent): void {
					trace.push(event);
					if (event.kind === 'tokenRequested') requested.push(event.id);
					const expected = modelStep(model, event);
					const actual = turnstileQueueTransition(state, event);
					const context = JSON.stringify(trace);
					expect(actual.effects, context).toEqual(expected);
					expect(actual.state, context).toEqual(model);
					for (const effect of actual.effects) {
						switch (effect.kind) {
							case 'ensureWidget':
								break;
							case 'resetAndExecute':
								expect(liveExecution, context).toBe(false);
								expect(actual.state.script, context).toBe('ready');
								liveExecution = true;
								break;
							case 'resolve':
								expect(tokens.has(effect.token), context).toBe(false);
								tokens.add(effect.token);
								settled.push(effect.id);
								liveExecution = false;
								break;
							case 'reject':
								settled.push(effect.id);
								liveExecution = false;
								break;
							default:
								effect satisfies never;
						}
					}
					expect(new Set(settled).size, context).toBe(settled.length);
					expect(settled, context).toEqual(requested.slice(0, settled.length));
					expect(new Set(actual.state.waiting).size, context).toBe(actual.state.waiting.length);
					expect(actual.state.waiting.includes(actual.state.executing ?? -1), context).toBe(false);
					state = actual.state;
				}
				for (const kind of kinds) {
					switch (kind) {
						case 'scriptReady':
							step({ kind });
							break;
						case 'scriptFailed':
							step({ kind });
							break;
						case 'tokenRequested':
							step({ kind, id: ++nextId });
							break;
						case 'widgetToken':
							step({ kind, token: `token-${++nextToken}` });
							break;
						case 'widgetFailed':
							step({
								kind,
								cause: testCase.draw(
									generators.sampledFrom(['error', 'expired', 'timeout'] as const),
								),
							});
							break;
						default:
							kind satisfies never;
					}
				}
				if (drain === 'failure') step({ kind: 'scriptFailed' });
				else {
					if (state.script === 'loading') step({ kind: 'scriptReady' });
					while (state.executing !== null)
						step({ kind: 'widgetToken', token: `token-${++nextToken}` });
				}
				expect(settled).toEqual(requested);
				expect(state.waiting).toEqual([]);
				expect(state.executing).toBeNull();
			},
			{ testCases: 2_000, derandomize: true, database: hegel.Database.disabled },
		);
		for (const branch of [
			'request:loading',
			'ready:waiting',
			'ready:empty',
			'request:idle',
			'request:busy',
			'widgetToken:waiting',
			'widgetToken:empty',
			'widgetFailed:waiting',
			'widgetFailed:empty',
			'failed:loading',
			'failed:idle',
			'failed:busy-waiting',
			'request:failed',
			'noop:ready',
			'failed:noop',
			'widgetToken:noop',
			'widgetFailed:noop',
		])
			expect(coverage.has(branch), branch).toBe(true);
	},
);
