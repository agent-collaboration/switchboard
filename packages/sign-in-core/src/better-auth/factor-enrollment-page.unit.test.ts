import { renderSVG } from 'uqr';
import { expect, it } from 'vitest';

import {
	factorPageControls,
	renderFactorFormResponse,
} from '#sign-in-core/better-auth/factor-enrollment-page';
import type { SignInCrypto } from '#sign-in-core/contracts/sign-in-platform';

/** Known random bytes 00…0f, so every page's nonce is the same fixed value. */
const fixedBytesCrypto: SignInCrypto = {
	getRandomValues: (bytes) => {
		bytes.set(Array.from({ length: bytes.byteLength }, (_, index) => index % 256));
		return bytes;
	},
	subtle: globalThis.crypto.subtle,
};

const uri = 'otpauth://totp/Test:owner?secret=JBSWY3DPEHPK3PXP&issuer=Test';
function formRequest(path: string): Request {
	return new Request('https://sign-in.invalid/api/auth/two-factor/' + path, {
		method: 'POST',
		headers: { accept: 'text/html' },
	});
}

it('renders the encoder SVG for exactly the native URI and exposes setup material only in the no-store setup response', async () => {
	// Expected bytes come from the admitted encoder, not from our page renderer.
	const response = await renderFactorFormResponse({
		crypto: fixedBytesCrypto,
		request: formRequest('enable'),
		response: Response.json({ method: 'totp', totpURI: uri, backupCodes: ['saved-code-one'] }),
	});
	const html = await response.text();
	expect(html.match(/<svg\b[\s\S]*?<\/svg>/u)?.[0]).toBe(renderSVG(uri));
	expect(html).toContain('<code id="totp-secret">JBSWY3DPEHPK3PXP</code>');
	expect(html).toContain('otpauth://totp/Test:owner?secret=JBSWY3DPEHPK3PXP&amp;issuer=Test');
	expect(html).toContain('saved-code-one');
	expect(html).not.toContain('<canvas');
	expect(html).not.toContain('renderSVG(');
	expect(response.headers.get('cache-control')).toBe('no-store');
	expect(response.headers.get('referrer-policy')).toBe('no-referrer');
	for (const state of ['hidden', 'enroll-app', 'confirm', 'confirmed'] as const) {
		expect(factorPageControls(state)).not.toContain('JBSWY3DPEHPK3PXP');
		expect(factorPageControls(state)).not.toContain('saved-code-one');
	}
});

it('leaves native JSON callers on the native response contract', async () => {
	const native = { method: 'totp', totpURI: uri, backupCodes: ['saved-code-one'] };
	const response = await renderFactorFormResponse({
		crypto: fixedBytesCrypto,
		request: new Request('https://sign-in.invalid/api/auth/two-factor/enable', { method: 'POST' }),
		response: Response.json(native),
	});
	expect(await response.json()).toEqual(native);
	expect(response.headers.get('content-type')).toContain('application/json');
	expect(response.headers.get('cache-control')).toBe('no-store');
});

it('preserves the native rotated cookie when a successful form confirmation returns to the current session page', async () => {
	const response = await renderFactorFormResponse({
		crypto: fixedBytesCrypto,
		request: formRequest('verify-totp'),
		response: Response.json(
			{ status: true },
			{ headers: { 'set-cookie': 'native-fixture-cookie=returned; Secure; HttpOnly' } },
		),
	});
	expect(response.status).toBe(303);
	expect(response.headers.get('location')).toBe('/owner-ready');
	expect(response.headers.getSetCookie()).toEqual([
		'native-fixture-cookie=returned; Secure; HttpOnly',
	]);
	expect(await response.text()).toBe('');
});

it('never reflects a provider error body into an HTML refusal', async () => {
	const response = await renderFactorFormResponse({
		crypto: fixedBytesCrypto,
		request: formRequest('enable'),
		response: Response.json({ message: uri }, { status: 503 }),
	});
	expect(response.status).toBe(503);
	expect(await response.text()).not.toContain('JBSWY3DPEHPK3PXP');
});

it('carries the validated pending authorization through setup, confirmation and the back link', async () => {
	const resume =
		'https://sign-in.invalid/api/auth/oauth2/authorize?client_id=owner-cli&response_type=code&scope=tool-portal%3Amanagement&resource=https%3A%2F%2Fportal.invalid%2Fmanagement&code_challenge_method=S256&code_challenge=test&redirect_uri=http%3A%2F%2F127.0.0.1%2Fcallback';
	const query = `?authorize=${encodeURIComponent(resume)}`;
	expect(factorPageControls('enroll-app', resume)).toContain(
		`action="/api/auth/two-factor/enable${query}"`,
	);
	const setup = await renderFactorFormResponse({
		crypto: fixedBytesCrypto,
		request: formRequest('enable'),
		resume,
		response: Response.json({ method: 'totp', totpURI: uri, backupCodes: ['saved-code-one'] }),
	});
	const html = await setup.text();
	expect(html).toContain(`action="/api/auth/two-factor/verify-totp${query}"`);
	expect(html).toContain(`href="/owner-ready${query}"`);
	const confirmed = await renderFactorFormResponse({
		crypto: fixedBytesCrypto,
		request: formRequest('verify-totp'),
		resume,
		response: Response.json(
			{ status: true },
			{ headers: { 'set-cookie': 'rotated-native-cookie=kept; HttpOnly' } },
		),
	});
	expect(confirmed.status).toBe(303);
	expect(confirmed.headers.get('location')).toBe(`/owner-ready${query}`);
	expect(confirmed.headers.getSetCookie()).toEqual(['rotated-native-cookie=kept; HttpOnly']);
});

/** Counts the host's random draws; each draw returns 0xcd bytes. */
function countingCrypto(): { readonly crypto: SignInCrypto; readonly draws: () => number } {
	let draws = 0;
	return {
		draws: () => draws,
		crypto: {
			getRandomValues: (bytes) => {
				draws += 1;
				return bytes.fill(0xcd);
			},
			subtle: globalThis.crypto.subtle,
		},
	};
}

it('a rendered factor page asks the host once, and its nonce is those bytes on the header and every script', async () => {
	// Arrange
	const host = countingCrypto();
	// Act
	const response = await renderFactorFormResponse({
		crypto: host.crypto,
		request: formRequest('enable'),
		response: Response.json({ method: 'totp', totpURI: uri, backupCodes: ['saved-code-one'] }),
	});
	// Assert
	const nonce = 'cd'.repeat(16);
	expect(host.draws()).toBe(1);
	expect(response.headers.get('content-security-policy')).toContain(`'nonce-${nonce}'`);
	const scripts = [...(await response.text()).matchAll(/<script\b[^>]*>/gu)].map(
		(match) => match[0],
	);
	expect(scripts.length).toBeGreaterThan(0);
	for (const script of scripts) expect(script).toContain(`nonce="${nonce}"`);
});

it.each([
	{
		name: 'a JSON reply',
		request: new Request('https://sign-in.invalid/api/auth/two-factor/enable', { method: 'POST' }),
		response: (): Response =>
			Response.json({ method: 'totp', totpURI: uri, backupCodes: ['saved-code-one'] }),
		status: 200,
	},
	{
		name: 'the 303 redirect',
		request: formRequest('verify-totp'),
		response: (): Response => Response.json({ status: true }),
		status: 303,
	},
	{
		name: 'a pass-through of a request that is not a POST',
		request: new Request('https://sign-in.invalid/api/auth/two-factor/enable', {
			headers: { accept: 'text/html' },
		}),
		response: (): Response => Response.json({ kept: true }),
		status: 200,
	},
	{
		name: 'a pass-through of a path the page does not offer',
		request: formRequest('disable'),
		response: (): Response => Response.json({ kept: true }),
		status: 200,
	},
])('$name asks the host for no random bytes', async ({ request, response, status }) => {
	// Arrange
	const host = countingCrypto();
	// Act
	const replied = await renderFactorFormResponse({
		crypto: host.crypto,
		request,
		response: response(),
	});
	// Assert
	expect(replied.status).toBe(status);
	expect(replied.headers.has('content-security-policy')).toBe(false);
	expect(host.draws()).toBe(0);
});
