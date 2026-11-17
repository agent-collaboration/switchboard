// Third-party notices: THIRD_PARTY_NOTICES.md#better-auth-ui (repository root).
'use client';

// Keyed by plugin id; the core plugin avoids a view <-> plugin import cycle.
import { twoFactorPlugin } from '@better-auth-ui/core/plugins/two-factor';
import { useAuth, useAuthPlugin, useListAccounts } from '@better-auth-ui/react';

export type TwoFactorPasswordRequirement = {
	isPending: boolean;
	requiresPassword: boolean;
};

/**
 * Whether two-factor management should ask for the account password.
 *
 * Better Auth's `allowPasswordless` option only waives the password for
 * accounts that have no credential account — a passkey-only user has no
 * password to type. Reading the linked accounts keeps the UI in step with
 * that rule instead of guessing from the option alone.
 */
export function useTwoFactorPasswordRequirement(): TwoFactorPasswordRequirement {
	const { authClient } = useAuth();
	const { allowPasswordless } = useAuthPlugin(twoFactorPlugin);
	const { data: accounts, isPending } = useListAccounts(authClient);

	const hasCredentialAccount = accounts?.some((account) => account.providerId === 'credential');

	return {
		isPending: allowPasswordless && isPending,
		// Default to asking while the account list loads. Guessing "no password"
		// early would submit an empty body for a credential user and fail the
		// request; guessing "password" costs a passkey-only user nothing, because
		// the field disappears as soon as the list resolves.
		requiresPassword: !allowPasswordless || isPending || Boolean(hasCredentialAccount),
	};
}
