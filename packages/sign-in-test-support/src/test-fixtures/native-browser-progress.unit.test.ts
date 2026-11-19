import { expect, it } from 'vitest';

import {
	createNativeBrowserProgress,
	executeNativeAwait,
	observeNativeAcquisition,
	type NativeBrowserAwaitingStep,
} from '#sign-in-test-support/test-fixtures/native-browser-progress';
import type { NativeBrowserStep } from '#sign-in-test-support/test-fixtures/native-browser-scenario';

it('commits an awaiting record before starting an operation that can remain pending', async () => {
	const entered = Promise.withResolvers<void>();
	const result = Promise.withResolvers<string>();
	const writes: (readonly (NativeBrowserStep | NativeBrowserAwaitingStep)[])[] = [];
	const progress = createNativeBrowserProgress({
		steps: () => [],
		write: async (steps): Promise<void> => {
			writes.push([...steps]);
		},
	});
	const completion = progress.observe('no-UV: verify response', (): Promise<string> => {
		expect(writes.at(-1)).toEqual([
			{
				name: 'awaiting no-UV: verify response',
				status: 'awaiting',
				facts: { operation: 'no-UV: verify response', awaitId: 1 },
			},
		]);
		entered.resolve();
		return result.promise;
	});
	void completion.catch(() => undefined);
	await Promise.race([entered.promise, completion]);
	expect(writes.at(-1)?.[0]?.status).toBe('awaiting');
	result.resolve('refused');
	await expect(completion).resolves.toBe('refused');
	expect(writes.at(-1)).toEqual([]);
});

it('does not add a scheduling layer when no observer is installed', async () => {
	const result = Promise.withResolvers<number>();
	const returned = executeNativeAwait('unobserved', () => result.promise);
	expect(returned).toBe(result.promise);
	result.resolve(9);
	await expect(returned).resolves.toBe(9);
});

it('keeps a still-pending await visible when a concurrent await completes', async () => {
	const first = Promise.withResolvers<void>();
	const second = Promise.withResolvers<void>();
	const bothStarted = Promise.withResolvers<void>();
	const writes: (readonly (NativeBrowserStep | NativeBrowserAwaitingStep)[])[] = [];
	let started = 0;
	const progress = createNativeBrowserProgress({
		steps: () => [],
		write: async (steps): Promise<void> => {
			writes.push([...steps]);
		},
	});
	const begin = (operation: string, pending: Promise<void>): Promise<void> =>
		progress.observe(operation, () => {
			started += 1;
			if (started === 2) bothStarted.resolve();
			return pending;
		});
	const firstCompletion = begin('first', first.promise);
	const secondCompletion = begin('second', second.promise);
	await bothStarted.promise;
	second.resolve();
	await secondCompletion;
	expect(writes.at(-1)).toEqual([
		{ name: 'awaiting first', status: 'awaiting', facts: { operation: 'first', awaitId: 1 } },
	]);
	first.resolve();
	await firstCompletion;
	expect(writes.at(-1)).toEqual([]);
});

it('finishes recording without awaiting a hung operation and ignores its late completion', async () => {
	const entered = Promise.withResolvers<void>();
	const pending = Promise.withResolvers<void>();
	const originalFailure: NativeBrowserStep = {
		name: 'original',
		status: 'failed',
		facts: { message: 'Native step refused' },
	};
	const writes: (readonly (NativeBrowserStep | NativeBrowserAwaitingStep)[])[] = [];
	const progress = createNativeBrowserProgress({
		steps: () => [],
		write: async (steps): Promise<void> => {
			writes.push([...steps]);
		},
	});
	const completion = progress.observe('still waiting', () => {
		entered.resolve();
		return pending.promise;
	});
	await entered.promise;
	await progress.finish();
	await progress.recordSteps([originalFailure]);
	const completedWrites = writes.length;
	pending.resolve();
	await completion;
	expect(writes.length).toBe(completedWrites);
	expect(writes.at(-1)).toEqual([originalFailure]);
});

it('preserves the operation error before a failed completion checkpoint', async () => {
	const originalFailure = new Error('Native operation rejected');
	const recordingFailure = new Error('Checkpoint write rejected');
	let writes = 0;
	const progress = createNativeBrowserProgress({
		steps: () => [],
		write: async (): Promise<void> => {
			writes += 1;
			if (writes === 2) throw recordingFailure;
		},
	});
	await expect(
		progress.observe('operation', async (): Promise<never> => {
			throw originalFailure;
		}),
	).rejects.toMatchObject({ cause: originalFailure, errors: [originalFailure, recordingFailure] });
});

it('still closes owned resources when their awaiting checkpoint rejects', async () => {
	const recordingFailure = new Error('Checkpoint write rejected');
	let writes = 0;
	let closes = 0;
	const progress = createNativeBrowserProgress({
		steps: () => [],
		write: async (): Promise<void> => {
			if (++writes === 1) throw recordingFailure;
		},
	});
	await expect(
		progress.observeCleanup('owned close', async (): Promise<void> => {
			closes += 1;
		}),
	).rejects.toBe(recordingFailure);
	expect(closes).toBe(1);
	expect(writes).toBe(2);
});

it('retains an acquired resource before its completion checkpoint can reject', async () => {
	const recordingFailure = new Error('Acquisition completion record rejected');
	let closes = 0;
	const resource = {
		close: async (): Promise<void> => {
			closes += 1;
		},
	};
	let owned: typeof resource | undefined;
	let writes = 0;
	const progress = createNativeBrowserProgress({
		steps: () => [],
		write: async (): Promise<void> => {
			if (++writes === 2) throw recordingFailure;
		},
	});
	const acquisition = observeNativeAcquisition(
		progress.observe,
		'owned resource',
		async () => resource,
		(acquired): void => {
			owned = acquired;
		},
	);
	try {
		await expect(acquisition).rejects.toBe(recordingFailure);
	} finally {
		await owned?.close();
	}
	expect(owned).toBe(resource);
	expect(closes).toBe(1);
});

it('does not erase a deciding failure with a checkpoint queued before that failure', async () => {
	const firstWriteEntered = Promise.withResolvers<void>();
	const releaseFirstWrite = Promise.withResolvers<void>();
	const pending = Promise.withResolvers<void>();
	const failure: NativeBrowserStep = { name: 'deciding step', status: 'failed', facts: {} };
	const steps: NativeBrowserStep[] = [];
	const snapshots: (readonly (NativeBrowserStep | NativeBrowserAwaitingStep)[])[] = [];
	const progress = createNativeBrowserProgress({
		steps: () => steps,
		write: async (snapshot): Promise<void> => {
			snapshots.push([...snapshot]);
			if (snapshots.length === 1) {
				firstWriteEntered.resolve();
				await releaseFirstWrite.promise;
			}
		},
	});
	const first = progress.observe('first', () => pending.promise);
	await firstWriteEntered.promise;
	const second = progress.observe('second', () => pending.promise);
	steps.push(failure);
	const failureRecorded = progress.recordSteps();
	releaseFirstWrite.resolve();
	await failureRecorded;
	pending.resolve();
	await Promise.all([first, second]);
	expect(snapshots.slice(1).every((snapshot) => snapshot.includes(failure))).toBe(true);
	expect(snapshots.at(-1)).toEqual([failure]);
});

it('serializes checkpoint writes and does not start work before its record settles', async () => {
	const firstWriteEntered = Promise.withResolvers<void>();
	const releaseWrite = Promise.withResolvers<void>();
	const started: string[] = [];
	let writes = 0;
	let activeWrites = 0;
	const overlaps: number[] = [];
	const progress = createNativeBrowserProgress({
		steps: () => [],
		write: async (): Promise<void> => {
			writes += 1;
			activeWrites += 1;
			overlaps.push(activeWrites);
			if (writes === 1) {
				firstWriteEntered.resolve();
				await releaseWrite.promise;
			}
			activeWrites -= 1;
		},
	});
	const first = progress.observe('first', async (): Promise<void> => {
		started.push('first');
	});
	const second = progress.observe('second', async (): Promise<void> => {
		started.push('second');
	});
	await firstWriteEntered.promise;
	expect(started).toEqual([]);
	releaseWrite.resolve();
	await Promise.all([first, second]);
	expect(started.toSorted()).toEqual(['first', 'second']);
	expect(overlaps.every((count) => count === 1)).toBe(true);
});
