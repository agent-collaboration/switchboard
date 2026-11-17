import { afterEach, expect, it, vi } from 'vitest';

const { recordPhase, enableClock } = vi.hoisted(() => ({
	recordPhase: vi.fn(async (): Promise<void> => {}),
	enableClock: vi.fn(),
}));
vi.mock('node:test', () => ({ mock: { timers: { enable: enableClock } } }));
vi.mock('#sign-in-test-support/test-fixtures/native-owner-cli-profile', () => ({
	readNativeOwnerCliProfile: async (): Promise<undefined> => undefined,
}));
vi.mock('#sign-in-test-support/test-fixtures/auth-proof-phase-recording', () => ({
	recordAuthProofPhase: recordPhase,
}));

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	vi.resetModules();
});

it('native JWKS preload omits an already-expired JOSE signal without changing the HTTP result', async () => {
	const deadline = new AbortController();
	deadline.abort(new DOMException('controlled expired proof deadline', 'TimeoutError'));
	const headers = new Headers({ accept: 'application/jwk-set+json' });
	const response = Response.json({ keys: [] });
	const networkFetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
		init?.signal?.throwIfAborted();
		expect(input).toBe('https://issuer.invalid/api/auth/jwks');
		expect(init?.method).toBe('GET');
		expect(init?.redirect).toBe('manual');
		expect(init?.headers).toBe(headers);
		expect(init).not.toHaveProperty('signal');
		return response;
	});
	vi.stubGlobal('fetch', networkFetch);
	await import('#sign-in-test-support/test-fixtures/controlled-native-cli-clock');
	await expect(
		globalThis.fetch('https://issuer.invalid/api/auth/jwks', {
			method: 'GET',
			redirect: 'manual',
			headers,
			signal: deadline.signal,
		}),
	).resolves.toBe(response);
	expect(networkFetch).toHaveBeenCalledTimes(1);
	expect(recordPhase).toHaveBeenCalledWith({
		kind: 'jwks-fetch-ended',
		event: 'auth-proof-jwks-fetch-ended',
		caller: 'native-owner-person',
		ending: 'normal',
		signal: 'absent',
		signalSource: 'fixture-no-signal',
	});
});
