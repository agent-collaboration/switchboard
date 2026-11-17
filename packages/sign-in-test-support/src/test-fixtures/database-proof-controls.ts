import { oauthClient, type SignInDatabase } from '@agent-collaboration/sign-in-core';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import {
	databaseFaultSchema,
	type DatabaseFault,
} from '#sign-in-test-support/test-fixtures/database-fault-identity';

export interface DatabaseProofControls {
	readonly setDatabaseFault: (input: z.input<typeof databaseFaultSchema> | null) => Promise<void>;
	readonly observeDisableWrites: (clientId: string) => Promise<void>;
	readonly readDisableWrites: () => Promise<readonly { readonly client_id: string }[]>;
}
export function createDatabaseProofControls(props: {
	readonly database: SignInDatabase;
	readonly auth: (pathname: string, init?: RequestInit) => Promise<Response>;
}): DatabaseProofControls {
	const { database, auth } = props;
	async function databaseKeys(clientId: string): Promise<readonly string[]> {
		const rows = await database
			.select({ id: oauthClient.id })
			.from(oauthClient)
			.where(eq(oauthClient.clientId, clientId));
		return rows.map((row) => row.id);
	}
	async function setDatabaseFault(
		input: import('zod').input<typeof databaseFaultSchema> | null,
	): Promise<void> {
		const fault: DatabaseFault | null = input === null ? null : databaseFaultSchema.parse(input);
		if (fault !== null && fault.table === 'oauthClient')
			fault.additionalKeys.push(...(await databaseKeys(fault.key)));
		const response = await auth('/__auth-proof/database-control', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ kind: 'fault', fault }),
		});
		if (!response.ok) throw new Error('Proof driver fault control refused');
	}
	async function observeDisableWrites(clientId: string): Promise<void> {
		const response = await auth('/__auth-proof/database-control', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				kind: 'observe-disable',
				clientId,
				keys: await databaseKeys(clientId),
			}),
		});
		if (!response.ok) throw new Error('Proof driver write observer refused');
	}
	async function readDisableWrites(): Promise<readonly { readonly client_id: string }[]> {
		const response = await auth('/__auth-proof/database-control');
		return z
			.object({ disabledWrites: z.array(z.strictObject({ client_id: z.string() })) })
			.parse(await response.json()).disabledWrites;
	}
	return { setDatabaseFault, observeDisableWrites, readDisableWrites };
}
