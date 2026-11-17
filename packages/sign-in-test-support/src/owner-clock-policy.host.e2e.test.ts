import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

import { epochMillisecondsSchema } from '@agent-collaboration/sign-in-core';
import { cachedOwnerTokenSchema } from '@agent-collaboration/sign-in-owner-cli';
import { personTokenClaimsSchema } from '@agent-collaboration/tool-access/contracts';
import { decodeJwt } from 'jose';
import { expect, it } from 'vitest';
import { z } from 'zod';

import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import { controlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-sign-in-clock';
import { startLocalAuthHarness } from '#sign-in-test-support/test-fixtures/local-auth-harness';
import {
	nativeOwnerCliProfileSchema,
	type NativeOwnerCliProfile,
} from '#sign-in-test-support/test-fixtures/native-owner-cli-profile';

useControlledSignInClock();
type Harness = Awaited<ReturnType<typeof startLocalAuthHarness>>;
const initialTime = controlledSignInClock.now();

function openClockPolicyHarness(offset: number): ReturnType<typeof startLocalAuthHarness> {
	return startLocalAuthHarness({
		turnstileSecret: 'published-test',
		// Isolate the CLI's expiry policy from an unrelated authenticator skew.
		authenticatorClock: { now: () => epochMillisecondsSchema.parse(initialTime + offset) },
	});
}

async function setIssuerClock(harness: Harness, milliseconds: number): Promise<void> {
	const response = await harness.auth('/__auth-proof/set-clock', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ milliseconds }),
	});
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({ controlledMilliseconds: milliseconds });
}

async function observeLogin(harness: Harness, profile?: NativeOwnerCliProfile): Promise<string> {
	try {
		await harness.ownerToken(profile);
		return 'accepted';
	} catch (error) {
		const reasons = [
			'lifetime-exceeds-local-window',
			'lifetime-exceeds-issuance-ceiling',
			'wrong-client',
			'refused:bad-signature',
		];
		return error instanceof Error
			? (reasons.find((reason) => error.message.includes(`(${reason})`)) ?? 'other-refusal')
			: 'other-refusal';
	}
}

it.each([
	{ offset: 0, expected: 'accepted' },
	{ offset: 1_000, expected: 'accepted' },
	{ offset: 60_000, expected: 'accepted' },
	{ offset: 61_000, expected: 'lifetime-exceeds-local-window' },
])(
	'owner clock: stock issuance at +$offset milliseconds is $expected',
	async ({ offset, expected }) => {
		const harness = await openClockPolicyHarness(offset);
		try {
			await setIssuerClock(harness, initialTime + offset);
			expect(await observeLogin(harness)).toBe(expected);
		} finally {
			await harness.close();
		}
	},
);

it('owner clock: refuses a signed expiry exactly one millisecond beyond the local future horizon', async () => {
	const harness = await openClockPolicyHarness(61_000);
	try {
		// The signed times have second precision: issuer+61s, child+999ms gives60001ms skew.
		await setIssuerClock(harness, initialTime + 61_000);
		const profile = nativeOwnerCliProfileSchema.parse({
			kind: 'clock',
			nowMilliseconds: initialTime + 999,
		});
		expect(await observeLogin(harness, profile)).toBe('lifetime-exceeds-local-window');
	} finally {
		await harness.close();
	}
});

it('owner clock: an authentic cached token over the signed lifetime ceiling requires a fresh login', async () => {
	const harness = await startLocalAuthHarness();
	try {
		await setIssuerClock(harness, initialTime);
		const token = await harness.ownerToken();
		const claims = personTokenClaimsSchema.parse(decodeJwt(token));
		const profile = nativeOwnerCliProfileSchema.parse({
			kind: 'clock',
			nowMilliseconds: initialTime,
			authorization: 'allow-cache',
		});
		const validCacheHash = createHash('sha256')
			.update(await readFile(harness.target.tokenCachePath))
			.digest('hex');
		await harness.ownerToken(profile);
		expect(
			createHash('sha256')
				.update(await readFile(harness.target.tokenCachePath))
				.digest('hex'),
		).toBe(validCacheHash);
		const response = await harness.auth('/api/auth/__proof/owner-token-profile', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ claims, profile: 'long-lifetime' }),
		});
		expect(response.status).toBe(200);
		const negative = z.strictObject({ token: z.string().min(1) }).parse(await response.json());
		const negativeClaims = personTokenClaimsSchema.parse(decodeJwt(negative.token));
		expect(negativeClaims.exp - negativeClaims.iat).toBe(301);
		const cached = cachedOwnerTokenSchema.parse(
			JSON.parse(await readFile(harness.target.tokenCachePath, 'utf8')),
		);
		await writeFile(
			harness.target.tokenCachePath,
			JSON.stringify({ ...cached, token: negative.token, expiresAt: negativeClaims.exp * 1000 }),
			{ mode: 0o600 },
		);
		const renewed = personTokenClaimsSchema.parse(decodeJwt(await harness.ownerToken(profile)));
		expect(renewed.exp - renewed.iat).toBe(300);
	} finally {
		await harness.close();
	}
});

it.each([
	{ profile: 'long-lifetime', expected: 'lifetime-exceeds-issuance-ceiling' },
	{ profile: 'wrong-client', expected: 'wrong-client' },
	{ profile: 'bad-signature', expected: 'refused:bad-signature' },
])('owner clock: rejects the real CLI $profile token profile', async ({ profile, expected }) => {
	const harness = await startLocalAuthHarness();
	try {
		await setIssuerClock(harness, initialTime);
		const token = await harness.ownerToken();
		const claims = personTokenClaimsSchema.parse(decodeJwt(token));
		const originalCache = createHash('sha256')
			.update(await readFile(harness.target.tokenCachePath))
			.digest('hex');
		const response = await harness.auth('/api/auth/__proof/owner-token-profile', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ claims, profile }),
		});
		expect(response.status).toBe(200);
		const negative = z.strictObject({ token: z.string().min(1) }).parse(await response.json());
		const clientProfile = nativeOwnerCliProfileSchema.parse({
			kind: 'token-response',
			issuer: harness.issuer,
			nowMilliseconds: initialTime,
			accessToken: negative.token,
		});
		expect(await observeLogin(harness, clientProfile)).toBe(expected);
		expect(
			createHash('sha256')
				.update(await readFile(harness.target.tokenCachePath))
				.digest('hex'),
		).toBe(originalCache);
	} finally {
		await harness.close();
	}
});
