import { createHash } from 'node:crypto';

import { calculateJwkThumbprint, compactVerify, decodeProtectedHeader, importJWK } from 'jose';
import { expect, it } from 'vitest';

import {
	createFleetAdminProofKey,
	exportFleetAdminPrivateJwk,
	fleetAdminProofKeyThumbprint,
	importFleetAdminProofKey,
	signFleetAdminProof,
} from '#sign-in-core/central-link/fleet-admin-proof';

const htu = 'https://central.example.invalid/organization-admin/v1/create-workspace';
const requestId = '019a3dce-2000-7000-8000-000000000009';

it('signs exactly central closed proof: header {typ, alg, jwk}, claims {jti, htm, htu, iat, ath, intent}', async (): Promise<void> => {
	// Arrange
	const key = await createFleetAdminProofKey(globalThis.crypto);
	const accessToken = 'header.claims.signature';
	// Act
	const proof = await signFleetAdminProof(globalThis.crypto, {
		key,
		htu,
		requestId,
		issuedAtSeconds: 2_208_988_800,
		bound: { accessToken, intent: 'intent-digest' },
	});
	// Assert: an independent JOSE library verifies it with the public key alone.
	const verified = await compactVerify(proof, await importJWK(key.publicJwk, 'ES256'));
	expect(decodeProtectedHeader(proof)).toEqual({
		typ: 'dpop+jwt',
		alg: 'ES256',
		jwk: key.publicJwk,
	});
	expect(JSON.parse(new TextDecoder().decode(verified.payload))).toEqual({
		jti: requestId,
		htm: 'POST',
		htu,
		iat: 2_208_988_800,
		ath: createHash('sha256').update(accessToken).digest('base64url'),
		intent: 'intent-digest',
	});
});

it('a token-endpoint proof carries only the standard claims', async (): Promise<void> => {
	const key = await createFleetAdminProofKey(globalThis.crypto);
	const proof = await signFleetAdminProof(globalThis.crypto, {
		key,
		htu,
		requestId,
		issuedAtSeconds: 1,
	});
	const verified = await compactVerify(proof, await importJWK(key.publicJwk, 'ES256'));
	expect(Object.keys(JSON.parse(new TextDecoder().decode(verified.payload))).toSorted()).toEqual([
		'htm',
		'htu',
		'iat',
		'jti',
	]);
});

it('the thumbprint is RFC 7638 and every key is distinct and unexportable', async (): Promise<void> => {
	const first = await createFleetAdminProofKey(globalThis.crypto);
	const second = await createFleetAdminProofKey(globalThis.crypto);
	await expect(fleetAdminProofKeyThumbprint(globalThis.crypto, first)).resolves.toBe(
		await calculateJwkThumbprint(first.publicJwk, 'sha256'),
	);
	expect(await fleetAdminProofKeyThumbprint(globalThis.crypto, first)).not.toBe(
		await fleetAdminProofKeyThumbprint(globalThis.crypto, second),
	);
	// The private half stays inside WebCrypto: it cannot be exported to be logged or stored.
	expect(first.privateKey.extractable).toBe(false);
	await expect(globalThis.crypto.subtle.exportKey('jwk', first.privateKey)).rejects.toThrow();
});

it('an extractable key round-trips through its private JWK and signs as the same key', async (): Promise<void> => {
	// Arrange
	const original = await createFleetAdminProofKey(globalThis.crypto, { extractable: true });
	// Act
	const privateJwk = await exportFleetAdminPrivateJwk(globalThis.crypto, original);
	const restored = await importFleetAdminProofKey(globalThis.crypto, privateJwk);
	const proof = await signFleetAdminProof(globalThis.crypto, {
		key: restored,
		htu,
		requestId,
		issuedAtSeconds: 1,
	});
	// Assert: the same public key verifies it, and the restored key itself is not exportable.
	await expect(
		compactVerify(proof, await importJWK(original.publicJwk, 'ES256')),
	).resolves.toBeDefined();
	expect(restored.publicJwk).toEqual(original.publicJwk);
	expect(await fleetAdminProofKeyThumbprint(globalThis.crypto, restored)).toBe(
		await fleetAdminProofKeyThumbprint(globalThis.crypto, original),
	);
	expect(restored.privateKey.extractable).toBe(false);
	expect(decodeProtectedHeader(proof).jwk).toEqual(original.publicJwk);
	expect(Object.keys(privateJwk).toSorted()).toEqual(
		expect.arrayContaining(['crv', 'd', 'kty', 'x', 'y']),
	);
});

it('an import is non-extractable by default and extractable only when asked, for the Keychain store to save it again', async (): Promise<void> => {
	const privateJwk = await exportFleetAdminPrivateJwk(
		globalThis.crypto,
		await createFleetAdminProofKey(globalThis.crypto, { extractable: true }),
	);
	const signingOnly = await importFleetAdminProofKey(globalThis.crypto, privateJwk);
	const rePersistable = await importFleetAdminProofKey(globalThis.crypto, privateJwk, {
		extractable: true,
	});
	expect(signingOnly.privateKey.extractable).toBe(false);
	expect(rePersistable.privateKey.extractable).toBe(true);
	await expect(exportFleetAdminPrivateJwk(globalThis.crypto, rePersistable)).resolves.toEqual(
		privateJwk,
	);
});
