import type { SignInCrypto } from '#sign-in-core/contracts/sign-in-platform';

/** The JSON values signed sign-in artifacts hash: no floats, so serialization is exact. */
export type CanonicalJsonValue =
	| string
	| number
	| boolean
	| null
	| readonly CanonicalJsonValue[]
	| { readonly [key: string]: CanonicalJsonValue };

/**
 * RFC 8785 (JCS) serialization for strings, safe integers, booleans, null, arrays and objects.
 * ECMAScript string and integer serialization already match JCS; object members sort by
 * UTF-16 code units, which is the default string comparison. Non-integers are refused so
 * TypeScript and Rust never disagree on a number's text.
 */
export function canonicalJson(value: CanonicalJsonValue): string {
	if (value === null || typeof value === 'boolean' || typeof value === 'string')
		return JSON.stringify(value);
	if (typeof value === 'number') {
		if (!Number.isSafeInteger(value)) throw new RangeError('Canonical JSON accepts safe integers');
		return JSON.stringify(value);
	}
	if (isCanonicalArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
	const members = Object.keys(value)
		.toSorted()
		.map((key): string => {
			const member = value[key];
			if (member === undefined) throw new TypeError(`Canonical JSON member ${key} is undefined`);
			return `${JSON.stringify(key)}:${canonicalJson(member)}`;
		});
	return `{${members.join(',')}}`;
}

/** Lowercase hex SHA-256 of the canonical bytes. */
export async function canonicalJsonSha256Hex(
	crypto: SignInCrypto,
	value: CanonicalJsonValue,
): Promise<string> {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(canonicalJson(value)),
	);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function isCanonicalArray(
	value: readonly CanonicalJsonValue[] | { readonly [key: string]: CanonicalJsonValue },
): value is readonly CanonicalJsonValue[] {
	return Array.isArray(value);
}
