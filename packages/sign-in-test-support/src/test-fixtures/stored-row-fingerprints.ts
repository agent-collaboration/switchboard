import { createHash } from 'node:crypto';

import { signInSchema } from '@agent-collaboration/sign-in-core';

import type { startLocalAuthHarness } from '#sign-in-test-support/test-fixtures/local-auth-harness';

/** Every column participates, but no code, cookie, secret or identity value is
 * included in failure output. Table and row identity is retained by its hash. */
export function rowFingerprints(rows: readonly unknown[]): readonly string[] {
	return rows
		.map((row) => createHash('sha256').update(JSON.stringify(row)).digest('hex'))
		.toSorted();
}

export async function allSignInRowFingerprints(
	harness: Awaited<ReturnType<typeof startLocalAuthHarness>>,
): Promise<Readonly<Record<string, readonly string[]>>> {
	return Object.fromEntries(
		await Promise.all(
			Object.entries(signInSchema).map(
				async ([name, table]) =>
					[name, rowFingerprints(await harness.database.select().from(table).all())] as const,
			),
		),
	);
}
