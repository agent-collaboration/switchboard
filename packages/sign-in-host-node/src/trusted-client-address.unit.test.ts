import { describe, expect, it } from 'vitest';

import { readTrustedClientAddress } from '#sign-in-host-node/trusted-client-address';

describe('trusted client address', () => {
	it('uses the socket peer when incoming headers claim another address', () => {
		expect(
			readTrustedClientAddress({
				peerAddress: '127.0.0.1',
				headers: { 'x-forwarded-for': '192.0.2.9', 'x-sign-in-client-address': '192.0.2.10' },
				policy: { kind: 'socket-peer' },
			}),
		).toEqual({ kind: 'available', address: '127.0.0.1' });
	});
	it('accepts a single address only from the configured proxy peer', () => {
		const policy = {
			kind: 'trusted-proxy',
			peers: ['127.0.0.1'],
			header: 'x-real-ip',
		} satisfies import('#sign-in-host-node/trusted-client-address').TrustedClientAddress;
		expect(
			readTrustedClientAddress({
				peerAddress: '127.0.0.1',
				headers: { 'x-real-ip': '2001:db8::1' },
				policy,
			}),
		).toEqual({ kind: 'available', address: '2001:db8::1' });
		expect(
			readTrustedClientAddress({
				peerAddress: '192.0.2.1',
				headers: { 'x-real-ip': '2001:db8::1' },
				policy,
			}),
		).toEqual({ kind: 'available', address: '192.0.2.1' });
		for (const forwarded of [undefined, 'invalid', ['192.0.2.1', '192.0.2.2']])
			expect(
				readTrustedClientAddress({
					peerAddress: '127.0.0.1',
					headers: { 'x-real-ip': forwarded },
					policy,
				}),
			).toEqual({ kind: 'unavailable' });
	});
});
