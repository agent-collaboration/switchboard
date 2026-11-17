import { trustedSignInClientAddressHeader } from '@agent-collaboration/sign-in-core';
import { expect, it } from 'vitest';

import { workerClientAddressHeaders } from '#sign-in-host-cloudflare/worker-client-address';

it.each([
	['2001:db8:1:2::1234', '2001:0db8:0001:0002:0000:0000:0000:0000'],
	['2001:DB8:1:2:abcd:1234:5678:ffff', '2001:0db8:0001:0002:0000:0000:0000:0000'],
	['2001:db8:1:3::1', '2001:0db8:0001:0003:0000:0000:0000:0000'],
	['::ffff:192.0.2.9', '192.0.2.9'],
	['192.0.2.9', '192.0.2.9'],
	['spoof, 192.0.2.1', null],
	['', null],
	[null, null],
] as const)('derives the abuse key from the trusted edge address %s', (edge, expected) => {
	const incoming = new Headers({ [trustedSignInClientAddressHeader]: '192.0.2.99' });
	if (edge !== null) incoming.set('cf-connecting-ip', edge);
	const admitted = workerClientAddressHeaders(incoming);
	expect(admitted.get(trustedSignInClientAddressHeader)).toBe(expected);
	expect(incoming.get(trustedSignInClientAddressHeader)).toBe('192.0.2.99');
});
