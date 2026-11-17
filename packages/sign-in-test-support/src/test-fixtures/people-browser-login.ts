import { user } from '@agent-collaboration/sign-in-core';
import type { SocialLoginProvider } from '@agent-collaboration/sign-in-core/better-auth';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import type { startLocalAuthHarness } from '#sign-in-test-support/test-fixtures/local-auth-harness';

type Harness = Awaited<ReturnType<typeof startLocalAuthHarness>>;

/** Real social redirect/callback and cookie jar; only the external provider is controlled. */
export async function signInPeopleBrowser(props: {
	readonly harness: Harness;
	readonly email: string;
	readonly provider?: SocialLoginProvider;
	readonly verified?: boolean;
}): Promise<string> {
	const { harness, email } = props;
	harness.useBrowser(email);
	harness.clearBrowserSession();
	const provider = props.provider ?? 'google';
	const start = await harness.auth('/api/auth/sign-in/social', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-captcha-response': harness.turnstile.issueToken({
				action: 'sign_in_social',
				hostname: new URL(harness.issuer).hostname,
				verdict: 'accepted',
			}),
		},
		body: JSON.stringify({
			provider,
			callbackURL: new URL('/owner-ready', harness.issuer).toString(),
		}),
	});
	if (!start.ok) throw new Error('People social start refused');
	const location = z.object({ url: z.url() }).parse(await start.json()).url;
	const callback = harness.providerCallback(
		provider,
		new URL(location),
		email,
		props.verified ?? true,
	);
	const signedIn = await harness.auth(callback.toString(), {
		headers: { 'sec-fetch-mode': 'navigate', accept: 'text/html' },
	});
	if (
		signedIn.status !== 302 ||
		new URL(signedIn.headers.get('location') ?? 'invalid:').searchParams.has('error')
	)
		throw new Error('People provider callback refused');
	return z
		.object({ id: z.uuidv7() })
		.parse(
			(await harness.database.select({ id: user.id }).from(user).where(eq(user.email, email)))[0],
		).id;
}

export function peoplePost(
	harness: Harness,
	pathname: string,
	body: Readonly<Record<string, unknown>>,
	cookie?: string,
): Promise<Response> {
	return harness.auth('/api/auth/organization/' + pathname, {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...(cookie === undefined ? {} : { cookie }) },
		body: JSON.stringify(body),
	});
}

/** Normal people setup confirms the native app; cases examining provider-only state use signInPeopleBrowser explicitly. */
export async function signInConfirmedPeopleBrowser(
	props: Parameters<typeof signInPeopleBrowser>[0],
): Promise<string> {
	const personId = await signInPeopleBrowser(props);
	await props.harness.totpAuthenticator.ensureConfirmed(props.email, props.harness.auth);
	return personId;
}
