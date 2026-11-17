import { uuid7Schema } from '@agent-collaboration/sign-in-core';
import { expect, it } from 'vitest';

import { createProofBrowserAddresses } from '#sign-in-test-support/test-fixtures/proof-browser-addresses';

it('keeps a browser address stable and resolves its old session cookie after another browser is selected', () => {
	let sequence = 0;
	const addresses = createProofBrowserAddresses({
		nextId: () => {
			sequence += 1;
			return uuid7Schema.parse(`11111111-1111-7111-8111-${sequence.toString().padStart(12, '0')}`);
		},
	});
	addresses.useBrowser('first-browser');
	const first = addresses.current();
	expect(addresses.forCookie(undefined)).toBe(first);
	addresses.rememberResponse(
		new Headers({ 'set-cookie': 'better-auth.session_token=fixture-first.signature; HttpOnly' }),
		first,
	);
	addresses.useBrowser('second-browser');
	expect(addresses.current()).not.toBe(first);
	expect(addresses.forCookie('better-auth.session_token=fixture-first.signature')).toBe(first);
	const secondTransport = addresses.transportFor('second-browser');
	expect(addresses.transportFor('second-browser')).toBe(secondTransport);
	expect(
		addresses.forCookie('better-auth.session_token=fixture-first.signature', secondTransport),
	).toBe(addresses.current());
	addresses.useBrowser('first-browser');
	expect(addresses.current()).toBe(first);
	expect(addresses.forCookie(undefined)).toBe(first);
});
