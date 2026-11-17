import { afterEach, expect, it, vi } from 'vitest';

import { createObservedProofJwks } from '#sign-in-test-support/test-fixtures/jwks-fetch-observation';

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

it('direct JWKS helper completes real JOSE reload with a controlled expired deadline signal omitted', async () => {
	const deadline = new AbortController();
	deadline.abort(new DOMException('controlled expired proof deadline', 'TimeoutError'));
	vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
	const diagnostic = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
	const networkFetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
		init?.signal?.throwIfAborted();
		expect(input).toBe('https://issuer.invalid/api/auth/jwks');
		expect(init?.method).toBe('GET');
		expect(init?.redirect).toBe('manual');
		expect(init?.headers).toBeInstanceOf(Headers);
		expect(init).not.toHaveProperty('signal');
		return Response.json({ keys: [] });
	});
	vi.stubGlobal('fetch', networkFetch);
	await expect(
		createObservedProofJwks(new URL('https://issuer.invalid/api/auth/jwks')).reload(),
	).resolves.toBeUndefined();
	expect(networkFetch).toHaveBeenCalledTimes(1);
	expect(diagnostic).toHaveBeenCalledExactlyOnceWith(
		`${JSON.stringify({
			event: 'auth-proof-jwks-fetch-ended',
			caller: 'direct-test',
			ending: 'normal',
			signal: 'absent',
			signalSource: 'fixture-no-signal',
		})}\n`,
	);
});
