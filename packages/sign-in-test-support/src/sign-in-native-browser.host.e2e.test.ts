import { expect, it } from 'vitest';

import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import { observeNativeFactorBrowser } from '#sign-in-test-support/test-fixtures/native-browser-scenario';
import {
	observeNativePasskeyBrowser,
	passkeyCliCancellationReason,
} from '#sign-in-test-support/test-fixtures/native-passkey-browser-scenario';
import { runProofBrowserScenario } from '#sign-in-test-support/test-fixtures/playwright-browser';

const hosts = ['node', 'cloudflare'] as const;
const passkeyCases = ['journey', 'no-user-verification', 'cli-login', 'script-failure'] as const;
useControlledSignInClock();

it.each(hosts)('F native Better Auth factor and owner pages on %s', async (host): Promise<void> => {
	await runProofBrowserScenario((signal) => observeNativeFactorBrowser(host, signal));
});

it.each(hosts.flatMap((host) => passkeyCases.map((scenario) => [scenario, host] as const)))(
	'passkey %s on %s',
	async (scenario, host): Promise<void> => {
		await runProofBrowserScenario((signal) => observeNativePasskeyBrowser(host, scenario, signal));
	},
);

it.each(hosts)(
	'passkey CLI cancellation closes the owning scenario on %s',
	async (host): Promise<void> => {
		await expect(
			runProofBrowserScenario((signal) =>
				observeNativePasskeyBrowser(host, 'cli-login', signal, true),
			),
		).rejects.toThrow(passkeyCliCancellationReason);
	},
);
