// @vitest-environment jsdom
import { createContext, Script } from 'node:vm';

import { beforeEach, expect, it, vi } from 'vitest';

import { ownerPageScript } from '#sign-in-core/better-auth/owner-page-script';

beforeEach(() => {
	document.body.innerHTML =
		'<form id="owner-sign-in"></form><p id="status"></p><div id="sign-in-captcha" data-sitekey="test-only" data-action="sign_in_social"></div><script id="sign-in-turnstile-script"></script>';
	const context = createContext({
		window,
		document,
		Event,
		JSON,
		Error,
		location: { assign: vi.fn() },
	});
	const scripts = ownerPageScript({
		ready: false,
		callback: 'https://sign-in.invalid/owner-ready',
		resume: null,
	});
	for (const body of scripts.matchAll(/<script>([\s\S]*?)<\/script>/gu))
		new Script(body[1] ?? '').runInContext(context);
});
it('publishes ready before notifying the island queue', () => {
	let observed: string | undefined;
	window.addEventListener(
		'sign-in-turnstile-ready',
		() => {
			observed = window.signInTurnstile;
		},
		{ once: true },
	);
	window.turnstile = {
		render: () => 'social-widget',
		reset: () => undefined,
		execute: () => undefined,
	};
	const ready: unknown = Reflect.get(window, 'onSignInTurnstileReady');
	if (typeof ready !== 'function') throw new Error('Ready callback missing');
	ready();
	expect(window.signInTurnstile).toBe('ready');
	expect(observed).toBe('ready');
});
it('captures a resource load error, publishes failure and notifies the queue', () => {
	let observed: string | undefined;
	window.addEventListener(
		'sign-in-turnstile-failed',
		() => {
			observed = window.signInTurnstile;
		},
		{ once: true },
	);
	document.getElementById('sign-in-turnstile-script')?.dispatchEvent(new Event('error'));
	expect(window.signInTurnstile).toBe('failed');
	expect(observed).toBe('failed');
	expect(document.getElementById('status')?.textContent).toBe(
		'Sign-in verification is unavailable.',
	);
});
