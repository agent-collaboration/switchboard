// Third-party notices: THIRD_PARTY_NOTICES.md#better-auth-ui (repository root).
import { TwoFactorChallenge } from '@auth-ui/components/auth/two-factor/two-factor-challenge';
import { TwoFactorSettings } from '@auth-ui/components/auth/two-factor/two-factor-settings';
import { createAuthPlugin } from '@better-auth-ui/core';
import {
	twoFactorPlugin as coreTwoFactorPlugin,
	type TwoFactorPluginOptions,
} from '@better-auth-ui/core/plugins/two-factor';

export const twoFactorPlugin = createAuthPlugin(
	coreTwoFactorPlugin.id,
	(options: TwoFactorPluginOptions = {}) => ({
		...coreTwoFactorPlugin(options),
		securityCards: [TwoFactorSettings],
		views: {
			auth: { twoFactor: TwoFactorChallenge },
		},
	}),
);
