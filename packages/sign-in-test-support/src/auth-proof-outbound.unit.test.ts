import { expect, it, vi } from 'vitest';

import { fetchAuthProofOutbound } from '#sign-in-test-support/test-fixtures/auth-proof-outbound';

it('carries cancellation from the incoming proof request into native HTTP without a timer', async () => {
	const controller = new AbortController();
	const request = new Request('https://issuer.invalid/api/auth/jwks', {
		signal: controller.signal,
	});
	const aborted = Promise.withResolvers<unknown>();
	let forwardedSignal: AbortSignal | null | undefined;
	const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
		forwardedSignal = init?.signal;
		forwardedSignal?.addEventListener('abort', () => aborted.resolve(forwardedSignal?.reason), {
			once: true,
		});
		return Response.json({ keys: [] });
	});
	try {
		expect((await fetchAuthProofOutbound(request)).status).toBe(200);
		expect(forwardedSignal).toBe(request.signal);
		const reason = new DOMException('controlled proof abort', 'TimeoutError');
		controller.abort(reason);
		expect(await aborted.promise).toBe(reason);
	} finally {
		fetch.mockRestore();
	}
});
