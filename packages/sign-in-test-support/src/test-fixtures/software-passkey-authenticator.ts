import { createHash, generateKeyPair, randomBytes, sign, type KeyObject } from 'node:crypto';

import { encodeCBOR, type CBORType } from '@levischuck/tiny-cbor';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { z } from 'zod';

export interface SoftwarePasskeyChallenge {
	readonly challenge: string;
	readonly rpId: string;
	readonly origin: string;
	readonly userVerified?: boolean;
}
export interface SoftwarePasskeyAuthenticator {
	readonly credentialId: string;
	readonly storedPublicKey: string;
	readonly registrationResponse: (props: SoftwarePasskeyChallenge) => RegistrationResponseJSON;
	readonly authenticationResponse: (props: SoftwarePasskeyChallenge) => AuthenticationResponseJSON;
}

function counterBytes(counter: number): Buffer {
	const bytes = Buffer.alloc(4);
	bytes.writeUInt32BE(counter);
	return bytes;
}
function clientData(
	props: SoftwarePasskeyChallenge,
	type: 'webauthn.create' | 'webauthn.get',
): Buffer {
	return Buffer.from(
		JSON.stringify({ type, challenge: props.challenge, origin: props.origin, crossOrigin: false }),
	);
}

/** Controlled external authenticator with a real EC private key and DER ES256
 * signatures. It claims no physical hardware, biometric check or attestation.
 * The application's real verifier receives the full standard wire response. */
export async function createSoftwarePasskeyAuthenticator(
	props: { readonly backupState?: 'device-bound' | 'synced' } = {},
): Promise<SoftwarePasskeyAuthenticator> {
	const keyPair = await new Promise<{
		readonly publicKey: KeyObject;
		readonly privateKey: KeyObject;
	}>((resolve, reject) => {
		generateKeyPair('ec', { namedCurve: 'prime256v1' }, (error, publicKey, privateKey) => {
			if (error !== null) reject(error);
			else resolve({ publicKey, privateKey });
		});
	});
	const publicJwk = z
		.record(z.string(), z.unknown())
		.parse(keyPair.publicKey.export({ format: 'jwk' }));
	const xCoordinate = z.string().min(1).parse(publicJwk.x);
	const yCoordinate = z.string().min(1).parse(publicJwk.y);
	const coseKey = encodeCBOR(
		new Map<string | number, CBORType>([
			[1, 2],
			[3, -7],
			[-1, 1],
			[-2, Buffer.from(xCoordinate, 'base64url')],
			[-3, Buffer.from(yCoordinate, 'base64url')],
		]),
	);
	const credentialBytes = randomBytes(32);
	const credentialId = credentialBytes.toString('base64url');
	const backupFlags = props.backupState === 'synced' ? 0x18 : 0;
	let counter = 0;
	function authenticatorData(challenge: SoftwarePasskeyChallenge): Buffer {
		return Buffer.concat([
			createHash('sha256').update(challenge.rpId).digest(),
			Buffer.from([0x01 | ((challenge.userVerified ?? true) ? 0x04 : 0) | backupFlags]),
			counterBytes(counter),
		]);
	}
	return {
		credentialId,
		storedPublicKey: Buffer.from(coseKey).toString('base64'),
		registrationResponse(challenge): RegistrationResponseJSON {
			const baseData = authenticatorData(challenge);
			// AT says the registration carries AAGUID, credential ID and COSE public key.
			baseData[32] = (baseData[32] ?? 0) | 0x40;
			const credentialLength = Buffer.alloc(2);
			credentialLength.writeUInt16BE(credentialBytes.length);
			const authData = Buffer.concat([
				baseData,
				Buffer.alloc(16),
				credentialLength,
				credentialBytes,
				coseKey,
			]);
			const attestation = encodeCBOR(
				new Map<string | number, CBORType>([
					['fmt', 'none'],
					['attStmt', new Map<string | number, CBORType>()],
					['authData', authData],
				]),
			);
			return {
				id: credentialId,
				rawId: credentialId,
				type: 'public-key',
				response: {
					clientDataJSON: clientData(challenge, 'webauthn.create').toString('base64url'),
					attestationObject: Buffer.from(attestation).toString('base64url'),
					transports: ['usb'],
				},
				clientExtensionResults: {},
				authenticatorAttachment: 'cross-platform',
			};
		},
		authenticationResponse(challenge): AuthenticationResponseJSON {
			counter += 1;
			const authData = authenticatorData(challenge);
			const data = clientData(challenge, 'webauthn.get');
			const signedBytes = Buffer.concat([authData, createHash('sha256').update(data).digest()]);
			const signature = sign('sha256', signedBytes, {
				key: keyPair.privateKey,
				dsaEncoding: 'der',
			});
			return {
				id: credentialId,
				rawId: credentialId,
				type: 'public-key',
				response: {
					clientDataJSON: data.toString('base64url'),
					authenticatorData: authData.toString('base64url'),
					signature: signature.toString('base64url'),
				},
				clientExtensionResults: {},
				authenticatorAttachment: 'cross-platform',
			};
		},
	};
}
