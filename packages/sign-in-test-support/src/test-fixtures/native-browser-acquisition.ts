import type { NativeBrowserFailure } from './native-browser-cleanup';
import type { GroupSignalAttempt, OwnedGroupCleanup } from './owned-process-group';

type AcquisitionTermination =
	| { readonly kind: 'none' }
	| { readonly kind: 'requested' }
	| { readonly kind: 'recorded'; readonly outcome: GroupSignalAttempt };
type CloseObservation =
	| { readonly kind: 'waiting-parent' }
	| { readonly kind: 'waiting-group'; readonly parentFailure: NativeBrowserFailure }
	| {
			readonly kind: 'ready';
			readonly parentFailure: NativeBrowserFailure;
			readonly result: OwnedGroupCleanup;
	  };
export type NativeBrowserAcquisitionState =
	| { readonly kind: 'retained' }
	| {
			readonly kind: 'closing';
			readonly promise: Promise<OwnedGroupCleanup>;
			readonly termination: AcquisitionTermination;
			readonly observation: CloseObservation;
	  }
	| {
			readonly kind: 'closed';
			readonly promise: Promise<OwnedGroupCleanup>;
			readonly result: OwnedGroupCleanup & { readonly remaining: readonly [] };
	  }
	| {
			readonly kind: 'failed';
			readonly promise: Promise<OwnedGroupCleanup>;
			readonly reason: unknown;
			readonly observation: CloseObservation;
	  };
export type NativeBrowserAcquisitionEvent =
	| {
			readonly kind: 'request';
			readonly action: 'close' | 'cancel';
			readonly promise: Promise<OwnedGroupCleanup>;
	  }
	| { readonly kind: 'termination-requested' }
	| { readonly kind: 'termination-recorded'; readonly outcome: GroupSignalAttempt }
	| { readonly kind: 'parent-settled'; readonly failure: NativeBrowserFailure }
	| { readonly kind: 'close-observed'; readonly result: OwnedGroupCleanup }
	| { readonly kind: 'write-settled'; readonly written: OwnedGroupCleanup }
	| { readonly kind: 'failed'; readonly reason: unknown };

function currentObservation(
	result: OwnedGroupCleanup,
	termination: AcquisitionTermination,
): OwnedGroupCleanup {
	if (termination.kind !== 'recorded') return result;
	return result.kind === 'natural'
		? { ...result, kind: 'intervened', termination: termination.outcome }
		: { ...result, termination: termination.outcome };
}
/** Publication requires a diagnostic for the current observation, with no intervening cancellation. */
export function transitionNativeBrowserAcquisition(
	state: NativeBrowserAcquisitionState,
	event: NativeBrowserAcquisitionEvent,
): NativeBrowserAcquisitionState {
	if (state.kind === 'closed' || state.kind === 'failed') return state;
	switch (event.kind) {
		case 'request':
			if (state.kind === 'retained')
				return {
					kind: 'closing',
					promise: event.promise,
					termination: { kind: event.action === 'cancel' ? 'requested' : 'none' },
					observation: { kind: 'waiting-parent' },
				};
			if (event.action === 'cancel' && state.termination.kind === 'none')
				return { ...state, termination: { kind: 'requested' } };
			return state;
		case 'termination-requested':
			return state.kind === 'closing' && state.termination.kind === 'none'
				? { ...state, termination: { kind: 'requested' } }
				: state;
		case 'termination-recorded': {
			if (state.kind !== 'closing' || state.termination.kind !== 'requested') return state;
			const termination = { kind: 'recorded', outcome: event.outcome } as const;
			return {
				...state,
				termination,
				observation:
					state.observation.kind !== 'ready'
						? state.observation
						: {
								kind: 'ready',
								parentFailure: state.observation.parentFailure,
								result: currentObservation(state.observation.result, termination),
							},
			};
		}
		case 'parent-settled':
			return state.kind === 'closing' && state.observation.kind === 'waiting-parent'
				? { ...state, observation: { kind: 'waiting-group', parentFailure: event.failure } }
				: state;
		case 'close-observed':
			return state.kind === 'closing' && state.observation.kind === 'waiting-group'
				? {
						...state,
						observation: {
							kind: 'ready',
							parentFailure: state.observation.parentFailure,
							result: currentObservation(event.result, state.termination),
						},
					}
				: state;
		case 'write-settled': {
			if (
				state.kind !== 'closing' ||
				state.termination.kind === 'requested' ||
				state.observation.kind !== 'ready' ||
				state.observation.result !== event.written
			)
				return state;
			const result = state.observation.result;
			if (state.observation.parentFailure.kind === 'failed')
				return {
					kind: 'failed',
					promise: state.promise,
					reason: state.observation.parentFailure.error,
					observation: state.observation,
				};
			return result.kind !== 'unknown' && result.remaining.length === 0
				? { kind: 'closed', promise: state.promise, result: { ...result, remaining: [] } }
				: {
						kind: 'failed',
						promise: state.promise,
						reason: new Error('Owned Chrome group did not close completely'),
						observation: state.observation,
					};
		}
		case 'failed':
			return state.kind === 'closing'
				? {
						kind: 'failed',
						promise: state.promise,
						reason: event.reason,
						observation: state.observation,
					}
				: state;
		default:
			return event satisfies never;
	}
}
