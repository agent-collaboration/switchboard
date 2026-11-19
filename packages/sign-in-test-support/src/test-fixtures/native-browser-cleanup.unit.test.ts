import { expect, it } from 'vitest';

import {
	finishNativeBrowserScenario,
	withNativeBrowserCleanup,
} from '#sign-in-test-support/test-fixtures/native-browser-cleanup';
import { createNativeBrowserProgress } from '#sign-in-test-support/test-fixtures/native-browser-progress';

it('runs registration cancellation after a rejected checkpoint and keeps the native error decisive', async () => {
	const nativeFailure = new Error('Native registration rejected');
	const recordingFailure = new Error('Cancellation checkpoint rejected');
	let cancelled = false;
	const progress = createNativeBrowserProgress({
		steps: () => [],
		write: async (): Promise<never> => {
			throw recordingFailure;
		},
	});
	const registration = withNativeBrowserCleanup(
		() => Promise.race([Promise.reject(nativeFailure), Promise.withResolvers<never>().promise]),
		() =>
			progress.observeCleanup('registration cancellation', async (): Promise<void> => {
				cancelled = true;
			}),
	);
	await expect(registration).rejects.toMatchObject({
		cause: nativeFailure,
		errors: [nativeFailure, expect.any(AggregateError)],
	});
	expect(cancelled).toBe(true);
});

it('persists the original failure and reaches close while capture never resolves', async () => {
	// Arrange: the capture checkpoint observes its initiating continuation, without a clock.
	const originalFailure = new Error('The native passkey step failed');
	const captureCheckpoint = Promise.withResolvers<void>();
	const recordedFailures: unknown[] = [];
	let closedAfterPersistingOriginal = false;
	let finalRecord: Uint8Array | undefined;

	// Act: the capture has no resolver, so completion cannot depend on it.
	const completion = finishNativeBrowserScenario({
		failure: { kind: 'failed', error: originalFailure },
		recordFailure: async (): Promise<void> => {
			recordedFailures.push(originalFailure);
		},
		captureFailure: (): Promise<Uint8Array> => {
			queueMicrotask(() => captureCheckpoint.resolve());
			return new Promise<Uint8Array>(() => {});
		},
		close: async (): Promise<void> => {
			closedAfterPersistingOriginal = recordedFailures[0] === originalFailure;
		},
		record: async (capture): Promise<void> => {
			finalRecord = capture;
		},
	});
	void completion.catch(() => undefined);
	await captureCheckpoint.promise;

	// Assert: the original is durable through the recording port before teardown starts.
	expect(recordedFailures).toEqual([originalFailure]);
	expect(closedAfterPersistingOriginal).toBe(true);
	await expect(completion).rejects.toBe(originalFailure);
	expect(finalRecord).toBeUndefined();
});

it('records a frame that settles during close, after resources have closed', async () => {
	const originalFailure = new Error('Original native step');
	const capture = Promise.withResolvers<Uint8Array>();
	const bytes = Uint8Array.of(1, 2, 3);
	const observations: { readonly closed: boolean; readonly capture: Uint8Array | undefined }[] = [];
	let closed = false;

	await expect(
		finishNativeBrowserScenario({
			failure: { kind: 'failed', error: originalFailure },
			recordFailure: async (): Promise<void> => {},
			captureFailure: (): Promise<Uint8Array> => capture.promise,
			close: async (): Promise<void> => {
				capture.resolve(bytes);
				await capture.promise;
				closed = true;
			},
			record: async (frame): Promise<void> => {
				observations.push({ closed, capture: frame });
			},
		}),
	).rejects.toBe(originalFailure);
	expect(observations).toEqual([{ closed: true, capture: bytes }]);
});

it('does not revise the recorded outcome when a capture settles after close', async () => {
	const originalFailure = new Error('Original native step');
	const capture = Promise.withResolvers<Uint8Array>();
	const observations: (Uint8Array | undefined)[] = [];

	await expect(
		finishNativeBrowserScenario({
			failure: { kind: 'failed', error: originalFailure },
			recordFailure: async (): Promise<void> => {},
			captureFailure: (): Promise<Uint8Array> => capture.promise,
			close: async (): Promise<void> => {},
			record: async (frame): Promise<void> => {
				observations.push(frame);
			},
		}),
	).rejects.toBe(originalFailure);
	capture.resolve(Uint8Array.of(4));
	await capture.promise;
	expect(observations).toEqual([undefined]);
});

it('preserves the deciding error when optional capture rejects', async () => {
	const originalFailure = new Error('Original native step');
	const closed: string[] = [];

	await expect(
		finishNativeBrowserScenario({
			failure: { kind: 'failed', error: originalFailure },
			recordFailure: async (): Promise<void> => {},
			captureFailure: async (): Promise<never> => {
				throw new Error('Renderer unavailable');
			},
			close: async (): Promise<void> => {
				closed.push('chrome', 'harness');
			},
			record: async (frame): Promise<void> => {
				expect(frame).toBeUndefined();
			},
		}),
	).rejects.toBe(originalFailure);
	expect(closed).toEqual(['chrome', 'harness']);
});

it('attempts close and final recording when the first failure write rejects', async () => {
	const originalFailure = new Error('Original native step');
	const firstWriteFailure = new Error('Failure record write refused');
	const closeFailure = new Error('Chrome close refused');
	const finalWriteFailure = new Error('Final observation write refused');
	const attempts: string[] = [];

	await expect(
		finishNativeBrowserScenario({
			failure: { kind: 'failed', error: originalFailure },
			recordFailure: async (): Promise<never> => {
				throw firstWriteFailure;
			},
			captureFailure: async (): Promise<never> => {
				attempts.push('capture');
				throw new Error('Capture must not start before the failure is recorded');
			},
			close: async (): Promise<never> => {
				attempts.push('close');
				throw closeFailure;
			},
			record: async (): Promise<never> => {
				attempts.push('record');
				throw finalWriteFailure;
			},
		}),
	).rejects.toMatchObject({
		cause: originalFailure,
		errors: [originalFailure, firstWriteFailure, closeFailure, finalWriteFailure],
	});
	expect(attempts).toEqual(['close', 'record']);
});

it('closes and records a successful scenario without attempting failure evidence', async () => {
	const observations: string[] = [];
	await finishNativeBrowserScenario({
		failure: { kind: 'none' },
		recordFailure: async (): Promise<never> => {
			throw new Error('No original failure exists');
		},
		captureFailure: async (): Promise<never> => {
			throw new Error('No failure capture is required');
		},
		close: async (): Promise<void> => {
			observations.push('closed');
		},
		record: async (frame): Promise<void> => {
			expect(frame).toBeUndefined();
			observations.push('recorded');
		},
	});
	expect(observations).toEqual(['closed', 'recorded']);
});
