import { z } from 'zod';

import type { NativeBrowserPage } from '#sign-in-test-support/test-fixtures/native-browser-page';
import type { NativeAwaitObserver } from '#sign-in-test-support/test-fixtures/native-browser-progress';
import type { ChromeProtocol } from '#sign-in-test-support/test-fixtures/native-browser-protocol';

const empty = z.object({}).passthrough();

/** The native refusal retains the same challenge, response, notice and signed-out assertions. */
export async function observeNativePasskeyNoUserVerification(props: {
	readonly page: NativeBrowserPage;
	readonly protocol: Pick<ChromeProtocol, 'call'>;
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
		protocol,
		authenticatorId,
		issuer,
		activeStep,
		signInPage,
		challengeAccepted,
		passed,
		observeAwait,
	} = props;
	await observeAwait('no-UV: sign-in page', () => signInPage(issuer + '/sign-in'));
	await observeAwait('no-UV: set bad-UV response bit', () =>
		protocol.call('WebAuthn.setResponseOverrideBits', { authenticatorId, isBadUV: true }, empty),
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
	await observeAwait('no-UV: notice and enabled button readiness', () =>
		page.readyWhen(
			"location.pathname==='/sign-in' && !!document.querySelector('[data-sonner-toast]') && [...document.querySelectorAll('button')].some(button=>button.textContent.trim()==='Continue with Passkey'&&!button.disabled)",
		),
	);
	await observeAwait('no-UV: signed-out session fetch and JSON', () =>
		page.evaluate(
			"fetch('/api/auth/get-session').then(response=>response.json()).then(session=>{if(session!==null)throw new Error('No-UV session exists');return true;})",
			z.literal(true),
		),
	);
	await observeAwait('no-UV: reset bad-UV response bit', () =>
		protocol.call('WebAuthn.setResponseOverrideBits', { authenticatorId, isBadUV: false }, empty),
	);
	await observeAwait('no-UV: passed evidence and normal screenshot', () =>
		passed(
			activeStep,
			{ status: 401, code: 'USER_VERIFICATION_REQUIRED', notice: true, signedOut: true },
			true,
		),
	);
}
