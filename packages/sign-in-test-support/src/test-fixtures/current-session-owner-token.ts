import { fileURLToPath } from 'node:url';

import type { EpochMilliseconds } from '@agent-collaboration/sign-in-core';

import { navigateLocalBrowser } from '#sign-in-test-support/test-fixtures/browser-navigation';
import type { startLocalAuthHarness } from '#sign-in-test-support/test-fixtures/local-auth-harness';
import { loginThroughNativeOwnerCli } from '#sign-in-test-support/test-fixtures/native-cli-proof';
import type { NativeOwnerCliProfile } from '#sign-in-test-support/test-fixtures/native-owner-cli-profile';

/** The delivered CLI exchanges a code for the browser session already under
 * observation, so another social sign-in cannot replace the session being proved. */
export async function tokenForCurrentOwnerSession(
	harness: Awaited<ReturnType<typeof startLocalAuthHarness>>,
	nowMilliseconds?: EpochMilliseconds,
): Promise<string> {
	const bootstrap = await harness.auth('/api/auth/owner/bootstrap', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: '{}',
	});
	if (!bootstrap.ok) throw new Error('Current owner session bootstrap refused');
	const profile =
		nowMilliseconds === undefined
			? undefined
			: ({
					kind: 'clock',
					nowMilliseconds,
					authorization: 'force-auth',
				} satisfies NativeOwnerCliProfile);
	return loginThroughNativeOwnerCli({
		...(profile === undefined ? {} : { profile }),
		target: harness.target,
		repositoryRoot: fileURLToPath(new URL('../../../../', import.meta.url)),
		browser: async (url) => {
			const authorization = new URL(new URL(url).searchParams.get('authorize') ?? 'invalid:');
			const authorized = await harness.auth(authorization.toString(), {
				headers: { 'sec-fetch-mode': 'navigate', accept: 'text/html' },
			});
			const location = authorized.headers.get('location');
			if (location === null) throw new Error('Current session authorization returned no code');
			const completed = await navigateLocalBrowser(location);
			if (!completed.ok) throw new Error('Native current-session loopback refused');
			return [new URL(location).searchParams.get('code') ?? '', ...harness.cookie().split('; ')];
		},
	});
}
