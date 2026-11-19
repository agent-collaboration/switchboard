export type TokenRequestId = number;
export interface QueueState {
	readonly script: 'loading' | 'ready' | 'failed';
	readonly executing: TokenRequestId | null;
	readonly waiting: readonly TokenRequestId[];
}
export type QueueEvent =
	| { readonly kind: 'scriptReady' }
	| { readonly kind: 'scriptFailed' }
	| { readonly kind: 'tokenRequested'; readonly id: TokenRequestId }
	| { readonly kind: 'widgetToken'; readonly token: string }
	| { readonly kind: 'widgetFailed'; readonly cause: 'error' | 'expired' | 'timeout' };
export type QueueEffect =
	| { readonly kind: 'ensureWidget' }
	| { readonly kind: 'resetAndExecute' }
	| { readonly kind: 'resolve'; readonly id: TokenRequestId; readonly token: string }
	| {
			readonly kind: 'reject';
			readonly id: TokenRequestId;
			readonly reason: 'verification-unavailable';
	  };
interface QueueTransition {
	readonly state: QueueState;
	readonly effects: readonly QueueEffect[];
}
const executionEffects = [{ kind: 'ensureWidget' }, { kind: 'resetAndExecute' }] as const;

function startWaitingRequest(state: QueueState, effects: readonly QueueEffect[]): QueueTransition {
	const [next, ...waiting] = state.waiting;
	if (next === undefined) return { state: { ...state, executing: null }, effects };
	return {
		state: { ...state, executing: next, waiting },
		effects: [...effects, ...executionEffects],
	};
}

/** Each request owns one execution and settlement, in arrival order. Failure is terminal. */
export function turnstileQueueTransition(state: QueueState, event: QueueEvent): QueueTransition {
	switch (event.kind) {
		case 'scriptReady':
			return state.script === 'loading'
				? startWaitingRequest({ ...state, script: 'ready' }, [])
				: { state, effects: [] };
		case 'scriptFailed': {
			if (state.script === 'failed') return { state, effects: [] };
			const pending =
				state.executing === null ? state.waiting : [state.executing, ...state.waiting];
			return {
				state: { script: 'failed', executing: null, waiting: [] },
				effects: pending.map((id) => ({ kind: 'reject', id, reason: 'verification-unavailable' })),
			};
		}
		case 'tokenRequested':
			if (state.script === 'failed')
				return {
					state,
					effects: [{ kind: 'reject', id: event.id, reason: 'verification-unavailable' }],
				};
			if (state.script === 'ready' && state.executing === null)
				return { state: { ...state, executing: event.id }, effects: executionEffects };
			return { state: { ...state, waiting: [...state.waiting, event.id] }, effects: [] };
		case 'widgetToken':
			if (state.executing === null) return { state, effects: [] };
			return startWaitingRequest(state, [
				{ kind: 'resolve', id: state.executing, token: event.token },
			]);
		case 'widgetFailed':
			if (state.executing === null) return { state, effects: [] };
			return startWaitingRequest(state, [
				{ kind: 'reject', id: state.executing, reason: 'verification-unavailable' },
			]);
		default:
			return event satisfies never;
	}
}
