import { oauthClient, type SignInDatabase } from '@agent-collaboration/sign-in-core';
import type { AuthTarget } from '@agent-collaboration/sign-in-owner-cli';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { navigateLocalBrowser } from '#sign-in-test-support/test-fixtures/browser-navigation';
import type { createGoogleOAuthProtocol } from '#sign-in-test-support/test-fixtures/google-oauth-protocol';
import {
	ensureLocalOwnerOrganization,
	acceptLocalInvitations,
} from '#sign-in-test-support/test-fixtures/local-owner-organization';
import { loginThroughNativeOwnerCli } from '#sign-in-test-support/test-fixtures/native-cli-proof';
import type { NativeOwnerCliProfile } from '#sign-in-test-support/test-fixtures/native-owner-cli-profile';
import type { SoftwareTotpAuthenticator } from '#sign-in-test-support/test-fixtures/software-totp-authenticator';

/** The existing owner/browser/CLI journey, with a real verified social start. */
export async function loginLocalPerson(props: {
	readonly target: AuthTarget;
	readonly repositoryRoot: string;
	readonly issuer: string;
	readonly email: string;
	readonly verified: boolean;
	readonly auth: (pathname: string, init?: RequestInit) => Promise<Response>;
	readonly database: SignInDatabase;
	readonly google: Awaited<ReturnType<typeof createGoogleOAuthProtocol>>;
	readonly cookies: () => readonly string[];
	readonly captchaToken: () => string;
	readonly totpAuthenticator: SoftwareTotpAuthenticator;
	readonly profile?: NativeOwnerCliProfile;
}): Promise<string> {
	const { target, issuer, email, verified, auth, database, google } = props;
	process.stderr.write('[auth-harness] owner login started\n');
	return loginThroughNativeOwnerCli({
		target,
		repositoryRoot: props.repositoryRoot,
		...(props.profile === undefined ? {} : { profile: props.profile }),
		browser: async (url: string): Promise<readonly string[]> => {
			const authorization = new URL(new URL(url).searchParams.get('authorize') ?? 'invalid:');
			const signin = await auth('/api/auth/sign-in/social', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'x-captcha-response': props.captchaToken(),
				},
				body: JSON.stringify({
					provider: 'google',
					callbackURL: new URL('/owner-ready', issuer).toString(),
				}),
			});
			if (!signin.ok) throw new Error('Real provider sign-in initiation refused');
			process.stderr.write('[auth-harness] provider sign-in initiated\n');
			const providerUrl = z.object({ url: z.url() }).parse(await signin.json()).url;
			const callback = google.authorize(new URL(providerUrl), email, verified);
			const admitted = await auth(callback.toString(), {
				headers: { 'sec-fetch-mode': 'navigate', accept: 'text/html' },
			});
			if (admitted.status !== 302) throw new Error('Real owner callback refused');
			process.stderr.write('[auth-harness] provider callback completed\n');
			await props.totpAuthenticator.ensureConfirmed(email, auth);
			if (email === 'owner@example.invalid') {
				await ensureLocalOwnerOrganization({ auth, database });
				const bootstrap = await auth('/api/auth/owner/bootstrap', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: '{}',
				});
				if (!bootstrap.ok) {
					const shape = await database
						.select({
							grantTypes: sql`json_type(${oauthClient.grantTypes})`,
							redirectUris: sql`json_type(${oauthClient.redirectUris})`,
						})
						.from(oauthClient)
						.where(eq(oauthClient.clientId, target.ownerCliClientId));
					const result = z
						.object({
							kind: z.enum(['complete', 'incomplete']).optional(),
							error: z.enum(['not-allowed', 'sign-in-unavailable']).optional(),
						})
						.safeParse(await bootstrap.clone().json());
					throw new Error(
						`Real fixed owner-client bootstrap refused: status=${bootstrap.status}; result=${JSON.stringify(result.success ? result.data : {})}; metadataShape=${JSON.stringify(shape)}`,
					);
				}
				process.stderr.write('[auth-harness] owner client bootstrap completed\n');
			}
			if (email !== 'owner@example.invalid')
				await acceptLocalInvitations({ auth, database, email });
			const authorized = await auth(authorization.toString(), {
				headers: { 'sec-fetch-mode': 'navigate', accept: 'text/html' },
			});
			const location = authorized.headers.get('location');
			if (location === null) {
				const body = z.record(z.string(), z.unknown()).safeParse(await authorized.clone().json());
				const returnUrl =
					body.success && typeof body.data.url === 'string' ? new URL(body.data.url, issuer) : null;
				process.stderr.write(
					JSON.stringify({
						event: 'authorization-response',
						status: authorized.status,
						contentType: authorized.headers.get('content-type'),
						bodyKeys: body.success ? Object.keys(body.data).toSorted() : [],
						redirect: body.success && body.data.redirect === true,
						codePresent: returnUrl?.searchParams.has('code') ?? false,
						error:
							body.success &&
							typeof body.data.error === 'string' &&
							/^[a-z_]+$/u.test(body.data.error)
								? body.data.error
								: null,
						redirectError: returnUrl?.searchParams.get('error') ?? null,
					}) + '\n',
				);
				throw new Error('Real native authorization did not return a code');
			}
			const completed = await navigateLocalBrowser(location);
			if (!completed.ok) throw new Error('Real native CLI loopback callback refused');
			return [new URL(location).searchParams.get('code') ?? '', ...props.cookies()];
		},
	});
}
