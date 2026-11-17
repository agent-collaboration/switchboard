// Third-party notices: THIRD_PARTY_NOTICES.md#better-auth-ui (repository root).
'use client';

/** Switchboard's confirm-it's-you step before a change: an authenticator code
 * first, a recovery code as the alternative. Composes Better Auth UI's verify
 * hooks, code field and auth form; the server records the confirmation. */
import { Button } from '@agent-collaboration/tool-access-ui/ui/button';
import type { TwoFactorAuthClient } from '@better-auth-ui/core/plugins/two-factor';
import { twoFactorPlugin } from '@better-auth-ui/core/plugins/two-factor';
import { useAuth, useAuthPlugin } from '@better-auth-ui/react';
import { useVerifyBackupCode, useVerifyTotp } from '@better-auth-ui/react/plugins/two-factor';
import type * as React from 'react';
import { useState } from 'react';

import { submitAuthForm, useAuthForm } from '../auth-form';
import { OtpField } from '../otp-field';

type ConfirmationMethod = 'app-code' | 'recovery-code';

export interface ConfirmSecondFactorStepProps {
	/** Called once the server has accepted the confirmation. */
	readonly onConfirmed: () => void;
	readonly labels: {
		readonly appCodeDescription: string;
		readonly confirm: string;
		readonly recoveryCode: string;
		readonly recoveryCodeDescription: string;
		readonly useRecoveryCode: string;
		readonly useAppCode: string;
	};
}

export function ConfirmSecondFactorStep({
	onConfirmed,
	labels,
}: ConfirmSecondFactorStepProps): React.ReactElement {
	// The provider is given a client built with twoFactorClient(); Better Auth's
	// client is a Proxy, so this is a typed contract, not a runtime probe.
	const { authClient: twoFactorClient } = useAuth<TwoFactorAuthClient>();
	const { codeLength, localization: twoFactorLocalization } = useAuthPlugin(twoFactorPlugin);
	const [method, setMethod] = useState<ConfirmationMethod>('app-code');
	const { mutateAsync: verifyTotp, isPending: isVerifyingAppCode } = useVerifyTotp(
		twoFactorClient,
		{ onError: () => form.setFieldValue('code', ''), onSuccess: onConfirmed },
	);
	const { mutateAsync: verifyBackupCode, isPending: isVerifyingRecoveryCode } = useVerifyBackupCode(
		twoFactorClient,
		{ onSuccess: onConfirmed },
	);
	const isPending = isVerifyingAppCode || isVerifyingRecoveryCode;

	const form = useAuthForm({
		defaultValues: { code: '' },
		onSubmit: async ({ value }) => {
			if (method === 'app-code') {
				if (value.code.length === codeLength) await verifyTotp({ code: value.code });
				return;
			}
			await verifyBackupCode({ code: value.code.trim() });
		},
	});

	return (
		<form.AppForm>
			<form.AuthFormRoot className="flex flex-col gap-4">
				{method === 'app-code' ? (
					<>
						<p className="text-sm text-muted-foreground">{labels.appCodeDescription}</p>
						<form.AppField name="code">
							{(field) => (
								<OtpField
									autoFocus
									className="w-full"
									disabled={isPending}
									label={twoFactorLocalization.authenticatorCode}
									length={codeLength}
									name={field.name}
									value={field.state.value}
									onChange={field.handleChange}
									onComplete={() => {
										submitAuthForm(form).catch(() => undefined);
									}}
								/>
							)}
						</form.AppField>
					</>
				) : (
					<>
						<p className="text-sm text-muted-foreground">{labels.recoveryCodeDescription}</p>
						<form.AppField name="code">
							{(field) => (
								<field.AuthFormTextField
									label={labels.recoveryCode}
									autoComplete="off"
									disabled={isPending}
								/>
							)}
						</form.AppField>
					</>
				)}

				<form.AuthFormServerError />

				<form.Subscribe selector={(state) => state.values.code}>
					{(code) => (
						<form.AuthFormSubmitButton
							className="w-full"
							isPending={isPending}
							disabled={
								isPending ||
								(method === 'app-code' ? code.length !== codeLength : code.trim().length === 0)
							}
						>
							{labels.confirm}
						</form.AuthFormSubmitButton>
					)}
				</form.Subscribe>

				<Button
					type="button"
					variant="link"
					className="self-center text-muted-foreground"
					disabled={isPending}
					onClick={() => {
						form.setFieldValue('code', '');
						setMethod(method === 'app-code' ? 'recovery-code' : 'app-code');
					}}
				>
					{method === 'app-code' ? labels.useRecoveryCode : labels.useAppCode}
				</Button>
			</form.AuthFormRoot>
		</form.AppForm>
	);
}
