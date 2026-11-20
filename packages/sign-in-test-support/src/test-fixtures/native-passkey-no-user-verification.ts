import { z } from 'zod';

import type { NativeAwaitObserver } from '#sign-in-test-support/test-fixtures/native-browser-progress';
import type { PlaywrightBrowserPage } from '#sign-in-test-support/test-fixtures/playwright-browser';

const mountedErrorToast =
	'[data-sonner-toast][data-type="error"][data-visible="true"][data-mounted="true"][data-removed="false"]';

/** The native refusal retains the same challenge, response, notice and signed-out assertions. */
export async function observeNativePasskeyNoUserVerification(props: {
	readonly page: PlaywrightBrowserPage;
	readonly authenticatorId: string;
	readonly issuer: string;
	readonly activeStep: string;
	readonly signInPage: (url: string) => Promise<void>;
	readonly challengeAccepted: (action: () => Promise<void>) => Promise<void>;
	readonly passed: (
		name: string,
		facts: Readonly<Record<string, unknown>>,
		capture?: boolean,
	) => Promise<void>;
	readonly observeAwait: NativeAwaitObserver;
}): Promise<void> {
	const {
		page,
		authenticatorId,
		issuer,
		activeStep,
		signInPage,
		challengeAccepted,
		passed,
		observeAwait,
	} = props;
	await observeAwait('no-UV: sign-in page', () => signInPage(issuer + '/sign-in'));
	await observeAwait('no-UV: no existing notice before the attempt', () =>
		page.evaluate("document.querySelector('[data-sonner-toast]')===null", z.literal(true)),
	);
	await observeAwait('no-UV: set bad-UV response bit', () =>
		page.protocol.send('WebAuthn.setResponseOverrideBits', { authenticatorId, isBadUV: true }),
	);
	const refusal = await observeAwait('no-UV: challenge and verification response', () =>
		page.responseTo('/api/auth/passkey/verify-authentication', () =>
			challengeAccepted(() => page.click('[data-sign-in-island] button', 'Continue with Passkey')),
		),
	);
	if (refusal.response.status !== 401)
		throw new Error(`No-UV verify status ${refusal.response.status}`);
	z.object({ code: z.literal('USER_VERIFICATION_REQUIRED') }).parse(
		await observeAwait('no-UV: verification body', () => page.readBody(refusal)),
	);
	await observeAwait('no-UV: mounted notice and enabled button readiness', () =>
		page.readyWhen(
			`location.pathname==='/sign-in' && !!document.querySelector(${JSON.stringify(mountedErrorToast)}) && [...document.querySelectorAll('button')].some(button=>button.textContent.trim()==='Continue with Passkey'&&!button.disabled)`,
		),
	);
	await observeAwait('no-UV: visible refusal message', async (): Promise<void> => {
		page.recordAwait('no-UV: refusal title after toast entry');
		const notice = page.page
			.locator(`${mountedErrorToast} [data-title]`)
			.filter({ hasText: /^user-verification-required$/u });
		if ((await notice.count()) !== 1)
			throw new Error('No-UV refusal title was missing or ambiguous');
		const visible = await notice.evaluate(
			async (title) => {
				const toast = title.closest('[data-sonner-toast]');
				if (toast === null) return false;
				// Sonner's mounted state starts the toast's entry transitions.
				await Promise.all(toast.getAnimations().map((animation) => animation.finished));
				return title.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
			},
			undefined,
			{ timeout: 0 },
		);
		if (!visible) throw new Error('No-UV refusal title was not visible');
	});
	await observeAwait('no-UV: signed-out session fetch and JSON', () =>
		page.evaluate(
			"fetch('/api/auth/get-session').then(response=>response.json()).then(session=>{if(session!==null)throw new Error('No-UV session exists');return true;})",
			z.literal(true),
		),
	);
	await observeAwait('no-UV: reset bad-UV response bit', () =>
		page.protocol.send('WebAuthn.setResponseOverrideBits', { authenticatorId, isBadUV: false }),
	);
	await observeAwait('no-UV: passed evidence and normal screenshot', () =>
		passed(
			activeStep,
			{ status: 401, code: 'USER_VERIFICATION_REQUIRED', notice: true, signedOut: true },
			true,
		),
	);
}
