import type { NativeBrowserStep } from '#sign-in-test-support/test-fixtures/native-browser-scenario';

export interface NativeBrowserAwaitingStep {
	readonly name: string;
	readonly status: 'awaiting';
	readonly facts: { readonly operation: string; readonly awaitId: number };
}

export type NativeAwaitObserver = <TValue>(
	operation: string,
	perform: () => Promise<TValue>,
) => Promise<TValue>;

export interface NativeBrowserProgress {
	readonly observe: NativeAwaitObserver;
	readonly observeCleanup: NativeAwaitObserver;
	readonly recordSteps: (steps?: readonly NativeBrowserStep[]) => Promise<void>;
	readonly finish: () => Promise<void>;
}

/** Ownership transfers before the observer can reject its completion snapshot. */
export function observeNativeAcquisition<TResource>(
	observe: NativeAwaitObserver,
	operation: string,
	acquire: () => Promise<TResource>,
	retain: (resource: TResource) => void,
): Promise<TResource> {
	return observe(operation, async () => {
		const resource = await acquire();
		retain(resource);
		return resource;
	});
}

/** Serializes transient await snapshots separately from completed product evidence. */
export function createNativeBrowserProgress(props: {
	readonly steps: () => readonly NativeBrowserStep[];
	readonly write: (
		steps: readonly (NativeBrowserStep | NativeBrowserAwaitingStep)[],
	) => Promise<void>;
}): NativeBrowserProgress {
	const pendingAwaits = new Map<number, string>();
	let nextAwaitId = 0;
	let lifecycle: 'observing' | 'finished' = 'observing';
	let pendingWrite = Promise.resolve();
	function snapshot(steps?: readonly NativeBrowserStep[]): Promise<void> {
		const write = pendingWrite.then(() => {
			const awaiting =
				lifecycle === 'finished'
					? []
					: Array.from(pendingAwaits, ([awaitId, operation]): NativeBrowserAwaitingStep => ({
							name: `awaiting ${operation}`,
							status: 'awaiting',
							facts: { operation, awaitId },
						}));
			return props.write([...(steps ?? props.steps()), ...awaiting]);
		});
		// Each caller retains its own rejection; a failed write does not poison the close-time queue.
		pendingWrite = write.then(
			(): void => {},
			(): void => {},
		);
		return write;
	}
	async function observeOperation<TValue>(
		operation: string,
		perform: () => Promise<TValue>,
		continueCleanup: boolean,
	): Promise<TValue> {
		if (lifecycle === 'finished') return perform();
		const awaitId = ++nextAwaitId;
		pendingAwaits.set(awaitId, operation);
		const recordingFailures: unknown[] = [];
		try {
			await snapshot();
		} catch (recordingError) {
			if (!continueCleanup) {
				pendingAwaits.delete(awaitId);
				throw recordingError;
			}
			// A rejected checkpoint must not prevent the already-owned browser/harness from closing.
			recordingFailures.push(recordingError);
		}
		let outcome:
			| { readonly kind: 'returned'; readonly value: TValue }
			| { readonly kind: 'failed'; readonly error: unknown };
		try {
			outcome = { kind: 'returned', value: await perform() };
		} catch (error) {
			outcome = { kind: 'failed', error };
		}
		pendingAwaits.delete(awaitId);
		try {
			if (lifecycle === 'observing') await snapshot();
		} catch (recordingError) {
			recordingFailures.push(recordingError);
		}
		const failures =
			outcome.kind === 'failed' ? [outcome.error, ...recordingFailures] : recordingFailures;
		if (failures.length === 1) throw failures[0];
		if (failures.length > 1)
			throw new AggregateError(failures, 'Await and checkpoint failed', { cause: failures[0] });
		if (outcome.kind === 'failed') throw outcome.error;
		return outcome.value;
	}
	return {
		observe: (operation, perform) => observeOperation(operation, perform, false),
		observeCleanup: (operation, perform) => observeOperation(operation, perform, true),
		recordSteps: snapshot,
		finish: async (): Promise<void> => {
			lifecycle = 'finished';
			await pendingWrite;
		},
	};
}

/** Without an observer the original producer runs immediately and returns its original promise. */
export function executeNativeAwait<TValue>(
	_operation: string,
	perform: () => Promise<TValue>,
): Promise<TValue> {
	return perform();
}
