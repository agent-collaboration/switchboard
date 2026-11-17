import { createHash } from 'node:crypto';

import { calculateJwkThumbprint, decodeJwt, decodeProtectedHeader } from 'jose';
import { expect, it } from 'vitest';
import { z } from 'zod';

import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import {
	controlledSignInClock,
	controlledSignInIds,
} from '#sign-in-test-support/test-fixtures/controlled-sign-in-clock';
import { startLocalAuthHarness } from '#sign-in-test-support/test-fixtures/local-auth-harness';
import { ensureLocalOwnerOrganization } from '#sign-in-test-support/test-fixtures/local-owner-organization';
import { signInConfirmedPeopleBrowser } from '#sign-in-test-support/test-fixtures/people-browser-login';
import type { SignInCapabilityRecord } from '#sign-in-test-support/test-fixtures/recording-sign-in-capabilities';

// R30 / U23 (V2), the admin-forwarding rows. Run with SIGN_IN_TEST_HOST=node: the harness runs the
// Node sign-in host in this process and records its crypto, clock, IDs and central calls. The
// forwarding drives the real self-call (Better Auth's PKCE) and the controlled central admin.
useControlledSignInClock();

/**
 * U23's pinned process clock: the harness pins the process clock (which Better Auth reads) to the
 * controlled time, and the recorded core clock runs this far behind it. Central accepts a proof
 * time up to 65 s old, so the forwarding still succeeds, and a proof time taken from the process
 * clock instead of the capability would be 30 s off.
 */
const coreClockOffsetMilliseconds = -30_000;

/** Known bytes 00, 01, 02, …: the PKCE verifier made from them must be exactly these. */
const countingBytes = (byteLength: number): Uint8Array<ArrayBuffer> =>
	Uint8Array.from({ length: byteLength }, (_, index) => index % 256);
const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex');
/** A base64url SHA-256 claim (intent, ath, jkt, code_challenge) as the hex its input hashes to. */
const claimDigestHex = (base64UrlDigest: string): string =>
	Buffer.from(base64UrlDigest, 'base64url').toString('hex');
const digestInputs = (records: readonly SignInCapabilityRecord[]): readonly string[] =>
	records.flatMap((record) => (record.kind === 'digest' ? [record.inputSha256] : []));

// Node only by design: the Cloudflare host runs in workerd, outside this process.
it.skipIf(process.env.SIGN_IN_TEST_HOST !== 'node')(
	'admin forwarding (Node host): the verifier, proof key, signatures and intent digest all go through the host crypto',
	async () => {
		// Arrange
		let randomUnavailable = false;
		const harness = await startLocalAuthHarness({
			turnstileSecret: 'published-test',
			nodeCapabilityRecording: {
				clockOffsetMilliseconds: coreClockOffsetMilliseconds,
				randomBytes: (byteLength) => {
					if (randomUnavailable) throw new Error('host randomness unavailable');
					return countingBytes(byteLength);
				},
			},
		});
		try {
			await signInConfirmedPeopleBrowser({ harness, email: 'owner@example.invalid' });
			const organizationId = await ensureLocalOwnerOrganization({
				auth: harness.auth,
				database: harness.database,
			});
			const bootstrap = await harness.auth('/api/auth/owner/bootstrap', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: '{}',
			});
			expect(bootstrap.status).toBe(200);
			await harness.settleDeferredWork();
			const cookie = harness.cookie();
			const forward = (): Promise<Response> =>
				harness.auth('/api/auth/organization-admin/create-workspace', {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						origin: new URL(harness.issuer).origin,
						cookie,
					},
					body: JSON.stringify({
						organizationId,
						operationId: controlledSignInIds.nextId(),
						name: 'research',
						description: '',
					}),
				});
			const before = harness.capabilityRecords().length;

			// Act
			const forwarded = await forward();

			// Assert: central answered; then each site's own operation and input is in the record.
			expect(forwarded.status).toBe(200);
			const records = harness.capabilityRecords().slice(before);
			const received = harness.centralAdmin.receivedCredentials.at(-1);
			if (received === undefined) throw new Error('Central received no admin request');
			const accessToken = received.authorization.replace(/^DPoP /u, '');
			const centralProof = received.proof;
			const proofClaims = z
				.object({ jti: z.string(), iat: z.number(), ath: z.string(), intent: z.string() })
				.parse(decodeJwt(centralProof));
			const publicJwk = z
				.object({ kty: z.literal('EC'), crv: z.literal('P-256'), x: z.string(), y: z.string() })
				.parse(decodeProtectedHeader(centralProof).jwk);
			// Admin verifier: one 32-byte draw; the S256 challenge digests base64url of those bytes.
			expect(records.filter((record) => record.kind === 'random')).toEqual([
				{ kind: 'random', byteLength: 32 },
			]);
			const verifier = Buffer.from(countingBytes(32)).toString('base64url');
			expect(digestInputs(records)).toContain(sha256Hex(verifier));
			// The proof key: created non-extractable, its public half exported, thumbprint digested.
			expect(records).toContainEqual({
				kind: 'generate-key',
				algorithm: { name: 'ECDSA', namedCurve: 'P-256' },
				extractable: false,
				keyUsages: ['sign', 'verify'],
			});
			expect(records).toContainEqual({ kind: 'export-key', format: 'jwk', keyType: 'public' });
			expect(digestInputs(records)).toContain(
				claimDigestHex(await calculateJwkThumbprint(publicJwk, 'sha256')),
			);
			// The token binding (ath) and the intent digest the proof carries.
			expect(claimDigestHex(proofClaims.ath)).toBe(sha256Hex(accessToken));
			expect(digestInputs(records)).toContain(sha256Hex(accessToken));
			expect(digestInputs(records)).toContain(claimDigestHex(proofClaims.intent));
			// Two ES256 signatures (the token endpoint's DPoP proof and central's), one of them over
			// exactly central's signing input.
			const signatures = records.flatMap((record) => (record.kind === 'sign' ? [record] : []));
			expect(signatures.map((record) => record.algorithm)).toEqual([
				{ name: 'ECDSA', hash: 'SHA-256' },
				{ name: 'ECDSA', hash: 'SHA-256' },
			]);
			const signingInput = centralProof.split('.').slice(0, 2).join('.');
			expect(signatures.map((record) => record.inputSha256)).toContain(sha256Hex(signingInput));
			// U23: the proof's ID and time came from the recorded ID source and clock, and the call to
			// central went through the recorded client.
			expect(records).toContainEqual({ kind: 'id-minted', id: proofClaims.jti });
			// The proof's time is the core clock's, not the process clock's (pinned to the controlled time).
			const processSeconds = Math.floor(controlledSignInClock.now() / 1000);
			expect(proofClaims.iat).toBe(
				Math.floor((controlledSignInClock.now() + coreClockOffsetMilliseconds) / 1000),
			);
			expect(proofClaims.iat).not.toBe(processSeconds);
			expect(
				records.some(
					(record) =>
						record.kind === 'clock-read' && Math.floor(record.now / 1000) === proofClaims.iat,
				),
			).toBe(true);
			expect(records).toContainEqual({ kind: 'central-call', operation: 'sendFleetAdminRequest' });

			// Act: the host's randomness now fails at the verifier.
			const beforeFailure = harness.capabilityRecords().length;
			const centralBeforeFailure = harness.centralAdmin.receivedCredentials.length;
			randomUnavailable = true;
			const failed = await forward();

			// Assert: the steps after the throw don't happen: no proof, no token, nothing to central.
			expect(failed.ok).toBe(false);
			const afterFailure = harness.capabilityRecords().slice(beforeFailure);
			expect(afterFailure.filter((record) => record.kind === 'random')).toEqual([
				{ kind: 'random', byteLength: 32 },
			]);
			expect(afterFailure.filter((record) => record.kind === 'sign')).toEqual([]);
			expect(afterFailure.filter((record) => record.kind === 'central-call')).toEqual([]);
			expect(harness.centralAdmin.receivedCredentials).toHaveLength(centralBeforeFailure);
		} finally {
			await harness.close();
		}
	},
);
