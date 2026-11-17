import { epochMillisecondsSchema, requestLimitAddressKey } from '@agent-collaboration/sign-in-core';
import { expect, it } from 'vitest';

import { createFixedWindowRequestLimiter } from '#sign-in-host-node/fixed-window-request-limiter';

it('admits exactly ten concurrent class/address attempts and refuses the eleventh before any effect', async () => {
	const limiter = createFixedWindowRequestLimiter({ now: () => epochMillisecondsSchema.parse(0) });
	const request = {
		requestClass: 'sign-in',
		address: requestLimitAddressKey('192.0.2.1'),
	} as const;
	const attempts = await Promise.all(Array.from({ length: 11 }, () => limiter.allow(request)));
	expect(attempts.filter((result) => result.kind === 'allowed')).toHaveLength(10);
	expect(attempts.filter((result) => result.kind === 'limited')).toEqual([
		{ kind: 'limited', retryAfterSeconds: 60 },
	]);
	expect(await limiter.allow({ ...request, address: requestLimitAddressKey('192.0.2.2') })).toEqual(
		{ kind: 'allowed' },
	);
	expect(await limiter.allow({ ...request, requestClass: 'callback-passkey' })).toEqual({
		kind: 'allowed',
	});
});

it('keeps the window fixed, reports its remaining seconds, and reopens exactly at expiry on the injected clock', async () => {
	let now = 0;
	const limiter = createFixedWindowRequestLimiter({
		now: () => epochMillisecondsSchema.parse(now),
	});
	const request = {
		requestClass: 'second-factor-code',
		address: requestLimitAddressKey('192.0.2.3'),
	} as const;
	await Promise.all(Array.from({ length: 10 }, () => limiter.allow(request)));
	now = 59_999;
	expect(await limiter.allow(request)).toEqual({ kind: 'limited', retryAfterSeconds: 1 });
	now = 60_000;
	expect(await limiter.allow(request)).toEqual({ kind: 'allowed' });
});

it('counts all service pages on one address and keeps their budget separate from sign-in attempts', async () => {
	const limiter = createFixedWindowRequestLimiter({ now: () => epochMillisecondsSchema.parse(0) });
	const request = {
		requestClass: 'service-page',
		address: requestLimitAddressKey('2001:0db8:0000:0000:0000:0000:0000:0000'),
	} as const;
	const attempts = await Promise.all(Array.from({ length: 301 }, () => limiter.allow(request)));
	expect(attempts.filter((result) => result.kind === 'allowed')).toHaveLength(300);
	expect(attempts[300]).toEqual({ kind: 'limited', retryAfterSeconds: 60 });
	expect(
		await limiter.allow({
			requestClass: 'sign-in',
			address: request.address,
		}),
	).toEqual({ kind: 'allowed' });
});
