import { expect, it } from 'vitest';

import type { SignInObservation } from '#sign-in-core/contracts/sign-in-observation';
import {
	admitSignInRequest,
	providerLimitedResponse,
} from '#sign-in-core/request-limits/sign-in-request-admission';

it('publishes an outer429 with Retry-After and only closed non-address observations', async () => {
	const observations: SignInObservation[] = [];
	const result = await admitSignInRequest({
		request: new Request('https://sign-in.invalid/sign-in', {
			headers: { 'x-sign-in-client-address': '192.0.2.99' },
		}),
		platform: {
			requestLimiter: { allow: async () => ({ kind: 'limited', retryAfterSeconds: 17 }) },
			log: (observation): void => {
				observations.push(observation);
			},
		},
	});
	if (result.kind !== 'refused') throw new Error('Limited request was admitted');
	expect(result.response.status).toBe(429);
	expect(result.response.headers.get('retry-after')).toBe('17');
	expect(await result.response.json()).toEqual({ error: 'rate-limited' });
	expect(observations).toEqual([
		{ kind: 'request-limited', requestClass: 'service-page', layer: 'outer' },
	]);
});

it('fails closed when a host counter fails rather than creating a provider fallback', async () => {
	const result = await admitSignInRequest({
		request: new Request('https://sign-in.invalid/api/auth/sign-in/social'),
		platform: {
			requestLimiter: {
				allow: async () => {
					throw new Error('Controlled unavailable host counter');
				},
			},
			log: (): void => undefined,
		},
	});
	if (result.kind !== 'refused') throw new Error('Unavailable counter admitted a request');
	expect(result.response.status).toBe(503);
});

it('preserves the host-normalized IPv6 prefix for both the native provider and outer count', async () => {
	const seen: string[] = [];
	const result = await admitSignInRequest({
		request: new Request('https://sign-in.invalid/api/auth/callback/google', {
			headers: { 'x-sign-in-client-address': '2001:0db8:0001:0002:0000:0000:0000:0000' },
		}),
		platform: {
			requestLimiter: {
				allow: async (request) => {
					seen.push(request.address);
					return { kind: 'allowed' };
				},
			},
			log: (): void => undefined,
		},
	});
	if (result.kind !== 'allowed') throw new Error('Controlled counter refused a request');
	expect(seen).toEqual(['2001:0db8:0001:0002:0000:0000:0000:0000']);
	expect(result.request.headers.get('x-sign-in-client-address')).toBe(seen[0]);
});

it('keeps a native429 body while translating X-Retry-After to the standard header', async () => {
	const observations: SignInObservation[] = [];
	const result = providerLimitedResponse({
		response: Response.json(
			{ message: 'Native limit' },
			{ status: 429, headers: { 'x-retry-after': '10' } },
		),
		requestClass: 'sign-in',
		log: (observation): void => {
			observations.push(observation);
		},
	});
	expect(result.status).toBe(429);
	expect(result.headers.get('retry-after')).toBe('10');
	expect(await result.json()).toEqual({ message: 'Native limit' });
	expect(observations).toEqual([
		{ kind: 'request-limited', requestClass: 'sign-in', layer: 'provider' },
	]);
});
