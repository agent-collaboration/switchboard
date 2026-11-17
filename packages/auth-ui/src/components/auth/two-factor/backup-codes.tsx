// Third-party notices: THIRD_PARTY_NOTICES.md#better-auth-ui (repository root).
'use client';

import { Button } from '@agent-collaboration/tool-access-ui/ui/button';
import { downloadTextFile, formatBackupCodesText, printTextFile } from '@better-auth-ui/core';
// Keyed by plugin id; the core plugin avoids a view <-> plugin import cycle.
import { twoFactorPlugin } from '@better-auth-ui/core/plugins/two-factor';
import { useAuth, useAuthPlugin, useCopyToClipboard } from '@better-auth-ui/react';
import { Check, Copy, Download, Printer } from 'lucide-react';
import type * as React from 'react';
import { toast } from 'sonner';

export type BackupCodesProps = {
	codes: string[];
};

/**
 * One-time display of freshly generated backup codes.
 *
 * The codes are never persisted anywhere on the client. They live in the
 * calling component's state until the dialog closes, so the save actions
 * matter.
 *
 * @param codes - Backup codes returned by enable or regenerate.
 */
export function BackupCodes({ codes }: BackupCodesProps): React.ReactElement {
	const { localization } = useAuth();
	const { localization: twoFactorLocalization } = useAuthPlugin(twoFactorPlugin);
	const { copied, copy } = useCopyToClipboard({
		onError: () => toast.error(twoFactorLocalization.backupCodesCopyFailed),
	});
	const getBackupCodesText = (): string =>
		formatBackupCodesText(codes, twoFactorLocalization, window.location.origin);

	const copyCodes = (): void => {
		copy(getBackupCodesText()).catch(() => undefined);
	};

	return (
		<div className="flex flex-col gap-3">
			<p className="text-muted-foreground text-sm">
				{twoFactorLocalization.backupCodesDescription}
			</p>

			<ul className="grid grid-cols-2 gap-2 rounded-md border bg-muted/40 p-4 font-mono text-sm">
				{codes.map((backupCode) => (
					<li className="tracking-wide" key={backupCode}>
						{backupCode}
					</li>
				))}
			</ul>

			<div className="flex flex-wrap gap-2">
				<Button
					type="button"
					size="sm"
					variant="outline"
					aria-label={
						copied ? twoFactorLocalization.backupCodesCopied : localization.settings.copyToClipboard
					}
					onClick={copyCodes}
				>
					{copied ? <Check data-icon="inline-start" /> : <Copy data-icon="inline-start" />}
					{localization.settings.copyToClipboard}
				</Button>

				<Button
					type="button"
					size="sm"
					variant="outline"
					onClick={() => downloadTextFile(getBackupCodesText(), 'backup-codes.txt')}
				>
					<Download data-icon="inline-start" />
					{twoFactorLocalization.downloadBackupCodes}
				</Button>

				<Button
					type="button"
					size="sm"
					variant="outline"
					onClick={() => printTextFile(getBackupCodesText())}
				>
					<Printer data-icon="inline-start" />
					{twoFactorLocalization.printBackupCodes}
				</Button>
			</div>
		</div>
	);
}
