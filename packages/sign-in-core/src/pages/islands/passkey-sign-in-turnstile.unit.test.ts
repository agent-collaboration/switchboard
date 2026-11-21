import type { RequestContext } from '@better-fetch/fetch';
// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';

type Runner = typeof import('#sign-in-core/pages/islands/passkey-sign-in-turnstile');
let runner: Runner;
let callbacks: Parameters<NonNullable<Window['turnstile']>['render']>[1];
let execution = 0;
const render = vi.fn((_container: HTMLElement, options: typeof callbacks): string => {
	callbacks = options;
	return 'passkey-widget';
});
const reset = vi.fn();
const execute = vi.fn((): void => {
	execution += 1;
});
const context = (pathname = '/api/auth/passkey/generate-authenticate-options'): RequestContext => ({
	url: new URL(pathname, location.origin),
	method: 'GET',
	headers: new Headers({ 'x-preserved': 'present' }),
});

function observeSettlement<TValue>(promise: Promise<TValue>): {
	readonly read: () =>
		| { readonly kind: 'pending' }
		| { readonly kind: 'resolved'; readonly value: TValue }
		| { readonly kind: 'rejected'; readonly message: string };
} {
	let outcome:
		| { readonly kind: 'pending' }
		| { readonly kind: 'resolved'; readonly value: TValue }
		| { readonly kind: 'rejected'; readonly message: string } = { kind: 'pending' };
	void promise.then(
		(value): void => {
			outcome = { kind: 'resolved', value };
		},
		(error: unknown): void => {
			outcome = {
				kind: 'rejected',
				message: error instanceof Error ? error.message : 'Unknown failure',
			};
		},
	);
	return { read: () => outcome };
}
/** The request hook awaits the token, then its caller's observer runs: two promise turns. */
async function settleRequestMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

beforeEach(async () => {
	vi.restoreAllMocks();
	vi.resetModules();
	render.mockClear();
	reset.mockClear();
	execute.mockClear();
	execution = 0;
	// Module listeners belong to the previous test's window; stubbing the event surface keeps ownership local.
	const events = new EventTarget();
	vi.spyOn(window, 'addEventListener').mockImplementation(events.addEventListener.bind(events));
	vi.spyOn(window, 'dispatchEvent').mockImplementation(events.dispatchEvent.bind(events));
	document.body.innerHTML =
		'<div id="sign-in-passkey-captcha" data-sitekey="test-only-site-key"></div>';
	window.signInTurnstile = 'ready';
	window.turnstile = { render, reset, execute };
	runner = await import('#sign-in-core/pages/islands/passkey-sign-in-turnstile');
});
it('leaves other requests untouched', async () => {
	const request = context('/api/auth/get-session');
	expect(await runner.attachPasskeySignInTurnstile(request)).toBe(request);
	expect(execution).toBe(0);
});
it('serializes overlapping requests, renders once, and attaches distinct fresh tokens', async () => {
	const first = runner.attachPasskeySignInTurnstile(context());
	const second = runner.attachPasskeySignInTurnstile(context());
	const firstOutcome = observeSettlement(first);
	const secondOutcome = observeSettlement(second);
	expect(execution).toBe(1);
	expect(reset.mock.invocationCallOrder[0]).toBeLessThan(execute.mock.invocationCallOrder[0] ?? 0);
	callbacks.callback('first-token');
	expect(execution).toBe(2);
	callbacks.callback('second-token');
	await settleRequestMicrotasks();
	expect(firstOutcome.read()).toMatchObject({ kind: 'resolved' });
	expect(secondOutcome.read()).toMatchObject({ kind: 'resolved' });
	expect((await first).headers.get('x-captcha-response')).toBe('first-token');
	expect((await second).headers.get('x-captcha-response')).toBe('second-token');
	expect((await first).headers.get('x-preserved')).toBe('present');
	expect(render).toHaveBeenCalledTimes(1);
	expect(reset).toHaveBeenCalledTimes(2);
});
it.each(['error-callback', 'expired-callback', 'timeout-callback'] as const)(
	'settles %s and lets the next attempt execute',
	async (callback) => {
		const first = runner.passkeySignInTurnstileToken();
		const rejected = expect(first).rejects.toThrow('Sign-in verification is unavailable');
		const second = runner.passkeySignInTurnstileToken();
		const firstOutcome = observeSettlement(first);
		const secondOutcome = observeSettlement(second);
		callbacks[callback]();
		expect(execution).toBe(2);
		callbacks.callback('next-token');
		await settleRequestMicrotasks();
		expect(firstOutcome.read()).toMatchObject({ kind: 'rejected' });
		expect(secondOutcome.read()).toEqual({ kind: 'resolved', value: 'next-token' });
		await rejected;
		expect(await second).toBe('next-token');
	},
);
it('waits for readiness and rejects all queued and future calls after script failure', async () => {
	window.signInTurnstile = 'loading';
	const first = runner.passkeySignInTurnstileToken();
	const second = runner.passkeySignInTurnstileToken();
	const firstOutcome = observeSettlement(first);
	const secondOutcome = observeSettlement(second);
	const refusals = Promise.all([
		expect(first).rejects.toThrow('unavailable'),
		expect(second).rejects.toThrow('unavailable'),
	]);
	expect(execution).toBe(0);
	window.dispatchEvent(new Event('sign-in-turnstile-ready'));
	expect(execution).toBe(1);
	window.dispatchEvent(new Event('sign-in-turnstile-failed'));
	await settleRequestMicrotasks();
	expect(firstOutcome.read()).toMatchObject({ kind: 'rejected' });
	expect(secondOutcome.read()).toMatchObject({ kind: 'rejected' });
	await refusals;
	await expect(runner.passkeySignInTurnstileToken()).rejects.toThrow('unavailable');
	expect(execution).toBe(1);
});
it('rejects a pending loading attempt on the failure event without waiting', async () => {
	window.signInTurnstile = 'loading';
	let outcome = 'pending';
	void runner.passkeySignInTurnstileToken().then(
		() => {
			outcome = 'resolved';
		},
		() => {
			outcome = 'rejected';
		},
	);
	window.dispatchEvent(new Event('sign-in-turnstile-failed'));
	await Promise.resolve();
	expect(outcome).toBe('rejected');
	expect(execution).toBe(0);
});

it('reports local verification refusal in the SDK error body consumed by Better Auth UI', async () => {
	window.signInTurnstile = 'failed';
	await expect(runner.attachPasskeySignInTurnstile(context())).rejects.toMatchObject({
		status: 503,
		error: {
			code: 'SIGN_IN_VERIFICATION_UNAVAILABLE',
			message: 'Sign-in verification is unavailable. Reload the page to try again.',
		},
	});
	expect(execution).toBe(0);
});
