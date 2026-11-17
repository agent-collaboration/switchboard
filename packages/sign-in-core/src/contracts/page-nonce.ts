import { z } from 'zod';

import type { SignInCrypto } from '#sign-in-core/contracts/sign-in-platform';

/** One served page's script nonce: 16 random bytes as 32 lowercase hex characters. */
export const pageNonceSchema = z
	.string()
	.regex(/^[0-9a-f]{32}$/u)
	.brand<'PageNonce'>();
export type PageNonce = z.infer<typeof pageNonceSchema>;

/**
 * The nonce for one rendered page, from the host's randomness (S1): exactly the bytes the
 * capability returns. Only a response that renders HTML mints one.
 */
export function mintPageNonce(crypto: SignInCrypto): PageNonce {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	return pageNonceSchema.parse(
		Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(''),
	);
}
