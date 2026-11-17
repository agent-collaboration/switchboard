// Third-party notices: THIRD_PARTY_NOTICES.md#better-auth-ui (repository root).
'use client';

/** Switchboard's passkey management: list, add, rename and remove. Composes
 * Better Auth UI's passkey hooks; removal is supplied by the host because the
 * sign-in service offers its own audited removal route. */
import { Button } from '@agent-collaboration/tool-access-ui/ui/button';
import { Input } from '@agent-collaboration/tool-access-ui/ui/input';
import type { PasskeyAuthClient } from '@better-auth-ui/core/plugins/passkey';
import { useAuth } from '@better-auth-ui/react';
import {
	useAddPasskey,
	useListPasskeys,
	useUpdatePasskey,
} from '@better-auth-ui/react/plugins/passkey';
import { useQueryClient } from '@tanstack/react-query';
import { KeyRound } from 'lucide-react';
import type * as React from 'react';
import { useState } from 'react';

export interface PasskeyManagerProps {
	/** Removes one passkey through the host's removal route. */
	readonly removePasskey: (passkeyId: string) => Promise<void>;
	readonly labels: {
		readonly empty: string;
		readonly add: string;
		readonly rename: string;
		readonly save: string;
		readonly cancel: string;
		readonly remove: string;
		readonly name: string;
		readonly unnamed: string;
		readonly failed: string;
	};
}

const addedOn = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

export function PasskeyManager({ removePasskey, labels }: PasskeyManagerProps): React.ReactElement {
	// The provider is given a client built with passkeyClient(); a typed contract.
	const { authClient: passkeyClient } = useAuth<PasskeyAuthClient>();
	const queryClient = useQueryClient();
	const passkeys = useListPasskeys(passkeyClient);
	const addPasskey = useAddPasskey(passkeyClient);
	const updatePasskey = useUpdatePasskey(passkeyClient);
	const [editing, setEditing] = useState<{ readonly id: string; readonly name: string } | null>(
		null,
	);
	const [failure, setFailure] = useState<string | null>(null);
	const [removingId, setRemovingId] = useState<string | null>(null);

	async function remove(passkeyId: string): Promise<void> {
		setFailure(null);
		setRemovingId(passkeyId);
		try {
			await removePasskey(passkeyId);
			await queryClient.invalidateQueries();
		} catch {
			setFailure(labels.failed);
		} finally {
			setRemovingId(null);
		}
	}

	return (
		<div className="flex flex-col gap-3">
			{passkeys.isSuccess && (passkeys.data ?? []).length === 0 && (
				<p className="text-xs text-muted-foreground">{labels.empty}</p>
			)}
			<ul className="flex flex-col gap-2">
				{(passkeys.data ?? []).map((passkey) => (
					<li key={passkey.id} className="flex flex-col gap-2 rounded-md border border-border p-2">
						{editing?.id === passkey.id ? (
							<form
								className="flex flex-col gap-2"
								onSubmit={(event) => {
									event.preventDefault();
									updatePasskey
										.mutateAsync({ id: passkey.id, name: editing.name.trim() })
										.then(() => setEditing(null))
										.catch(() => setFailure(labels.failed));
								}}
							>
								<Input
									aria-label={labels.name}
									value={editing.name}
									onChange={(event) => setEditing({ id: passkey.id, name: event.target.value })}
									autoFocus
								/>
								<div className="flex gap-2">
									<Button type="submit" variant="outline" disabled={updatePasskey.isPending}>
										{labels.save}
									</Button>
									<Button type="button" variant="ghost" onClick={() => setEditing(null)}>
										{labels.cancel}
									</Button>
								</div>
							</form>
						) : (
							<div className="flex items-center gap-2">
								<KeyRound aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
								<div className="flex min-w-0 flex-1 flex-col">
									<span className="truncate text-sm">{passkey.name ?? labels.unnamed}</span>
									<span className="text-xs text-muted-foreground">
										{addedOn.format(new Date(passkey.createdAt))}
									</span>
								</div>
								<Button
									type="button"
									variant="ghost"
									size="sm"
									onClick={() => setEditing({ id: passkey.id, name: passkey.name ?? '' })}
								>
									{labels.rename}
								</Button>
								<Button
									type="button"
									variant="destructive"
									size="sm"
									disabled={removingId === passkey.id}
									onClick={() => {
										remove(passkey.id).catch(() => undefined);
									}}
								>
									{labels.remove}
								</Button>
							</div>
						)}
					</li>
				))}
			</ul>
			{failure !== null && (
				<p role="alert" className="text-xs text-destructive">
					{failure}
				</p>
			)}
			<Button
				type="button"
				variant="outline"
				disabled={addPasskey.isPending}
				onClick={() => {
					setFailure(null);
					// Better Auth's passkey client resolves { error } (refused options, a
					// cancelled ceremony) rather than throwing, so both paths report.
					addPasskey
						.mutateAsync({})
						.then((result) => {
							if (result.error) setFailure(labels.failed);
						})
						.catch(() => setFailure(labels.failed));
				}}
			>
				{labels.add}
			</Button>
		</div>
	);
}
