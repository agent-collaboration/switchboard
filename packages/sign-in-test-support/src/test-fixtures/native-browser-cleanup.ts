export type NativeBrowserFailure =
	| { readonly kind: 'none' }
	| { readonly kind: 'failed'; readonly error: unknown };

export interface NativeBrowserCompletion {
	readonly failure: NativeBrowserFailure;
	readonly recordFailure: () => Promise<void>;
	readonly captureFailure?: () => Promise<Uint8Array>;
	readonly close: () => Promise<void>;
	readonly record: (capture: Uint8Array | undefined) => Promise<void>;
}

type FailureCapture =
	| { readonly kind: 'pending' }
	| { readonly kind: 'captured'; readonly bytes: Uint8Array }
	| { readonly kind: 'closed' };

/** Records the deciding failure before optional capture, then closes without waiting for a frame. */
export async function finishNativeBrowserScenario(props: NativeBrowserCompletion): Promise<void> {
	const failures: unknown[] = [];
	const capture: { state: FailureCapture } = { state: { kind: 'pending' } };
	if (props.failure.kind === 'failed') {
		failures.push(props.failure.error);
		try {
			await props.recordFailure();
			try {
				// Capture returns bytes only. Its completion cannot write after this lifecycle closes.
				void props.captureFailure?.().then(
					(bytes): void => {
						if (capture.state.kind === 'pending') capture.state = { kind: 'captured', bytes };
					},
					(): void => {},
				);
			} catch {
				// A failed optional capture never replaces the deciding error.
			}
		} catch (recordingError) {
			failures.push(recordingError);
		}
	}
	try {
		await props.close();
	} catch (closeError) {
		failures.push(closeError);
	}
	const capturedBytes = capture.state.kind === 'captured' ? capture.state.bytes : undefined;
	capture.state = { kind: 'closed' };
	try {
		await props.record(capturedBytes);
	} catch (recordingError) {
		failures.push(recordingError);
	}
	if (failures.length === 1) throw failures[0];
	if (failures.length > 1)
		throw new AggregateError(failures, 'Native browser scenario, observation or cleanup failed', {
			cause: failures[0],
		});
}
