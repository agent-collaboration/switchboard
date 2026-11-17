import { expect, it } from 'vitest';

import {
	createGatewayProofJwksFetch,
	type GatewayProofJwksContext,
} from '#worker-host/test-fixtures/gateway-proof-jwks-fetch';

const jwksUrl = 'https://issuer.invalid/api/auth/jwks';

it('delegates the global fetch as an unbound function rather than changing its receiver', async () => {
	const response = Response.json({ keys: [] });
	const proofFetch = createGatewayProofJwksFetch({
		context: () => ({ caller: 'gateway-management-person', jwksUrl }),
		fetch: async function (this: unknown): Promise<Response> {
			if (this !== undefined) throw new TypeError('Illegal invocation');
			return response;
		},
		observe: () => {},
	});
	expect(await proofFetch(jwksUrl)).toBe(response);
});

it('finishes the proof HTTP request even when JOSE supplied an already-expired clock deadline', async () => {
	const deadline = new AbortController();
	deadline.abort(new DOMException('controlled old deadline', 'TimeoutError'));
	const response = Response.json({ keys: [] });
	const headers = new Headers({ accept: 'application/jwk-set+json' });
	const events: unknown[] = [];
	const fetch = createGatewayProofJwksFetch({
		context: () => ({
			caller: 'gateway-management-person',
			jwksUrl,
		}),
		fetch: async (input, init) => {
			expect(input).toBe(jwksUrl);
			expect(init?.headers).toBe(headers);
			expect(init?.method).toBe('GET');
			expect(init?.redirect).toBe('manual');
			expect(init).not.toHaveProperty('signal');
			return response;
		},
		observe: (event) => events.push(event),
	});
	expect(
		await fetch(jwksUrl, {
			method: 'GET',
			redirect: 'manual',
			headers,
			signal: deadline.signal,
		}),
	).toBe(response);
	expect(events).toEqual([
		{
			event: 'auth-proof-jwks-fetch-ended',
			caller: 'gateway-management-person',
			ending: 'normal',
			signal: 'absent',
			signalSource: 'fixture-no-signal',
		},
	]);
});

it('preserves a native fetch rejection without inventing request cancellation', async () => {
	const reason = new DOMException('native fetch ended', 'AbortError');
	const events: unknown[] = [];
	const fetch = createGatewayProofJwksFetch({
		context: () => ({ caller: 'gateway-workspace-agent', jwksUrl }),
		fetch: async (_input, init) => {
			expect(init).not.toHaveProperty('signal');
			throw reason;
		},
		observe: (event) => events.push(event),
	});
	await expect(fetch(jwksUrl, { signal: new AbortController().signal })).rejects.toBe(reason);
	expect(events).toEqual([
		{
			event: 'auth-proof-jwks-fetch-ended',
			caller: 'gateway-workspace-agent',
			ending: 'AbortError',
			signal: 'absent',
			signalSource: 'fixture-no-signal',
		},
	]);
});

it('passes non-JWKS and out-of-context requests through with their exact original options', async () => {
	const invocationScope: { current: GatewayProofJwksContext | undefined } = { current: undefined };
	const options = {
		method: 'POST',
		body: 'opaque fixture body',
		signal: new AbortController().signal,
	};
	const response = new Response('unchanged');
	let calls = 0;
	const fetch = createGatewayProofJwksFetch({
		context: () => invocationScope.current,
		fetch: async (_input, init) => {
			expect(init).toBe(options);
			calls += 1;
			return response;
		},
		observe: () => {
			throw new Error('A pass-through request must not be observed');
		},
	});
	expect(await fetch(jwksUrl, options)).toBe(response);
	invocationScope.current = {
		caller: 'gateway-management-person',
		jwksUrl,
	};
	expect(await fetch(jwksUrl, options)).toBe(response);
	expect(await fetch('https://foreign.invalid/api/auth/jwks', options)).toBe(response);
	expect(await fetch('https://issuer.invalid/other', options)).toBe(response);
	expect(calls).toBe(4);
});
