// Third-party notices: THIRD_PARTY_NOTICES.md#better-auth-ui (repository root).
'use client';

/** Switchboard's inline authenticator-app enrollment: the page's one task, not
 * a dialog. Composes Better Auth UI's enrollment hooks, code field and
 * recovery codes (the upstream EnableTwoFactorDialog stays unchanged). TOTP
 * only, with no password step: accounts are social-only and the server sets
 * `allowPasswordless`. */
import { Field, FieldLabel } from '@agent-collaboration/tool-access-ui/ui/field';
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
} from '@agent-collaboration/tool-access-ui/ui/input-group';
import { createQrCodeSvgData } from '@better-auth-ui/core';
import type { TwoFactorAuthClient } from '@better-auth-ui/core/plugins/two-factor';
import { twoFactorPlugin } from '@better-auth-ui/core/plugins/two-factor';
import { useAuth, useAuthPlugin, useCopyToClipboard } from '@better-auth-ui/react';
import { useEnableTwoFactor, useVerifyTotp } from '@better-auth-ui/react/plugins/two-factor';
import { Check, Copy } from 'lucide-react';
import type * as React from 'react';
import { useMemo, useState } from 'react';

import { submitAuthForm, useAuthForm } from '../auth-form';
import { OtpField } from '../otp-field';
import { BackupCodes } from './backup-codes';

type EnrollmentStage =
	| { readonly kind: 'start' }
	| { readonly kind: 'scan'; readonly totpUri: string; readonly backupCodes: readonly string[] }
	| { readonly kind: 'save-codes'; readonly backupCodes: readonly string[] };

export interface EnableTwoFactorStepProps {
	/** Called after the person confirms they saved the recovery codes. */
	readonly onFinished: () => void;
	readonly labels: {
		readonly start: string;
		readonly startDescription: string;
		readonly scanDescription: string;
		readonly verify: string;
		readonly savedCodes: string;
	};
}

function setupKeyOf(totpUri: string): string | null {
	try {
		return new URL(totpUri).searchParams.get('secret');
	} catch {
		return null;
	}
}

export function EnableTwoFactorStep({
	onFinished,
	labels,
}: EnableTwoFactorStepProps): React.ReactElement {
	// The provider is given a client built with twoFactorClient(); Better Auth's
	// client is a Proxy, so this is a typed contract, not a runtime probe.
	const { authClient: twoFactorClient, localization } = useAuth<TwoFactorAuthClient>();
	const { codeLength, localization: twoFactorLocalization } = useAuthPlugin(twoFactorPlugin);
	const [stage, setStage] = useState<EnrollmentStage>({ kind: 'start' });
	const { copied: setupKeyCopied, copy: copySetupKey } = useCopyToClipboard();

	const { mutateAsync: enableTwoFactor, isPending: isEnabling } = useEnableTwoFactor(
		twoFactorClient,
		{
			onSuccess: (data) => {
				if (data.method === 'totp')
					setStage({ kind: 'scan', totpUri: data.totpURI, backupCodes: data.backupCodes });
			},
		},
	);
	const { mutateAsync: verifyTotp, isPending: isVerifying } = useVerifyTotp(twoFactorClient, {
		onError: () => form.setFieldValue('code', ''),
		onSuccess: () => {
			if (stage.kind === 'scan') setStage({ kind: 'save-codes', backupCodes: stage.backupCodes });
		},
	});
	const isPending = isEnabling || isVerifying;

	const form = useAuthForm({
		defaultValues: { code: '' },
		onSubmit: async ({ value }) => {
			switch (stage.kind) {
				case 'start':
					await enableTwoFactor({ method: 'totp' });
					return;
				case 'scan':
					if (value.code.length === codeLength) await verifyTotp({ code: value.code });
					return;
				case 'save-codes':
					onFinished();
					return;
				default: {
					const unhandled: never = stage;
					throw new Error(`Unhandled enrollment stage: ${JSON.stringify(unhandled)}`);
				}
			}
		},
	});

	const totpUri = stage.kind === 'scan' ? stage.totpUri : '';
	const qrCode = useMemo(() => (totpUri ? createQrCodeSvgData(totpUri) : null), [totpUri]);
	const setupKey = totpUri ? setupKeyOf(totpUri) : null;
	const submitLabel =
		stage.kind === 'start'
			? labels.start
			: stage.kind === 'scan'
				? labels.verify
				: labels.savedCodes;

	return (
		<form.AppForm>
			<form.AuthFormRoot className="flex flex-col gap-6">
				{stage.kind === 'start' && (
					<p className="text-sm text-muted-foreground">{labels.startDescription}</p>
				)}

				{stage.kind === 'scan' && (
					<div className="flex flex-col items-center gap-4">
						<p className="self-start text-sm text-muted-foreground">{labels.scanDescription}</p>
						{qrCode && (
							<svg
								role="img"
								aria-label={twoFactorLocalization.scanQrCode}
								className="size-44 rounded-md border"
								viewBox={`0 0 ${qrCode.size} ${qrCode.size}`}
							>
								<path fill="white" d={`M0 0h${qrCode.size}v${qrCode.size}H0z`} />
								<path fill="black" d={qrCode.path} shapeRendering="crispEdges" />
							</svg>
						)}
						{setupKey && (
							<Field className="w-full gap-1">
								<FieldLabel
									className="text-xs text-muted-foreground"
									htmlFor="two-factor-setup-key"
								>
									{twoFactorLocalization.setupKey}
								</FieldLabel>
								<InputGroup>
									<InputGroupInput
										className="font-mono text-xs"
										id="two-factor-setup-key"
										readOnly
										value={setupKey}
									/>
									<InputGroupAddon align="inline-end">
										<InputGroupButton
											aria-label={
												setupKeyCopied
													? twoFactorLocalization.setupKeyCopied
													: localization.settings.copyToClipboard
											}
											onClick={() => {
												copySetupKey(setupKey).catch(() => undefined);
											}}
											size="icon-xs"
										>
											{setupKeyCopied ? <Check /> : <Copy />}
										</InputGroupButton>
									</InputGroupAddon>
								</InputGroup>
							</Field>
						)}
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
					</div>
				)}

				{stage.kind === 'save-codes' && <BackupCodes codes={[...stage.backupCodes]} />}

				<form.AuthFormServerError />

				<form.Subscribe selector={(state) => state.values.code}>
					{(code) => (
						<form.AuthFormSubmitButton
							className="w-full"
							isPending={isPending}
							disabled={isPending || (stage.kind === 'scan' && code.length !== codeLength)}
						>
							{submitLabel}
						</form.AuthFormSubmitButton>
					)}
				</form.Subscribe>
			</form.AuthFormRoot>
		</form.AppForm>
	);
}
