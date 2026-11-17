import { epochMillisecondsSchema } from '@agent-collaboration/sign-in-core';
import { expect, it, vi } from 'vitest';

import { createControlledServicePageBinding } from '#sign-in-test-support/test-fixtures/auth-proof-rate-limit-bindings';

it('refuses request 301 in the controlled window and accepts a different address', async () => {
	const actualBinding = { limit: vi.fn(async () => ({ success: true })) };
	const binding = createControlledServicePageBinding({
		actualBinding,
		clock: { now: () => epochMillisecondsSchema.parse(10_000) },
	});
	const key = 'service-page:192.0.2.1';
	const allowed = await Promise.all(Array.from({ length: 300 }, () => binding.limit({ key })));

	expect(allowed).toEqual(Array.from({ length: 300 }, () => ({ success: true })));
	expect(await binding.limit({ key })).toEqual({ success: false });
	expect(await binding.limit({ key: 'service-page:192.0.2.2' })).toEqual({ success: true });
	expect(actualBinding.limit).not.toHaveBeenCalled();
});

it('keeps an exhausted window until its injected expiry and resets at equality', async () => {
	let milliseconds = 10_000;
	const binding = createControlledServicePageBinding({
		actualBinding: { limit: async () => ({ success: true }) },
		clock: { now: () => epochMillisecondsSchema.parse(milliseconds) },
	});
	const key = 'service-page:192.0.2.1';
	await Promise.all(Array.from({ length: 300 }, () => binding.limit({ key })));

	milliseconds = 69_999;
	expect(await binding.limit({ key })).toEqual({ success: false });
	milliseconds = 70_000;
	expect(await binding.limit({ key })).toEqual({ success: true });
});

it('leaves other request classes on the supplied real binding with the same key', async () => {
	const actualBinding = { limit: vi.fn(async () => ({ success: false })) };
	const binding = createControlledServicePageBinding({
		actualBinding,
		clock: { now: () => epochMillisecondsSchema.parse(10_000) },
	});
	const options = { key: 'other:192.0.2.1' };

	expect(await binding.limit(options)).toEqual({ success: false });
	expect(actualBinding.limit).toHaveBeenCalledExactlyOnceWith(options);
});
