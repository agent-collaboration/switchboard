import * as hegel from '@hegeldev/hegel';
import * as generators from '@hegeldev/hegel/generators';
import { beforeEach, expect, it, vi } from 'vitest';

import type { NativeBrowserFailure } from './native-browser-cleanup';
import { createNativeBrowserGroupRegistry } from './native-browser-groups';
import type { GroupSignalAttempt, OwnedGroupCleanup } from './owned-process-group';

const effects = vi.hoisted(() => ({ settle: vi.fn(), terminate: vi.fn(), write: vi.fn() }));
vi.mock('./owned-process-group', () => ({
	settleOwnedProcessGroup: effects.settle,
	terminateOwnedProcessGroup: effects.terminate,
}));
vi.mock('node:fs/promises', async (original) => ({
	...(await original<typeof import('node:fs/promises')>()),
	writeFile: effects.write,
}));
const inertParent = {
	requestClose: async (): Promise<NativeBrowserFailure> => ({ kind: 'none' }),
	waitForExit: async (): Promise<void> => {},
};

function natural(group: number): OwnedGroupCleanup {
	return {
		kind: 'natural',
		group,
		reads: [[]],
		termination: { kind: 'not-requested' },
		remaining: [],
	};
}
beforeEach((): void => {
	vi.clearAllMocks();
	effects.write.mockResolvedValue(undefined);
	effects.terminate.mockImplementation((): GroupSignalAttempt => ({
		kind: 'sent',
		signal: 'SIGTERM',
	}));
	effects.settle.mockImplementation(
		async (props: { readonly group: number }): Promise<OwnedGroupCleanup> => natural(props.group),
	);
});

it('joins teardown-before-finally and keeps a closed old acquisition separate from PID reuse', async (): Promise<void> => {
	const membership: number[] = [];
	const registry = createNativeBrowserGroupRegistry((count): void => {
		membership.push(count);
	});
	const original = registry.retain({ group: 121, evidence: '/inert/first', parent: inertParent });
	await registry.closeAll('teardown');
	const firstCompletion = original.close();
	await expect(firstCompletion).resolves.toMatchObject({ remaining: [] });
	expect(original.close()).toBe(firstCompletion);
	const reused = registry.retain({ group: 121, evidence: '/inert/second', parent: inertParent });
	expect(original.cancel()).toBe(firstCompletion);
	expect(effects.terminate).not.toHaveBeenCalled();
	await reused.close();
	expect(membership).toEqual([1, 0, 1, 0]);
	expect(effects.settle).toHaveBeenCalledTimes(2);
});

it('preserves one failed acquisition promise across finally, close and cancellation', async (): Promise<void> => {
	const failure = new Error('Inert observation failed');
	effects.settle.mockRejectedValue(failure);
	const registry = createNativeBrowserGroupRegistry((): void => {});
	const owner = registry.retain({ group: 121, evidence: '/inert/failed', parent: inertParent });
	const completion = owner.close();
	await expect(completion).rejects.toBe(failure);
	expect(owner.close()).toBe(completion);
	expect(owner.cancel()).toBe(completion);
	expect(registry.assertAccepting).toThrow('terminating');
	await expect(registry.closeAll('signal')).rejects.toThrow('did not all close');
	expect(effects.settle).toHaveBeenCalledTimes(1);
	expect(effects.terminate).not.toHaveBeenCalled();
});

it('Hegel: close, cancel and finally orderings close one acquisition once with at most one SIGTERM', async (): Promise<void> => {
	await hegel.testAsync(
		async (testCase): Promise<void> => {
			const actions = testCase.draw(
				generators.arrays(generators.sampledFrom(['close', 'cancel', 'finally'] as const), {
					minSize: 1,
					maxSize: 18,
				}),
			);
			const finishAt = testCase.draw(
				generators.integers({ minValue: 0, maxValue: actions.length - 1 }),
			);
			effects.settle.mockClear();
			effects.terminate.mockClear();
			effects.write.mockClear();
			const settled = Promise.withResolvers<OwnedGroupCleanup>();
			effects.settle.mockImplementation((): Promise<OwnedGroupCleanup> => settled.promise);
			const membership: number[] = [];
			const registry = createNativeBrowserGroupRegistry((count): void => {
				membership.push(count);
			});
			const owner = registry.retain({
				group: 121,
				evidence: '/inert/sequence',
				parent: inertParent,
			});
			const pending: Promise<unknown>[] = [];
			let completion: Promise<OwnedGroupCleanup> | undefined;
			const requestAction = (action: 'close' | 'cancel' | 'finally'): void => {
				const request = action === 'cancel' ? owner.cancel() : owner.close();
				completion ??= request;
				expect(request).toBe(completion);
				pending.push(request);
				if (action === 'cancel') pending.push(registry.closeAll('signal'));
			};
			actions.slice(0, finishAt + 1).forEach(requestAction);
			settled.resolve(natural(121));
			await Promise.all(pending);
			actions.slice(finishAt + 1).forEach(requestAction);
			await Promise.all(pending);
			expect(owner.close()).toBe(completion);
			await registry.closeAll('teardown');
			expect(membership).toEqual([1, 0]);
			expect(effects.settle).toHaveBeenCalledTimes(1);
			expect(effects.terminate).toHaveBeenCalledTimes(
				actions.slice(0, finishAt + 1).includes('cancel') ? 1 : 0,
			);
		},
		{
			testCases: 2_000,
			seed: 20261120,
			derandomize: true,
			database: hegel.Database.disabled,
			reportMultipleFailures: false,
		},
	);
});

it('keeps the journal and result coherent when cancellation is queued at a fulfilled-write boundary', async (): Promise<void> => {
	const registry = createNativeBrowserGroupRegistry((): void => {});
	const owner = registry.retain({
		group: 121,
		evidence: '/inert/write-boundary',
		parent: inertParent,
	});
	const diagnostics: string[] = [];
	let cancellation: Promise<void> | undefined;
	let firstWrite = true;
	effects.write.mockImplementation((_file: unknown, contents: unknown): Promise<void> => {
		if (typeof contents !== 'string') throw new Error('Expected a serialized cleanup receipt');
		diagnostics.push(contents);
		const written = Promise.resolve();
		if (firstWrite) {
			firstWrite = false;
			void written.then((): void => {
				queueMicrotask((): void => {
					cancellation = registry.closeAll('signal');
				});
			});
		}
		return written;
	});
	const result = await owner.close();
	await cancellation;
	expect(effects.terminate.mock.calls.length).toBeLessThanOrEqual(1);
	expect(result.kind).toBe(effects.terminate.mock.calls.length === 0 ? 'natural' : 'intervened');
	expect(diagnostics.at(-1)).toBe(JSON.stringify(result, null, 2) + '\n');
	expect(owner.close()).toBe(owner.close());
});

it('Hegel: observation, fulfilled-write and cancellation orderings publish coherent diagnostics', async (): Promise<void> => {
	const reached = new Set<string>();
	await hegel.testAsync(
		async (testCase): Promise<void> => {
			const timing = testCase.draw(
				generators.sampledFrom([
					'during-close',
					'during-write',
					'fulfilled-write',
					'after-publication',
					'none',
				] as const),
			);
			reached.add(timing);
			const repeats = testCase.draw(generators.integers({ minValue: 1, maxValue: 5 }));
			effects.settle.mockClear();
			effects.terminate.mockClear();
			effects.write.mockClear();
			const observed = Promise.withResolvers<OwnedGroupCleanup>();
			const writing = Promise.withResolvers<void>();
			const written = Promise.withResolvers<void>();
			const diagnostics: string[] = [];
			let firstWrite = true;
			let cancellation: Promise<void> | undefined;
			const registry = createNativeBrowserGroupRegistry((): void => {});
			const owner = registry.retain({
				group: 121,
				evidence: '/inert/publication-sequence',
				parent: inertParent,
			});
			const cancel = (): void => {
				cancellation = registry.closeAll('signal');
			};
			effects.settle.mockImplementation((): Promise<OwnedGroupCleanup> => observed.promise);
			effects.write.mockImplementation((_file: unknown, contents: unknown): Promise<void> => {
				if (typeof contents !== 'string') throw new Error('Expected a serialized cleanup receipt');
				diagnostics.push(contents);
				if (!firstWrite) return Promise.resolve();
				firstWrite = false;
				writing.resolve();
				if (timing === 'during-write') return written.promise;
				const fulfilled = Promise.resolve();
				if (timing === 'fulfilled-write')
					void fulfilled.then((): void => {
						queueMicrotask(cancel);
					});
				return fulfilled;
			});
			const completion = owner.close();
			if (timing === 'during-close') Array.from({ length: repeats }).forEach(cancel);
			observed.resolve(natural(121));
			await writing.promise;
			if (timing === 'during-write') {
				Array.from({ length: repeats }).forEach(cancel);
				written.resolve();
			}
			const result = await completion;
			if (timing === 'after-publication') Array.from({ length: repeats }).forEach(cancel);
			await cancellation;
			expect(effects.settle).toHaveBeenCalledTimes(1);
			expect(effects.terminate.mock.calls.length).toBeLessThanOrEqual(1);
			expect(effects.write.mock.calls.length).toBeLessThanOrEqual(2);
			expect(result.kind).toBe(
				effects.terminate.mock.calls.length === 0 ? 'natural' : 'intervened',
			);
			expect(diagnostics.at(-1)).toBe(JSON.stringify(result, null, 2) + '\n');
			expect(owner.close()).toBe(completion);
		},
		{
			testCases: 2_000,
			seed: 20261120,
			derandomize: true,
			database: hegel.Database.disabled,
			reportMultipleFailures: false,
		},
	);
	for (const timing of [
		'during-close',
		'during-write',
		'fulfilled-write',
		'after-publication',
		'none',
	])
		expect(reached.has(timing), timing).toBe(true);
});

it('keeps unknown cleanup failed while recording cancellation that arrives during its diagnostic write', async (): Promise<void> => {
	const unknown: OwnedGroupCleanup = {
		kind: 'unknown',
		group: 121,
		reads: [],
		termination: { kind: 'not-requested' },
		remaining: null,
	};
	effects.settle.mockResolvedValue(unknown);
	const writing = Promise.withResolvers<void>();
	const written = Promise.withResolvers<void>();
	const diagnostics: string[] = [];
	effects.write.mockImplementation((_file: unknown, contents: unknown): Promise<void> => {
		if (typeof contents !== 'string') throw new Error('Expected a serialized cleanup receipt');
		diagnostics.push(contents);
		if (diagnostics.length === 1) {
			writing.resolve();
			return written.promise;
		}
		return Promise.resolve();
	});
	const registry = createNativeBrowserGroupRegistry((): void => {});
	const owner = registry.retain({
		group: 121,
		evidence: '/inert/unknown-publication',
		parent: inertParent,
	});
	const completion = owner.close();
	const failed = expect(completion).rejects.toThrow('did not close completely');
	await writing.promise;
	const cancelled = expect(registry.closeAll('signal')).rejects.toThrow('did not all close');
	written.resolve();
	await Promise.all([failed, cancelled]);
	expect(effects.terminate).toHaveBeenCalledTimes(1);
	expect(diagnostics.at(-1)).toBe(
		JSON.stringify({ ...unknown, termination: { kind: 'sent', signal: 'SIGTERM' } }, null, 2) +
			'\n',
	);
	expect(owner.close()).toBe(completion);
});

it('awaits the retained direct-parent exit capability before sampling descendants', async (): Promise<void> => {
	const parentExited = Promise.withResolvers<void>();
	const requested = Promise.withResolvers<void>();
	const props = {
		group: 121,
		evidence: '/inert/parent-exit',
		parent: {
			waitForExit: (): Promise<void> => parentExited.promise,
			requestClose: async (): Promise<{ kind: 'none' }> => {
				requested.resolve();
				return { kind: 'none' };
			},
		},
	};
	const registry = createNativeBrowserGroupRegistry((): void => {});
	const owner = registry.retain(props);
	const completion = owner.close();
	try {
		expect(effects.settle).not.toHaveBeenCalled();
		await requested.promise;
		expect(effects.settle).not.toHaveBeenCalled();
	} finally {
		parentExited.resolve();
		await completion;
	}
	expect(effects.settle).toHaveBeenCalledTimes(1);
	expect(effects.terminate).not.toHaveBeenCalled();
});

it('retains a parent-close error for late finally while releasing explicitly empty physical membership', async (): Promise<void> => {
	const failure = new Error('Parent close checkpoint failed');
	const membership: number[] = [];
	const registry = createNativeBrowserGroupRegistry((count): void => {
		membership.push(count);
	});
	const owner = registry.retain({
		group: 121,
		evidence: '/inert/parent-close-error',
		parent: {
			requestClose: async (): Promise<NativeBrowserFailure> => ({ kind: 'failed', error: failure }),
			waitForExit: async (): Promise<void> => {},
		},
	});
	await expect(registry.closeAll('teardown')).rejects.toThrow('did not all close');
	const completion = owner.close();
	await expect(completion).rejects.toBe(failure);
	expect(owner.cancel()).toBe(completion);
	expect(registry.assertAccepting).not.toThrow();
	expect(membership).toEqual([1, 0]);
	expect(effects.settle).toHaveBeenCalledTimes(1);
	expect(effects.terminate).not.toHaveBeenCalled();
});
