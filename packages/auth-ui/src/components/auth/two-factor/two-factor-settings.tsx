// Third-party notices: THIRD_PARTY_NOTICES.md#better-auth-ui (repository root).
'use client';

import { Button } from '@agent-collaboration/tool-access-ui/ui/button';
import { Card, CardContent } from '@agent-collaboration/tool-access-ui/ui/card';
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from '@agent-collaboration/tool-access-ui/ui/empty';
import { Skeleton } from '@agent-collaboration/tool-access-ui/ui/skeleton';
// Keyed by plugin id; the core plugin avoids a view <-> plugin import cycle.
import { twoFactorPlugin } from '@better-auth-ui/core/plugins/two-factor';
import { useAuth, useAuthPlugin, useSession } from '@better-auth-ui/react';
import { cn } from 'cn';
import { ShieldCheck } from 'lucide-react';
import type * as React from 'react';
import { useState } from 'react';

import { DisableTwoFactorDialog } from './disable-two-factor-dialog';
import { EnableTwoFactorDialog } from './enable-two-factor-dialog';
import { RegenerateBackupCodesDialog } from './regenerate-backup-codes-dialog';

export type TwoFactorSettingsProps = {
	className?: string;
};

/**
 * Security-settings card for enrolling in and managing two-factor auth.
 *
 * Reads `user.twoFactorEnabled` from the session — the field the Better Auth
 * two-factor plugin adds — so the card reflects enrollment without an extra
 * request.
 *
 * @param className - Additional CSS classes applied to the card.
 */
export function TwoFactorSettings({ className }: TwoFactorSettingsProps): React.ReactElement {
	const { authClient } = useAuth();
	const { backupCodes: backupCodesEnabled, localization: twoFactorLocalization } =
		useAuthPlugin(twoFactorPlugin);

	const { data: session, isPending } = useSession(authClient);
	const isEnabled = Boolean(
		(session?.user as { twoFactorEnabled?: boolean } | undefined)?.twoFactorEnabled,
	);

	const [enableOpen, setEnableOpen] = useState(false);
	const [disableOpen, setDisableOpen] = useState(false);
	const [regenerateOpen, setRegenerateOpen] = useState(false);

	return (
		<div className={cn('flex flex-col gap-3', className)}>
			<div className="flex items-end justify-between gap-3">
				<h2 className="truncate text-sm font-semibold">{twoFactorLocalization.twoFactor}</h2>

				<Button
					className="shrink-0"
					size="sm"
					variant={isEnabled ? 'destructive' : 'default'}
					disabled={isPending}
					onClick={() => (isEnabled ? setDisableOpen(true) : setEnableOpen(true))}
				>
					{isEnabled
						? twoFactorLocalization.disableTwoFactor
						: twoFactorLocalization.enableTwoFactor}
				</Button>
			</div>

			{!isPending && !isEnabled ? (
				<Card className="p-0">
					<CardContent className="p-0">
						<Empty>
							<EmptyHeader>
								<EmptyMedia variant="icon">
									<ShieldCheck />
								</EmptyMedia>
								<EmptyTitle>{twoFactorLocalization.twoFactorDisabled}</EmptyTitle>
								<EmptyDescription>{twoFactorLocalization.twoFactorDescription}</EmptyDescription>
							</EmptyHeader>
							<EmptyContent>
								<Button size="sm" onClick={() => setEnableOpen(true)}>
									{twoFactorLocalization.enableTwoFactor}
								</Button>
							</EmptyContent>
						</Empty>
					</CardContent>
				</Card>
			) : (
				<Card>
					<CardContent className="flex flex-col gap-4">
						{isPending ? (
							<Skeleton className="h-5 w-48" />
						) : (
							<p className="text-sm font-medium">{twoFactorLocalization.twoFactorEnabled}</p>
						)}

						<p className="text-muted-foreground text-sm">
							{twoFactorLocalization.twoFactorDescription}
						</p>

						{isEnabled && backupCodesEnabled && (
							<Button
								className="self-start"
								size="sm"
								variant="outline"
								onClick={() => setRegenerateOpen(true)}
							>
								{twoFactorLocalization.regenerateBackupCodes}
							</Button>
						)}
					</CardContent>
				</Card>
			)}

			<EnableTwoFactorDialog open={enableOpen} onOpenChange={setEnableOpen} />
			<DisableTwoFactorDialog open={disableOpen} onOpenChange={setDisableOpen} />
			<RegenerateBackupCodesDialog open={regenerateOpen} onOpenChange={setRegenerateOpen} />
		</div>
	);
}
