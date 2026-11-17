import { expect, it, vi } from 'vitest';

import {
	jwksFetchObservationSchema,
	observeVerifierJwksFetch,
	retainJwksFetchStructuredLog,
} from '#sign-in-test-support/test-fixtures/jwks-fetch-observation';

it('preserves normal fetch identity and options while retaining only its closed caller and outcome', async () => {
	const response = Response.json({ keys: [] });
	const controller = new AbortController();
	const events: unknown[] = [];
	const headers = new Headers({ 'x-private-proof': 'must-not-escape' });
	const fetch = observeVerifierJwksFetch({
		caller: 'node-owner-person',
		fetch: async (input, init) => {
			expect(input).toBe('https://issuer.invalid/api/auth/jwks');
			expect(init?.signal).toBe(controller.signal);
			expect(init?.headers).toBe(headers);
			return response;
		},
		observe: (event) => events.push(event),
	});
	expect(
		await fetch('https://issuer.invalid/api/auth/jwks', {
			method: 'GET',
			redirect: 'manual',
			headers,
			signal: controller.signal,
		}),
	).toBe(response);
	expect(events).toEqual([
		{
			event: 'auth-proof-jwks-fetch-ended',
			caller: 'node-owner-person',
			ending: 'normal',
			signal: 'active',
		},
	]);
});

it.each(['AbortError', 'TimeoutError', 'private-name'])(
	'keeps the original rejection and closes the %s label without using a timer',
	async (name) => {
		const error = new DOMException('must-not-escape', name);
		const controller = new AbortController();
		controller.abort(error);
		const events: unknown[] = [];
		const fetch = observeVerifierJwksFetch({
			caller: 'native-owner-person',
			fetch: async () => {
				throw error;
			},
			observe: (event) => events.push(event),
		});
		await expect(
			fetch('https://issuer.invalid/api/auth/jwks', {
				method: 'GET',
				redirect: 'manual',
				headers: new Headers(),
				signal: controller.signal,
			}),
		).rejects.toBe(error);
		expect(events).toEqual([
			{
				event: 'auth-proof-jwks-fetch-ended',
				caller: 'native-owner-person',
				ending: name === 'private-name' ? 'other-error' : name,
				signal: name === 'private-name' ? 'other-abort' : name,
			},
		]);
		expect(jwksFetchObservationSchema.safeParse(events[0]).success).toBe(true);
	},
);

it('retains the closed Worker diagnostic while dropping arbitrary console values and extra fields', () => {
	const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
	const event = {
		event: 'auth-proof-jwks-fetch-ended',
		caller: 'gateway-management-person',
		ending: 'TimeoutError',
		signal: 'TimeoutError',
	};
	try {
		retainJwksFetchStructuredLog({ message: JSON.stringify(event) });
		retainJwksFetchStructuredLog({ message: 'must-not-escape' });
		retainJwksFetchStructuredLog({
			message: JSON.stringify({ ...event, privateValue: 'must-not-escape' }),
		});
		expect(write).toHaveBeenCalledExactlyOnceWith(`${JSON.stringify(event)}\n`);
		expect(
			jwksFetchObservationSchema.safeParse({
				...event,
				caller: 'node-owner-person',
				invocationId: '11111111-1111-7111-8111-111111111111',
			}).success,
		).toBe(true);
	} finally {
		write.mockRestore();
	}
});

it('keeps the protocol result even when a diagnostic sink throws', async () => {
	const response = Response.json({ keys: [] });
	const failure = new DOMException('controlled abort', 'AbortError');
	const normal = observeVerifierJwksFetch({
		caller: 'direct-test',
		fetch: async () => response,
		observe: () => {
			throw new Error('diagnostic sink unavailable');
		},
	});
	const refused = observeVerifierJwksFetch({
		caller: 'direct-test',
		fetch: async () => {
			throw failure;
		},
		observe: () => {
			throw new Error('diagnostic sink unavailable');
		},
	});
	expect(await normal('https://issuer.invalid/api/auth/jwks')).toBe(response);
	await expect(refused('https://issuer.invalid/api/auth/jwks')).rejects.toBe(failure);
});
