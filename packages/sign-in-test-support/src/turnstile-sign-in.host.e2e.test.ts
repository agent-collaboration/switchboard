import { expect, test } from 'vitest';

import {
	clearCaptchaState,
	readCaptchaState,
} from '#sign-in-test-support/test-fixtures/captcha-state-readback';
import { startLocalAuthHarness } from '#sign-in-test-support/test-fixtures/local-auth-harness';
import { turnstileTestSecret } from '#sign-in-test-support/test-fixtures/turnstile-test-keys';

type LocalAuthHarness = Awaited<ReturnType<typeof startLocalAuthHarness>>;

async function requestSocialSignIn(
	harness: LocalAuthHarness,
	token?: string,
	extraHeaders: Readonly<Record<string, string>> = {},
): Promise<Response> {
	return harness.auth('/api/auth/sign-in/social', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			...(token === undefined ? {} : { 'x-captcha-response': token }),
			...extraHeaders,
		},
		body: JSON.stringify({
			provider: 'google',
			callbackURL: new URL('/owner-ready', harness.issuer).toString(),
		}),
	});
}

test('turnstile: refuses social start without a token before any owner or OAuth write', async () => {
	// The public host and native Better Auth handler remain real; rejected starts must leave every identity table empty.
	const harness = await startLocalAuthHarness();
	try {
		await clearCaptchaState(harness);
		const response = await harness.auth('/api/auth/sign-in/social', {
			method: 'POST',
			headers: { 'content-type': 'application/json', origin: harness.issuer },
			body: JSON.stringify({
				provider: 'google',
				callbackURL: new URL('/owner-ready', harness.issuer).toString(),
			}),
		});
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ code: 'MISSING_RESPONSE' });
		expect(await readCaptchaState(harness)).toEqual({
			verification: [],
			users: [],
			accounts: [],
			sessions: [],
			organizations: [],
			memberships: [],
			invitations: [],
			audit: [],
		});
		expect(await harness.captchaObservations()).toEqual([
			{ kind: 'captcha-refused', action: 'sign_in_social', reason: 'missing' },
		]);
		expect(harness.turnstile.requests()).toEqual([]);
	} finally {
		await harness.close();
	}
});

test.each(['rejected', 'wrong-action', 'wrong-hostname'])(
	'turnstile: public social %s refusal preserves every stored field',
	async (reason: string): Promise<void> => {
		const harness = await startLocalAuthHarness();
		try {
			await clearCaptchaState(harness);
			const before = await readCaptchaState(harness);
			const token = harness.turnstile.issueToken({
				action: reason === 'wrong-action' ? 'passkey_sign_in' : 'sign_in_social',
				hostname:
					reason === 'wrong-hostname'
						? 'foreign.example.invalid'
						: new URL(harness.issuer).hostname,
				verdict: reason === 'rejected' ? 'rejected' : 'accepted',
			});
			const response = await requestSocialSignIn(harness, token);
			expect(response.status).toBe(403);
			expect(await response.json()).toMatchObject({ code: 'VERIFICATION_FAILED' });
			expect(await readCaptchaState(harness)).toEqual(before);
			expect(harness.turnstile.requests()).toHaveLength(1);
			expect(harness.turnstile.requests()[0]).toMatchObject({
				secret: turnstileTestSecret,
				response: token,
			});
			expect(await harness.captchaObservations()).toEqual([
				{ kind: 'captcha-refused', action: 'sign_in_social', reason },
			]);
		} finally {
			await harness.close();
		}
	},
);

test('turnstile: accepts distinct tokens once each and refuses replay without a write', async () => {
	const harness = await startLocalAuthHarness();
	try {
		const issue = (): string =>
			harness.turnstile.issueToken({
				action: 'sign_in_social',
				hostname: new URL(harness.issuer).hostname,
				verdict: 'accepted',
			});
		const firstToken = issue();
		const secondToken = issue();
		expect((await requestSocialSignIn(harness, firstToken)).status).toBe(200);
		expect((await requestSocialSignIn(harness, secondToken)).status).toBe(200);
		expect(await harness.captchaObservations()).toEqual([]);
		const before = await readCaptchaState(harness);
		const replay = await requestSocialSignIn(harness, firstToken);
		expect(replay.status).toBe(403);
		expect(await replay.json()).toMatchObject({ code: 'VERIFICATION_FAILED' });
		expect(await readCaptchaState(harness)).toEqual(before);
		expect(harness.turnstile.requests().map((request): string => request.response)).toEqual([
			firstToken,
			secondToken,
			firstToken,
		]);
		expect(await harness.captchaObservations()).toEqual([
			{ kind: 'captcha-refused', action: 'sign_in_social', reason: 'duplicate' },
		]);
	} finally {
		await harness.close();
	}
});

test('turnstile: host-trusted address overrides forged client headers', async () => {
	const harness = await startLocalAuthHarness();
	try {
		const token = harness.turnstile.issueToken({
			action: 'sign_in_social',
			hostname: new URL(harness.issuer).hostname,
			verdict: 'accepted',
		});
		const response = await requestSocialSignIn(harness, token, {
			'cf-connecting-ip': '203.0.113.41',
			'x-forwarded-for': '198.51.100.19',
			'x-sign-in-client-address': '198.51.100.20',
		});
		expect(response.status).toBe(200);
		expect(harness.turnstile.requests()).toEqual([
			{ secret: turnstileTestSecret, response: token, remoteip: harness.browserAddress() },
		]);
		expect(await harness.captchaObservations()).toEqual([]);
	} finally {
		await harness.close();
	}
});

test('turnstile: absent CF address never forwards either forged client header', async () => {
	const harness = await startLocalAuthHarness({
		turnstileSecret: 'published-test',
		cloudflareClientAddress: 'absent',
	});
	try {
		const token = harness.turnstile.issueToken({
			action: 'sign_in_social',
			hostname: new URL(harness.issuer).hostname,
			verdict: 'accepted',
		});
		const response = await requestSocialSignIn(harness, token, {
			'x-forwarded-for': '198.51.100.19',
			'x-sign-in-client-address': '198.51.100.20',
		});
		expect(response.status).toBe(200);
		const requests = harness.turnstile.requests();
		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({ secret: turnstileTestSecret, response: token });
		// Native Better Auth may supply its development/test localhost fallback.
		// Neither caller-controlled header can become the verifier's remoteip.
		expect(requests[0]?.remoteip).not.toBe('198.51.100.19');
		expect(requests[0]?.remoteip).not.toBe('198.51.100.20');
		expect(await harness.captchaObservations()).toEqual([]);
	} finally {
		await harness.close();
	}
});

test('turnstile: a later social body validation400 is not a captcha refusal', async () => {
	const harness = await startLocalAuthHarness();
	try {
		const token = harness.turnstile.issueToken({
			action: 'sign_in_social',
			hostname: new URL(harness.issuer).hostname,
			verdict: 'accepted',
		});
		const response = await harness.auth('/api/auth/sign-in/social', {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-captcha-response': token },
			body: '{}',
		});
		// onRequest accepts the native captcha before the endpoint rejects its body.
		expect(response.status).toBe(400);
		await response.arrayBuffer();
		const requests = harness.turnstile.requests();
		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({ secret: turnstileTestSecret, response: token });
		expect(await harness.captchaObservations()).toEqual([]);
	} finally {
		await harness.close();
	}
});

test('turnstile: an error siteverify response fails closed before any write', async () => {
	const harness = await startLocalAuthHarness();
	try {
		await clearCaptchaState(harness);
		const before = await readCaptchaState(harness);
		harness.turnstile.failResponses();
		const token = harness.turnstile.issueToken({
			action: 'sign_in_social',
			hostname: new URL(harness.issuer).hostname,
			verdict: 'accepted',
		});
		const response = await requestSocialSignIn(harness, token);
		expect(response.status).toBe(500);
		expect(await response.json()).toMatchObject({ code: 'UNKNOWN_ERROR' });
		expect(await readCaptchaState(harness)).toEqual(before);
		expect(harness.turnstile.requests()).toHaveLength(1);
		expect(await harness.captchaObservations()).toEqual([
			{ kind: 'captcha-refused', action: 'sign_in_social', reason: 'unavailable' },
		]);
	} finally {
		await harness.close();
	}
});

test('turnstile: a missing Worker secret never removes the captcha gate', async () => {
	const harness = await startLocalAuthHarness({ turnstileSecret: 'missing' });
	try {
		await clearCaptchaState(harness);
		const before = await readCaptchaState(harness);
		const response = await requestSocialSignIn(harness, 'valid-looking-test-token');
		expect(response.status).toBe(500);
		expect(await response.json()).toMatchObject({ code: 'UNKNOWN_ERROR' });
		expect(await readCaptchaState(harness)).toEqual(before);
		expect(harness.turnstile.requests()).toEqual([]);
		expect(await harness.captchaObservations()).toEqual([
			{ kind: 'captcha-refused', action: 'sign_in_social', reason: 'unavailable' },
		]);
	} finally {
		await harness.close();
	}
});

test('turnstile: a real refused siteverify connection fails closed without a timer', async () => {
	const harness = await startLocalAuthHarness({
		turnstileSecret: 'published-test',
		siteVerify: 'connection-refused',
	});
	try {
		await clearCaptchaState(harness);
		const before = await readCaptchaState(harness);
		const response = await requestSocialSignIn(harness, 'valid-looking-test-token');
		expect(response.status).toBe(500);
		expect(await response.json()).toMatchObject({ code: 'UNKNOWN_ERROR' });
		expect(await readCaptchaState(harness)).toEqual(before);
		expect(harness.siteVerifyAttempts()).toBe(1);
		expect(harness.siteVerifyTransportFailures()).toEqual(['connection-refused']);
		expect(harness.turnstile.requests()).toEqual([]);
		expect(await harness.captchaObservations()).toEqual([
			{ kind: 'captcha-refused', action: 'sign_in_social', reason: 'unavailable' },
		]);
	} finally {
		await harness.close();
	}
});

test('turnstile: token, bootstrap and unoffered passkey operations do not ask for captcha', async () => {
	const harness = await startLocalAuthHarness();
	try {
		await clearCaptchaState(harness);
		const before = await readCaptchaState(harness);
		const wrongChallengeMethod = await harness.auth(
			'/api/auth/passkey/generate-authenticate-options',
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: '{}',
			},
		);
		const wrongVerificationMethod = await harness.auth('/api/auth/passkey/verify-authentication');
		const unofferedDeletion = await harness.auth('/api/auth/passkey/delete-passkey', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ id: 'unoffered-passkey' }),
		});
		expect(wrongChallengeMethod.status).toBe(404);
		expect(wrongVerificationMethod.status).toBe(404);
		expect(unofferedDeletion.status).toBe(404);
		expect(await readCaptchaState(harness)).toEqual(before);
		const token = await harness.auth('/api/auth/oauth2/token', {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: 'grant_type=client_credentials&client_id=not-registered&client_secret=not-a-secret',
		});
		const bootstrap = await harness.auth('/api/auth/owner/bootstrap', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{}',
		});
		expect(token.ok).toBe(false);
		expect(bootstrap.ok).toBe(false);
		expect(harness.turnstile.requests()).toEqual([]);
		expect(await harness.captchaObservations()).toEqual([]);
	} finally {
		await harness.close();
	}
});
