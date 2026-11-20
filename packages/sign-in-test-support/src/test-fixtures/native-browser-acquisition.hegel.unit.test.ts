import * as hegel from '@hegeldev/hegel';
import * as generators from '@hegeldev/hegel/generators';
import { expect, it } from 'vitest';

import {
	transitionNativeBrowserAcquisition,
	type NativeBrowserAcquisitionEvent,
	type NativeBrowserAcquisitionState,
} from './native-browser-acquisition';
import type { OwnedGroupCleanup } from './owned-process-group';

const result: OwnedGroupCleanup = {
	kind: 'natural',
	group: 121,
	reads: [[]],
	termination: { kind: 'not-requested' },
	remaining: [],
};
const completion = Promise.resolve(result);
const closed: NativeBrowserAcquisitionState = { kind: 'closed', promise: completion, result };

const wrongTransition = (
	state: NativeBrowserAcquisitionState,
	event: NativeBrowserAcquisitionEvent,
): NativeBrowserAcquisitionState =>
	state.kind === 'closed' && event.kind === 'request'
		? { kind: 'retained' }
		: transitionNativeBrowserAcquisition(state, event);

it('Hegel: terminal close ownership cannot reopen; a wrong reopen transition shrinks to one late close', (): void => {
	const settings = {
		testCases: 2_000,
		seed: 20261120,
		derandomize: true,
		database: hegel.Database.disabled,
		reportMultipleFailures: false,
	};
	hegel.test((testCase): void => {
		const actions = testCase.draw(
			generators.arrays(generators.sampledFrom(['close', 'cancel'] as const), {
				minSize: 1,
				maxSize: 18,
			}),
		);
		let state: NativeBrowserAcquisitionState = closed;
		for (const action of actions) {
			state = transitionNativeBrowserAcquisition(state, {
				kind: 'request',
				action,
				promise: Promise.resolve(result),
			});
			expect(state).toBe(closed);
		}
	}, settings);
	expect(() =>
		hegel.test((testCase): void => {
			const action = testCase.draw(generators.sampledFrom(['close', 'cancel'] as const));
			const state = wrongTransition(closed, { kind: 'request', action, promise: completion });
			if (state.kind !== 'closed')
				throw new Error(`reopened-acquisition:${JSON.stringify([action])}`);
		}, settings),
	).toThrow('reopened-acquisition:["close"]');
});

const checkWritePublication = (
	actions: readonly ('cancel' | 'finally')[],
	wrong: boolean,
): void => {
	let state = transitionNativeBrowserAcquisition(
		{ kind: 'retained' },
		{ kind: 'request', action: 'close', promise: completion },
	);
	state = transitionNativeBrowserAcquisition(state, {
		kind: 'parent-settled',
		failure: { kind: 'none' },
	});
	state = transitionNativeBrowserAcquisition(state, { kind: 'close-observed', result });
	let signals = 0;
	for (const action of actions) {
		state = transitionNativeBrowserAcquisition(state, {
			kind: 'request',
			action: action === 'cancel' ? 'cancel' : 'close',
			promise: completion,
		});
		if (state.kind === 'closing' && state.termination.kind === 'requested') {
			signals += 1;
			state = transitionNativeBrowserAcquisition(state, {
				kind: 'termination-recorded',
				outcome: { kind: 'sent', signal: 'SIGTERM' },
			});
		}
	}
	// This write was already fulfilled before cancellation; its publication event is delayed.
	state =
		wrong && state.kind === 'closing'
			? { kind: 'closed', promise: state.promise, result }
			: transitionNativeBrowserAcquisition(state, { kind: 'write-settled', written: result });
	if (state.kind === 'closed' && signals > 0 && state.result.kind === 'natural')
		throw new Error(`stale-publication:${JSON.stringify(actions)}`);
	if (!wrong && state.kind === 'closing' && state.observation.kind === 'ready')
		state = transitionNativeBrowserAcquisition(state, {
			kind: 'write-settled',
			written: state.observation.result,
		});
	if (!wrong) {
		expect(state.kind).toBe('closed');
		if (state.kind === 'closed')
			expect(state.result.kind).toBe(signals === 0 ? 'natural' : 'intervened');
		expect(signals).toBeLessThanOrEqual(1);
	}
};

it('Hegel: stale write completion cannot publish natural after a recorded cancellation', (): void => {
	const settings = {
		testCases: 2_000,
		seed: 20261120,
		derandomize: true,
		database: hegel.Database.disabled,
		reportMultipleFailures: false,
	};
	hegel.test(
		(testCase): void =>
			checkWritePublication(
				testCase.draw(
					generators.arrays(generators.sampledFrom(['cancel', 'finally'] as const), {
						minSize: 1,
						maxSize: 18,
					}),
				),
				false,
			),
		settings,
	);
	expect(() =>
		hegel.test(
			(testCase): void =>
				checkWritePublication(
					testCase.draw(
						generators.arrays(generators.sampledFrom(['cancel', 'finally'] as const), {
							minSize: 1,
							maxSize: 18,
						}),
					),
					true,
				),
			settings,
		),
	).toThrow('stale-publication:["cancel"]');
});
