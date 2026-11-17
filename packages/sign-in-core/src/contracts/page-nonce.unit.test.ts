import { expect, it } from 'vitest';

import { mintPageNonce } from '#sign-in-core/contracts/page-nonce';
import type { SignInCrypto } from '#sign-in-core/contracts/sign-in-platform';

/** A crypto whose randomness is the given bytes, counting each draw and its length. */
function knownBytesCrypto(next: () => Uint8Array<ArrayBuffer>): {
	readonly crypto: SignInCrypto;
	readonly draws: number[];
} {
	const draws: number[] = [];
	return {
		draws,
		crypto: {
			getRandomValues: (bytes) => {
				draws.push(bytes.byteLength);
				return next();
			},
			subtle: globalThis.crypto.subtle,
		},
	};
}

it('the nonce is the host bytes 00…0f as 32 lowercase hex, from one 16-byte draw', (): void => {
	// Arrange
	const host = knownBytesCrypto(() => Uint8Array.from({ length: 16 }, (_, index) => index));
	// Act
	const nonce = mintPageNonce(host.crypto);
	// Assert
	expect(nonce).toBe('000102030405060708090a0b0c0d0e0f');
	expect(host.draws).toEqual([16]);
});

it('the nonce is exactly the bytes the capability returned, high bytes included', (): void => {
	// Arrange: the host returns its own array, not the one it was handed.
	const host = knownBytesCrypto(() => new Uint8Array(16).fill(0xab));
	// Act
	const nonce = mintPageNonce(host.crypto);
	// Assert
	expect(nonce).toBe('ab'.repeat(16));
});

it('a host that returns the wrong number of bytes cannot make a nonce', (): void => {
	const host = knownBytesCrypto(() => new Uint8Array(15));
	expect(() => mintPageNonce(host.crypto)).toThrow();
});
