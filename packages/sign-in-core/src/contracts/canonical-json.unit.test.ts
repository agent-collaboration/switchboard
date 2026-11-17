import { createHash } from 'node:crypto';

import { expect, it } from 'vitest';

import { canonicalJson, canonicalJsonSha256Hex } from '#sign-in-core/contracts/canonical-json';
import type { SignInCrypto } from '#sign-in-core/contracts/sign-in-platform';

it('sorts members by UTF-16 code units at every depth and leaves array order alone', (): void => {
	// RFC 8785 section 3.2.3: members sort by UTF-16 code units, recursively.
	expect(canonicalJson({ b: [3, 1, { z: true, a: null }], a: 'x', A: 1, '€': 0, '😀': 0 })).toBe(
		'{"A":1,"a":"x","b":[3,1,{"a":null,"z":true}],"€":0,"😀":0}',
	);
});

it('escapes strings exactly as RFC 8785 requires', (): void => {
	// RFC 8785 section 3.2.2.2: only \b \t \n \f \r, quote, backslash and other controls are escaped.
	expect(canonicalJson('\u0008\t\n\f\r"\\\u001f€/')).toBe('"\\b\\t\\n\\f\\r\\"\\\\\\u001f€/"');
});

it('refuses numbers whose text TypeScript and Rust could disagree on', (): void => {
	expect(() => canonicalJson(1.5)).toThrow(RangeError);
	expect(() => canonicalJson(2 ** 53)).toThrow(RangeError);
	expect(canonicalJson(-9_007_199_254_740_991)).toBe('-9007199254740991');
});

it('hashes the canonical UTF-8 bytes', async (): Promise<void> => {
	// SHA-256("{}") is a published constant.
	await expect(canonicalJsonSha256Hex(globalThis.crypto, {})).resolves.toBe(
		'44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
	);
});

it('the canonical-JSON digest goes through the host crypto, digesting exactly the canonical text (V2)', async () => {
	// Arrange: a host crypto that records what it is asked to digest.
	const digested: string[] = [];
	const recordingCrypto: SignInCrypto = {
		getRandomValues: (bytes) => globalThis.crypto.getRandomValues(bytes),
		subtle: {
			digest: async (algorithm, data) => {
				digested.push(`${algorithm}:${new TextDecoder().decode(data)}`);
				return globalThis.crypto.subtle.digest(algorithm, data);
			},
			generateKey: async (algorithm, extractable, usages) =>
				globalThis.crypto.subtle.generateKey(algorithm, extractable, usages),
			exportKey: async (format, key) => globalThis.crypto.subtle.exportKey(format, key),
			importKey: async (format, keyData, algorithm, extractable, usages) =>
				globalThis.crypto.subtle.importKey(format, keyData, algorithm, extractable, usages),
			sign: async (algorithm, key, data) => globalThis.crypto.subtle.sign(algorithm, key, data),
		},
	};
	// Act
	const digest = await canonicalJsonSha256Hex(recordingCrypto, { b: 1, a: [true, null] });
	// Assert
	expect(digested).toEqual(['SHA-256:{"a":[true,null],"b":1}']);
	expect(digest).toBe(createHash('sha256').update('{"a":[true,null],"b":1}').digest('hex'));
});
