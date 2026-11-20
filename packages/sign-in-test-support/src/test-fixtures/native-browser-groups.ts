import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
	transitionNativeBrowserAcquisition,
	type NativeBrowserAcquisitionState,
} from '#sign-in-test-support/test-fixtures/native-browser-acquisition';
import type { NativeBrowserFailure } from '#sign-in-test-support/test-fixtures/native-browser-cleanup';
import {
	settleOwnedProcessGroup,
	terminateOwnedProcessGroup,
	type OwnedGroupCleanup,
	type GroupSignalAttempt,
} from '#sign-in-test-support/test-fixtures/owned-process-group';

export interface NativeBrowserAcquisition {
	readonly group: number;
	readonly close: () => Promise<OwnedGroupCleanup>;
	readonly cancel: () => Promise<OwnedGroupCleanup>;
}
export interface NativeBrowserParent {
	readonly requestClose: (
		requestTermination: () => GroupSignalAttempt,
	) => Promise<NativeBrowserFailure>;
	readonly waitForExit: () => Promise<void>;
}
export interface NativeBrowserGroupRegistry {
	readonly assertAccepting: () => void;
	readonly retain: (props: {
		readonly group: number;
		readonly evidence: string;
		readonly parent: NativeBrowserParent;
	}) => NativeBrowserAcquisition;
	readonly closeAll: (reason: 'teardown' | 'signal') => Promise<void>;
}

/** Active membership can end while the acquisition handle keeps its terminal completion. */
export function createNativeBrowserGroupRegistry(
	onOwnershipChanged: (count: number) => void,
): NativeBrowserGroupRegistry {
	const active = new Set<NativeBrowserAcquisition>();
	let lifecycle: 'accepting' | 'terminating' = 'accepting';
	const assertAccepting = (): void => {
		if (lifecycle !== 'accepting') throw new Error('Browser worker is terminating');
	};
	return {
		assertAccepting,
		retain: (props): NativeBrowserAcquisition => {
			assertAccepting();
			if (
				!Number.isSafeInteger(props.group) ||
				props.group <= 0 ||
				[...active].some((owner) => owner.group === props.group)
			)
				throw new Error('Invalid or duplicate Chrome group');
			let state: NativeBrowserAcquisitionState = { kind: 'retained' };
			const termination = (): GroupSignalAttempt | undefined =>
				state.kind === 'closing' && state.termination.kind === 'recorded'
					? state.termination.outcome
					: undefined;
			const terminateOnce = (): GroupSignalAttempt => {
				state = transitionNativeBrowserAcquisition(state, { kind: 'termination-requested' });
				if (state.kind === 'closing' && state.termination.kind === 'requested') {
					let outcome: GroupSignalAttempt = { kind: 'failed', signal: 'SIGTERM' };
					try {
						outcome = terminateOwnedProcessGroup(props.group);
					} catch {
						/* Record the one failed attempt. */
					}
					state = transitionNativeBrowserAcquisition(state, {
						kind: 'termination-recorded',
						outcome,
					});
				}
				const observed = termination();
				if (observed === undefined) throw new Error('Cannot signal a terminal Chrome acquisition');
				return observed;
			};
			const performClose = async (
				completion: PromiseWithResolvers<OwnedGroupCleanup>,
			): Promise<void> => {
				const finishTerminal = (): void => {
					if (state.kind !== 'closed' && state.kind !== 'failed')
						throw new Error('Acquisition has no terminal outcome');
					const terminal = state;
					const observed =
						terminal.kind === 'closed'
							? terminal.result
							: terminal.observation.kind === 'ready'
								? terminal.observation.result
								: undefined;
					const quiet =
						observed !== undefined &&
						observed.remaining !== null &&
						observed.remaining.length === 0;
					if (quiet) active.delete(owner);
					else lifecycle = 'terminating';
					if (terminal.kind === 'closed') completion.resolve(terminal.result);
					else completion.reject(terminal.reason);
					if (quiet) onOwnershipChanged(active.size);
				};
				const writeAndPublish = async (): Promise<void> => {
					if (state.kind !== 'closing' || state.observation.kind !== 'ready')
						throw new Error('Missing current close observation');
					const written = state.observation.result;
					await writeFile(
						path.join(props.evidence, 'chrome-cleanup.json'),
						JSON.stringify(written, null, 2) + '\n',
						{ mode: 0o600 },
					);
					state = transitionNativeBrowserAcquisition(state, { kind: 'write-settled', written });
					if (state.kind === 'closing') return writeAndPublish();
					finishTerminal();
				};
				try {
					let parentFailure: NativeBrowserFailure = { kind: 'none' };
					try {
						parentFailure = await props.parent.requestClose(terminateOnce);
					} catch (error) {
						parentFailure = { kind: 'failed', error };
						terminateOnce();
					}
					try {
						await props.parent.waitForExit();
					} catch (error) {
						parentFailure = {
							kind: 'failed',
							error:
								parentFailure.kind === 'none'
									? error
									: new AggregateError([parentFailure.error, error], 'Chrome parent close failed', {
											cause: parentFailure.error,
										}),
						};
						terminateOnce();
					}
					state = transitionNativeBrowserAcquisition(state, {
						kind: 'parent-settled',
						failure: parentFailure,
					});
					const initial = termination();
					const result = await settleOwnedProcessGroup({
						group: props.group,
						terminate: terminateOnce,
						...(initial === undefined ? {} : { initialTermination: initial }),
					});
					state = transitionNativeBrowserAcquisition(state, { kind: 'close-observed', result });
					await writeAndPublish();
				} catch (error) {
					state = transitionNativeBrowserAcquisition(state, { kind: 'failed', reason: error });
					finishTerminal();
				}
			};
			const requestClose = (action: 'close' | 'cancel'): Promise<OwnedGroupCleanup> => {
				if (state.kind !== 'retained') {
					state = transitionNativeBrowserAcquisition(state, {
						kind: 'request',
						action,
						promise: state.promise,
					});
					if (state.kind === 'closing' && state.termination.kind === 'requested') terminateOnce();
					if (state.kind === 'retained') throw new Error('Acquisition unexpectedly reopened');
					return state.promise;
				}
				const completion = Promise.withResolvers<OwnedGroupCleanup>();
				state = transitionNativeBrowserAcquisition(state, {
					kind: 'request',
					action,
					promise: completion.promise,
				});
				if (state.kind === 'closing' && state.termination.kind === 'requested') terminateOnce();
				void performClose(completion);
				return completion.promise;
			};
			const owner: NativeBrowserAcquisition = {
				group: props.group,
				close: () => requestClose('close'),
				cancel: () => requestClose('cancel'),
			};
			active.add(owner);
			onOwnershipChanged(active.size);
			return owner;
		},
		closeAll: async (reason): Promise<void> => {
			if (reason === 'signal') lifecycle = 'terminating';
			const results = await Promise.allSettled(
				[...active].map((owner) => (reason === 'signal' ? owner.cancel() : owner.close())),
			);
			if (results.some((result) => result.status === 'rejected'))
				throw new Error('Retained Chrome groups did not all close');
		},
	};
}

let terminating: Promise<void> | undefined;
const terminateWorker = (signal: 'SIGINT' | 'SIGTERM'): void => {
	terminating ??= nativeBrowserGroups.closeAll('signal').then(
		(): never => process.exit(signal === 'SIGTERM' ? 143 : 130),
		(): void => {
			// Keep ownership on failure; no forceful signal and no successful exit is claimed.
			process.exitCode = 1;
		},
	);
};
const interrupt = (): void => terminateWorker('SIGINT');
const terminate = (): void => terminateWorker('SIGTERM');
export const nativeBrowserGroups = createNativeBrowserGroupRegistry((count): void => {
	if (count > 0) {
		if (!process.listeners('SIGINT').includes(interrupt)) process.on('SIGINT', interrupt);
		if (!process.listeners('SIGTERM').includes(terminate)) process.on('SIGTERM', terminate);
	} else if (count === 0) {
		process.off('SIGINT', interrupt);
		process.off('SIGTERM', terminate);
	}
});
