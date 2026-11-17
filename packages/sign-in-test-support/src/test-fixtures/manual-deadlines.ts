import type { SignInDeadline, SignInDeadlines } from '@agent-collaboration/sign-in-core';

export interface ManualDeadlines {
	readonly deadlines: SignInDeadlines;
	/** The duration each guard run asked for, in start order: one entry per budget. */
	readonly starts: readonly number[];
	/** Fires every deadline still running, as the platform timer would at its time. */
	readonly fire: () => void;
}

/** A deadline source the test fires itself, so no case waits on the wall clock (D7). */
export function createManualDeadlines(): ManualDeadlines {
	const starts: number[] = [];
	const running = new Set<AbortController>();
	return {
		starts,
		deadlines: {
			start(milliseconds): SignInDeadline {
				starts.push(milliseconds);
				const controller = new AbortController();
				running.add(controller);
				return { signal: controller.signal, cancel: () => running.delete(controller) };
			},
		},
		fire(): void {
			for (const controller of running)
				controller.abort(new DOMException('Deadline reached', 'TimeoutError'));
			running.clear();
		},
	};
}

/** A deadline that never fires, for cases whose central answers promptly. Built per call:
 * workerd forbids creating it in module scope. */
export function unreachedDeadline(): AbortSignal {
	return new AbortController().signal;
}
