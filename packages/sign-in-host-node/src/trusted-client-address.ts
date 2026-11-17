import type { IncomingHttpHeaders } from 'node:http';
import { isIP } from 'node:net';

import { z } from 'zod';

const ipAddressSchema = z.string().refine((value) => isIP(value) !== 0, 'Expected an IP address');
export const trustedClientAddressSchema = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('socket-peer') }),
	z.strictObject({
		kind: z.literal('trusted-proxy'),
		peers: z.array(ipAddressSchema).min(1),
		header: z
			.string()
			.regex(/^[a-z0-9-]+$/u)
			.refine((value) => value !== 'x-sign-in-client-address'),
	}),
]);
export type TrustedClientAddress = z.infer<typeof trustedClientAddressSchema>;

export type ClientAddressResult =
	| { readonly kind: 'available'; readonly address: string }
	| { readonly kind: 'unavailable' };

export function readTrustedClientAddress(props: {
	readonly peerAddress: string | undefined;
	readonly headers: IncomingHttpHeaders;
	readonly policy: TrustedClientAddress;
}): ClientAddressResult {
	const peerAddress = props.peerAddress;
	if (peerAddress === undefined || isIP(peerAddress) === 0) return { kind: 'unavailable' };
	if (props.policy.kind === 'socket-peer' || !props.policy.peers.includes(peerAddress))
		return { kind: 'available', address: peerAddress };
	const forwarded = props.headers[props.policy.header];
	if (typeof forwarded !== 'string') return { kind: 'unavailable' };
	const hops = forwarded.split(',').map((value) => value.trim());
	if (hops.some((value) => isIP(value) === 0)) return { kind: 'unavailable' };
	let address = peerAddress;
	for (const hop of hops.toReversed()) {
		if (!props.policy.peers.includes(address)) break;
		address = hop;
	}
	return { kind: 'available', address };
}
