// Third-party notices: THIRD_PARTY_NOTICES.md#better-auth-ui (repository root).
'use client';

// Adapted from Better Auth UI (MIT), better-auth-ui@2b028ec5,
// examples/start-shadcn-baseui-example/src/components/auth/passkey/passkey-button.tsx.
// Modified: explicit return type; imports mapped to Switchboard primitives.

import { Button } from '@agent-collaboration/tool-access-ui/ui/button';
import { Spinner } from '@agent-collaboration/tool-access-ui/ui/spinner';
import { type AuthView, authMutationKeys, authQueryKeys } from '@better-auth-ui/core';
import type { PasskeyAuthClient } from '@better-auth-ui/core/plugins/passkey';
import { passkeyPlugin } from '@better-auth-ui/core/plugins/passkey';
import { useAuth, useAuthPlugin } from '@better-auth-ui/react';
import { usePasskeyAutoFill, useSignInPasskey } from '@better-auth-ui/react/plugins/passkey';
import { useIsMutating, useQueryClient } from '@tanstack/react-query';
import { cn } from 'cn';
import { Fingerprint } from 'lucide-react';
import { useCallback, useMemo, type ReactElement } from 'react';

export type PasskeyButtonProps = {
	/** @remarks `AuthView` */
	view?: AuthView;
};

/**
 * "Continue with Passkey" button rendered alongside the password sign-in form.
 *
 * Hidden on the sign-up view where passkey sign-in isn't applicable.
 *
 * @param view - Current auth view. Hides the button on `"signUp"`.
 */
export function PasskeyButton({ view }: PasskeyButtonProps): ReactElement | null {
	const { authClient, localization, redirectTo, navigate } = useAuth<PasskeyAuthClient>();
	const { localization: passkeyLocalization } = useAuthPlugin(passkeyPlugin);
	const queryClient = useQueryClient();

	const handleSuccess = useCallback(async () => {
		await queryClient.invalidateQueries(
			{ queryKey: authQueryKeys.session },
			{ cancelRefetch: false },
		);
		navigate({ to: redirectTo });
	}, [navigate, queryClient, redirectTo]);
	const fetchOptions = useMemo(() => ({ onSuccess: handleSuccess }), [handleSuccess]);

	const { mutate: signInPasskey, isPending: passkeyPending } = useSignInPasskey(authClient);

	// Surface passkeys in the browser's autofill dropdown on every view where
	// this button is shown.
	usePasskeyAutoFill(authClient, {
		enabled: view !== 'signUp',
		fetchOptions,
	});

	const signInMutating = useIsMutating({
		mutationKey: authMutationKeys.signIn.all,
	});
	const signUpMutating = useIsMutating({
		mutationKey: authMutationKeys.signUp.all,
	});
	const isPending = signInMutating + signUpMutating > 0;

	// Passkey sign-in isn't relevant on the sign-up flow.
	if (view === 'signUp') return null;

	return (
		<Button
			type="button"
			variant="outline"
			disabled={isPending}
			className={cn('w-full', isPending && 'pointer-events-none opacity-50')}
			onClick={() => signInPasskey({ autoFill: false, fetchOptions })}
		>
			{passkeyPending ? <Spinner /> : <Fingerprint />}
			{localization.auth.continueWith.replace('{{provider}}', passkeyLocalization.passkey)}
		</Button>
	);
}
