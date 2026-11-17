import { signInObservationSchema } from '@agent-collaboration/sign-in-core';
import { expect, test } from 'vitest';
import { z } from 'zod';

import {
	clearCaptchaState,
	readCaptchaState,
} from '#sign-in-test-support/test-fixtures/captcha-state-readback';
import { startLocalAuthHarness } from '#sign-in-test-support/test-fixtures/local-auth-harness';

const providerResultSchema = z.strictObject({
	response: z.discriminatedUnion('kind', [
		z.strictObject({ kind: z.literal('allowed') }),
		z.strictObject({ kind: z.literal('response'), status: z.number().int(), body: z.string() }),
	]),
	observations: z.array(signInObservationSchema),
});
type ProviderResult = z.infer<typeof providerResultSchema>;
type LocalAuthHarness = Awaited<ReturnType<typeof startLocalAuthHarness>>;

async function requestProvider(props: {
	readonly harness: LocalAuthHarness;
	readonly endpoint?: 'social' | 'passkey';
	readonly mode?: 'provider' | 'native-hook' | 'observed-hook' | 'configuration';
	readonly provider?: 'google' | 'unconfigured';
	readonly token?: string;
}): Promise<ProviderResult> {
	const response = await props.harness.auth('/__auth-proof/captcha-provider', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			...(props.token === undefined ? {} : { 'x-captcha-response': props.token }),
		},
		body: JSON.stringify({
			endpoint: props.endpoint ?? 'passkey',
			mode: props.mode ?? 'provider',
			provider: props.provider ?? 'google',
		}),
	});
	expect(response.status).toBe(200);
	return providerResultSchema.parse(await response.json());
}

function requireProviderResponse(result: ProviderResult): {
	readonly status: number;
	readonly body: string;
} {
	if (result.response.kind !== 'response') throw new Error('Expected a real provider response');
	return result.response;
}

test('turnstile: actual deployed provider options contain only its own hostname and disjoint actions', async () => {
	const harness = await startLocalAuthHarness();
	try {
		const result = await requestProvider({ harness, mode: 'configuration' });
		expect(JSON.parse(requireProviderResponse(result).body)).toEqual([
			{
				endpoints: ['/sign-in/social'],
				expectedAction: 'sign_in_social',
				allowedHostnames: ['deployed-sign-in.example.invalid'],
			},
			{
				endpoints: ['/passkey/generate-authenticate-options'],
				expectedAction: 'passkey_sign_in',
				allowedHostnames: ['deployed-sign-in.example.invalid'],
			},
		]);
		expect(harness.siteVerifyAttempts()).toBe(0);
		expect(result.observations).toEqual([]);
	} finally {
		await harness.close();
	}
});

test.each(['missing', 'rejected', 'wrong-action', 'wrong-hostname'])(
	'turnstile: private provider passkey %s refusal creates no challenge or seed',
	async (reason: string): Promise<void> => {
		const harness = await startLocalAuthHarness();
		try {
			await clearCaptchaState(harness);
			const before = await readCaptchaState(harness);
			const token =
				reason === 'missing'
					? undefined
					: harness.turnstile.issueToken({
							action: reason === 'wrong-action' ? 'sign_in_social' : 'passkey_sign_in',
							hostname:
								reason === 'wrong-hostname'
									? 'foreign.example.invalid'
									: new URL(harness.issuer).hostname,
							verdict: reason === 'rejected' ? 'rejected' : 'accepted',
						});
			const result = await requestProvider({ harness, ...(token === undefined ? {} : { token }) });
			const response = requireProviderResponse(result);
			expect(response.status).toBe(reason === 'missing' ? 400 : 403);
			expect(JSON.parse(response.body)).toMatchObject({
				code: reason === 'missing' ? 'MISSING_RESPONSE' : 'VERIFICATION_FAILED',
			});
			expect(await readCaptchaState(harness)).toEqual(before);
			expect(harness.turnstile.requests()).toHaveLength(reason === 'missing' ? 0 : 1);
			expect(result.observations).toEqual([
				{ kind: 'captcha-refused', action: 'passkey_sign_in', reason },
			]);
			expect(await harness.captchaObservations()).toEqual(result.observations);
		} finally {
			await harness.close();
		}
	},
);

test('turnstile: accepted private passkey options store a real challenge and replay changes nothing', async () => {
	const harness = await startLocalAuthHarness();
	try {
		await clearCaptchaState(harness);
		const token = harness.turnstile.issueToken({
			action: 'passkey_sign_in',
			hostname: new URL(harness.issuer).hostname,
			verdict: 'accepted',
		});
		const accepted = await requestProvider({ harness, token });
		expect(requireProviderResponse(accepted).status).toBe(200);
		expect(
			z
				.object({ challenge: z.string().min(1) })
				.safeParse(JSON.parse(requireProviderResponse(accepted).body)).success,
		).toBe(true);
		const beforeReplay = await readCaptchaState(harness);
		expect(beforeReplay.verification).toHaveLength(1);
		expect(accepted.observations).toEqual([]);
		const replay = await requestProvider({ harness, token });
		expect(requireProviderResponse(replay).status).toBe(403);
		expect(await readCaptchaState(harness)).toEqual(beforeReplay);
		expect(harness.turnstile.requests()).toHaveLength(2);
		expect(replay.observations).toEqual([
			{ kind: 'captcha-refused', action: 'passkey_sign_in', reason: 'duplicate' },
		]);
	} finally {
		await harness.close();
	}
});

test.each(['error-response', 'connection-refused'])(
	'turnstile: real provider passkey fails closed when siteverify is %s',
	async (failure: string): Promise<void> => {
		const harness = await startLocalAuthHarness({
			turnstileSecret: 'published-test',
			siteVerify: failure === 'connection-refused' ? 'connection-refused' : 'stand-in',
		});
		try {
			await clearCaptchaState(harness);
			const before = await readCaptchaState(harness);
			if (failure === 'error-response') harness.turnstile.failResponses();
			const token = harness.turnstile.issueToken({
				action: 'passkey_sign_in',
				hostname: new URL(harness.issuer).hostname,
				verdict: 'accepted',
			});
			const result = await requestProvider({ harness, token });
			const response = requireProviderResponse(result);
			expect(response.status).toBe(500);
			expect(JSON.parse(response.body)).toMatchObject({ code: 'UNKNOWN_ERROR' });
			expect(await readCaptchaState(harness)).toEqual(before);
			expect(harness.siteVerifyAttempts()).toBe(1);
			if (failure === 'connection-refused')
				expect(harness.siteVerifyTransportFailures()).toEqual(['connection-refused']);
			expect(result.observations).toEqual([
				{ kind: 'captcha-refused', action: 'passkey_sign_in', reason: 'unavailable' },
			]);
			expect(await harness.captchaObservations()).toEqual(result.observations);
		} finally {
			await harness.close();
		}
	},
);

test.each([
	'missing',
	'rejected',
	'wrong-action',
	'wrong-hostname',
	'duplicate',
	'unavailable',
	'accepted',
])(
	'turnstile: observer preserves the native captcha hook result for %s',
	async (reason: string): Promise<void> => {
		const harness = await startLocalAuthHarness();
		try {
			if (reason === 'unavailable') harness.turnstile.failResponses();
			async function prepareToken(): Promise<string | undefined> {
				if (reason === 'missing') return undefined;
				const token = harness.turnstile.issueToken({
					action: reason === 'wrong-action' ? 'sign_in_social' : 'passkey_sign_in',
					hostname:
						reason === 'wrong-hostname'
							? 'foreign.example.invalid'
							: new URL(harness.issuer).hostname,
					verdict: reason === 'rejected' ? 'rejected' : 'accepted',
				});
				if (reason === 'duplicate') {
					const first = await requestProvider({ harness, token, mode: 'native-hook' });
					expect(first.response).toEqual({ kind: 'allowed' });
				}
				return token;
			}
			const nativeToken = await prepareToken();
			const observedToken = await prepareToken();
			const native = await requestProvider({
				harness,
				mode: 'native-hook',
				...(nativeToken === undefined ? {} : { token: nativeToken }),
			});
			const observed = await requestProvider({
				harness,
				mode: 'observed-hook',
				...(observedToken === undefined ? {} : { token: observedToken }),
			});
			expect(observed.response).toEqual(native.response);
			expect(native.observations).toEqual([]);
			expect(observed.observations).toEqual(
				reason === 'accepted'
					? []
					: [{ kind: 'captcha-refused', action: 'passkey_sign_in', reason }],
			);
		} finally {
			await harness.close();
		}
	},
);

test('turnstile: a non-captcha provider refusal after verification emits no captcha observation', async () => {
	const harness = await startLocalAuthHarness();
	try {
		const token = harness.turnstile.issueToken({
			action: 'sign_in_social',
			hostname: new URL(harness.issuer).hostname,
			verdict: 'accepted',
		});
		const result = await requestProvider({
			harness,
			token,
			endpoint: 'social',
			provider: 'unconfigured',
		});
		const response = requireProviderResponse(result);
		expect(response.status).toBe(404);
		expect(JSON.parse(response.body)).toMatchObject({ code: 'PROVIDER_NOT_FOUND' });
		expect(harness.turnstile.requests()).toHaveLength(1);
		expect(result.observations).toEqual([]);
		expect(await harness.captchaObservations()).toEqual([]);
	} finally {
		await harness.close();
	}
});

test.each(['wrong-action-first', 'duplicate-first'])(
	'turnstile: overlapping native provider refusals retain each request reason (%s)',
	async (releaseOrder: string): Promise<void> => {
		const harness = await startLocalAuthHarness();
		const wrongToken = harness.turnstile.issueToken({
			action: 'sign_in_social',
			hostname: new URL(harness.issuer).hostname,
			verdict: 'accepted',
		});
		const duplicateToken = harness.turnstile.issueToken({
			action: 'passkey_sign_in',
			hostname: new URL(harness.issuer).hostname,
			verdict: 'accepted',
		});
		const wrongHold = harness.turnstile.holdToken(wrongToken);
		let duplicateHold: ReturnType<typeof harness.turnstile.holdToken> | undefined;
		try {
			await requestProvider({ harness, token: duplicateToken, mode: 'native-hook' });
			duplicateHold = harness.turnstile.holdToken(duplicateToken);
			const wrong = requestProvider({ harness, token: wrongToken });
			const duplicate = requestProvider({ harness, token: duplicateToken });
			await Promise.all([wrongHold.entered, duplicateHold.entered]);
			if (releaseOrder === 'wrong-action-first') {
				wrongHold.release();
				duplicateHold.release();
			} else {
				duplicateHold.release();
				wrongHold.release();
			}
			const [wrongResult, duplicateResult] = await Promise.all([wrong, duplicate]);
			expect(requireProviderResponse(wrongResult).status).toBe(403);
			expect(requireProviderResponse(duplicateResult).status).toBe(403);
			expect(wrongResult.observations).toEqual([
				{ kind: 'captcha-refused', action: 'passkey_sign_in', reason: 'wrong-action' },
			]);
			expect(duplicateResult.observations).toEqual([
				{ kind: 'captcha-refused', action: 'passkey_sign_in', reason: 'duplicate' },
			]);
			expect(
				(await harness.captchaObservations())
					.map((observation): string => {
						if (observation.kind !== 'captcha-refused')
							throw new Error('Unexpected non-captcha event in a captcha-only observation case');
						return observation.reason;
					})
					.toSorted(),
			).toEqual(['duplicate', 'wrong-action']);
		} finally {
			wrongHold.release();
			duplicateHold?.release();
			await harness.close();
		}
	},
);
