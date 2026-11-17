import { requestLimitAddressKey } from '@agent-collaboration/sign-in-core';
import { expect, it } from 'vitest';

import { createBindingRequestLimiter } from '#sign-in-host-cloudflare/binding-request-limiter';

it('uses the attempts binding for factor codes and the auth binding for service pages, with class/address keys', async () => {
	const calls: { readonly binding: string; readonly key: string }[] = [];
	const limiter = createBindingRequestLimiter({
		signInAttempts: {
			limit: async ({ key }) => {
				calls.push({ binding: 'attempts', key });
				return { success: false };
			},
		},
		authRequests: {
			limit: async ({ key }) => {
				calls.push({ binding: 'auth', key });
				return { success: true };
			},
		},
	});
	const address = requestLimitAddressKey('192.0.2.1');
	expect(await limiter.allow({ requestClass: 'second-factor-code', address })).toEqual({
		kind: 'limited',
		retryAfterSeconds: 60,
	});
	expect(await limiter.allow({ requestClass: 'service-page', address })).toEqual({
		kind: 'allowed',
	});
	expect(calls).toEqual([
		{ binding: 'attempts', key: 'second-factor-code:192.0.2.1' },
		{ binding: 'auth', key: 'service-page:192.0.2.1' },
	]);
});

it.each(['throw', 'malformed'] as const)(
	'refuses to invent an allowance when the binding is %s',
	async (failure) => {
		const binding = {
			limit: async (): Promise<unknown> => {
				if (failure === 'throw') throw new Error('Controlled binding failure');
				return { success: 'yes' };
			},
		};
		const limiter = createBindingRequestLimiter({ signInAttempts: binding, authRequests: binding });
		expect(
			await limiter.allow({ requestClass: 'sign-in', address: requestLimitAddressKey(null) }),
		).toEqual({ kind: 'unavailable' });
	},
);
