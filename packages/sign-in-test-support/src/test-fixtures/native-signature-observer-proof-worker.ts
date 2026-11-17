import { SignJWT, jwtVerify } from 'jose';

import {
	requireSignedAgentProjection,
	withNativeSigningObservation,
} from '#sign-in-test-support/test-fixtures/native-signature-observer';

export default {
	async fetch(request: Request): Promise<Response> {
		let stage = 'request';
		try {
			const label = new URL(request.url).searchParams.get('client');
			if (label !== 'one' && label !== 'two')
				return new Response('Unknown proof invocation', { status: 400 });
			const claims = {
				iss: 'https://crypto-proof.invalid',
				aud: 'native-forwarding',
				client_id: label,
				organization_id: 'organization-' + label,
				workspace_id: 'workspace-' + label,
			};
			stage = 'generate-key';
			const keys = await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
			function signToken(): Promise<string> {
				return new SignJWT(claims)
					.setProtectedHeader({ alg: 'EdDSA', typ: 'at+jwt' })
					.sign(keys.privateKey);
			}
			stage = 'unarmed-sign';
			const withoutScope = await signToken();
			let unarmedNotRecorded = false;
			try {
				requireSignedAgentProjection(label);
			} catch {
				unarmedNotRecorded = true;
			}
			return await withNativeSigningObservation(label, async () => {
				// Both independent HTTP invocations remain live across native signing and
				// the explicit event barrier. Neither scope can publish the other's claims.
				stage = 'armed-sign';
				const withScope = await signToken();
				stage = 'overlap-barrier';
				// Barrier state lives in Node. This invocation owns its outbound fetch
				// promise and I/O context, as in the real production-race harness.
				const barrier = await fetch('https://crypto-control.invalid/arrive?client=' + label);
				if (barrier.status !== 204) throw new Error('Native proof barrier rejected the request');
				stage = 'verify';
				const [unarmed, armed] = await Promise.all([
					jwtVerify(withoutScope, keys.publicKey, { issuer: claims.iss, audience: claims.aud }),
					jwtVerify(withScope, keys.publicKey, { issuer: claims.iss, audience: claims.aud }),
				]);
				stage = 'read-projection';
				const projection = requireSignedAgentProjection(label);
				stage = 'response';
				return Response.json({
					unarmedNotRecorded,
					byteIdentical: withScope === withoutScope,
					verified: unarmed.payload.client_id === label && armed.payload.client_id === label,
					projection,
				});
			});
		} catch (error) {
			return Response.json(
				{
					proofFailure: {
						stage,
						name: error instanceof Error ? error.name : 'unknown',
						message: error instanceof Error ? error.message.slice(0, 240) : 'Unknown proof failure',
					},
				},
				{ status: 500 },
			);
		}
	},
};
