import { BetterFetchError, type RequestContext } from '@better-fetch/fetch';

import {
	turnstileQueueTransition,
	type QueueState,
	type QueueEvent,
	type QueueEffect,
} from '#sign-in-core/pages/islands/passkey-sign-in-turnstile-queue';

interface TurnstileWidgetOptions {
	readonly sitekey: string;
	readonly action: 'passkey_sign_in';
	readonly execution: 'execute';
	readonly appearance: 'interaction-only';
	readonly callback: (token: string) => void;
	readonly 'error-callback': () => void;
	readonly 'expired-callback': () => void;
	readonly 'timeout-callback': () => void;
}
interface SignInTurnstile {
	render(container: HTMLElement, options: TurnstileWidgetOptions): string;
	reset(widgetId: string): void;
	execute(widgetId: string): void;
}
declare global {
	interface Window {
		signInTurnstile?: QueueState['script'];
		turnstile?: SignInTurnstile;
	}
}
const unavailableMessage = 'Sign-in verification is unavailable. Reload the page to try again.';
let state: QueueState | null = null;
let nextRequestId = 0;
let widgetId: string | null = null;
const pending = new Map<
	number,
	{ readonly resolve: (token: string) => void; readonly reject: (reason: Error) => void }
>();

function applyEffect(effect: QueueEffect): void {
	switch (effect.kind) {
		case 'ensureWidget': {
			if (widgetId !== null) return;
			const container = document.getElementById('sign-in-passkey-captcha');
			const sitekey = container?.dataset['sitekey'];
			if (container === null || sitekey === undefined || window.turnstile === undefined)
				throw new Error(unavailableMessage);
			widgetId = window.turnstile.render(container, {
				sitekey,
				action: 'passkey_sign_in',
				execution: 'execute',
				appearance: 'interaction-only',
				callback: (token) => dispatch({ kind: 'widgetToken', token }),
				'error-callback': () => dispatch({ kind: 'widgetFailed', cause: 'error' }),
				'expired-callback': () => dispatch({ kind: 'widgetFailed', cause: 'expired' }),
				'timeout-callback': () => dispatch({ kind: 'widgetFailed', cause: 'timeout' }),
			});
			return;
		}
		case 'resetAndExecute':
			if (widgetId === null || window.turnstile === undefined) throw new Error(unavailableMessage);
			window.turnstile.reset(widgetId);
			window.turnstile.execute(widgetId);
			return;
		case 'resolve':
			pending.get(effect.id)?.resolve(effect.token);
			pending.delete(effect.id);
			return;
		case 'reject':
			pending.get(effect.id)?.reject(new Error(unavailableMessage));
			pending.delete(effect.id);
			return;
		default:
			return effect satisfies never;
	}
}
function dispatch(event: QueueEvent): void {
	if (state === null) return;
	const transition = turnstileQueueTransition(state, event);
	state = transition.state;
	try {
		for (const effect of transition.effects) applyEffect(effect);
	} catch {
		dispatch({ kind: 'scriptFailed' });
	}
}

/** Uses only widget callbacks and script events; each challenge gets a fresh token. */
export function passkeySignInTurnstileToken(): Promise<string> {
	if (state === null) {
		state = { script: window.signInTurnstile ?? 'loading', executing: null, waiting: [] };
		window.addEventListener('sign-in-turnstile-ready', () => dispatch({ kind: 'scriptReady' }));
		window.addEventListener('sign-in-turnstile-failed', () => dispatch({ kind: 'scriptFailed' }));
	}
	const id = ++nextRequestId;
	return new Promise<string>((resolve, reject) => {
		pending.set(id, { resolve, reject });
		dispatch({ kind: 'tokenRequested', id });
	});
}

export async function attachPasskeySignInTurnstile(
	context: RequestContext,
): Promise<RequestContext> {
	if (
		new URL(context.url, location.origin).pathname !==
		'/api/auth/passkey/generate-authenticate-options'
	)
		return context;
	let token: string;
	try {
		token = await passkeySignInTurnstileToken();
	} catch {
		// Better Auth UI reads the SDK body; a plain Error becomes its generic passkey notice.
		throw new BetterFetchError(503, unavailableMessage, {
			code: 'SIGN_IN_VERIFICATION_UNAVAILABLE',
			message: unavailableMessage,
		});
	}
	const headers = new Headers(context.headers);
	headers.set('x-captcha-response', token);
	return { ...context, headers };
}
