import { Buffer } from 'node:buffer';

import { describe, expect, it, vi, afterAll } from 'vitest';

import { startNodeSignInListener } from '#sign-in-host-node/sign-in-http-listener';
import type { TrustedClientAddress } from '#sign-in-host-node/trusted-client-address';

vi.useFakeTimers({ toFake: ['Date'] });
vi.setSystemTime(2_208_988_800_000);
afterAll(() => vi.useRealTimers());

const logging = { log: (): void => {}, close: async (): Promise<void> => {} };

describe('Node sign-in HTTP transport', () => {
	it('preserves request bytes, logical issuer, redirects and separate cookies over TCP', async () => {
		const opened = await startNodeSignInListener({
			hostname: '127.0.0.1',
			port: 0,
			issuer: 'https://sign-in.invalid',
			clientAddress: { kind: 'socket-peer' },
			logging,
			handle: async (request) => {
				expect(request.url).toBe('https://sign-in.invalid/api/auth/callback/google?code=canary');
				expect([...new Uint8Array(await request.arrayBuffer())]).toEqual([0, 128, 255]);
				const headers = new Headers({ location: '/owner-ready' });
				headers.append('set-cookie', 'first=value; HttpOnly');
				headers.append('set-cookie', 'second=value; HttpOnly');
				return new Response(new Uint8Array([255, 128, 0]), { status: 302, headers });
			},
		});
		if (opened.kind !== 'started') throw new Error('Listener setup failed');
		try {
			const response = await fetch(
				new URL('/api/auth/callback/google?code=canary', opened.listener.address),
				{ method: 'POST', body: Buffer.from([0, 128, 255]), redirect: 'manual' },
			);
			expect(response.status).toBe(302);
			expect(response.headers.get('location')).toBe('/owner-ready');
			expect(response.headers.getSetCookie()).toEqual([
				'first=value; HttpOnly',
				'second=value; HttpOnly',
			]);
			expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([255, 128, 0]);
		} finally {
			await opened.listener.close();
		}
	});

	it.each([
		{ policy: { kind: 'socket-peer' }, expected: '127.0.0.1' },
		{
			policy: { kind: 'trusted-proxy', peers: ['192.0.2.20'], header: 'x-forwarded-for' },
			expected: '127.0.0.1',
		},
		{
			policy: {
				kind: 'trusted-proxy',
				peers: ['127.0.0.1', '192.0.2.20'],
				header: 'x-forwarded-for',
			},
			expected: '192.0.2.10',
		},
		{
			policy: { kind: 'trusted-proxy', peers: ['127.0.0.1'], header: 'x-real-ip' },
			expected: '2001:0db8:0001:0002:0000:0000:0000:0000',
		},
	] satisfies readonly { readonly policy: TrustedClientAddress; readonly expected: string }[])(
		'sets the trusted address through the listener for $policy.kind ($expected)',
		async ({ policy, expected }) => {
			const opened = await startNodeSignInListener({
				hostname: '127.0.0.1',
				port: 0,
				issuer: 'https://sign-in.invalid',
				clientAddress: policy,
				logging,
				handle: async (request) =>
					Response.json({ address: request.headers.get('x-sign-in-client-address') }),
			});
			if (opened.kind !== 'started') throw new Error('Listener setup failed');
			try {
				const response = await fetch(opened.listener.address, {
					headers: {
						'x-sign-in-client-address': '192.0.2.99',
						'x-forwarded-for': '192.0.2.99, 192.0.2.10, 192.0.2.20',
						'x-real-ip': '2001:DB8:1:2:abcd:1234:5678:ffff',
					},
				});
				expect(response.status).toBe(200);
				expect(await response.json()).toEqual({ address: expected });
			} finally {
				await opened.listener.close();
			}
		},
	);
});
