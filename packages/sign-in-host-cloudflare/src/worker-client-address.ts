import {
	signInClientIpv6SubnetBits,
	trustedSignInClientAddressHeader,
} from '@agent-collaboration/sign-in-core';
import { getIPFromHeader } from '@better-auth/core/utils/ip';

/** Cloudflare supplies the edge address; caller-authored protected headers
 * never become a source. Both abuse layers receive the native /64 key. */
export function workerClientAddressHeaders(incoming: Headers): Headers {
	const headers = new Headers(incoming);
	headers.delete(trustedSignInClientAddressHeader);
	const edgeAddress = incoming.get('cf-connecting-ip');
	const normalizedAddress =
		edgeAddress === null
			? null
			: getIPFromHeader(edgeAddress, { ipv6Subnet: signInClientIpv6SubnetBits });
	if (normalizedAddress !== null) headers.set(trustedSignInClientAddressHeader, normalizedAddress);
	return headers;
}
