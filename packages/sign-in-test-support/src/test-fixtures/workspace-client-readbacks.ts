import {
	oauthClient,
	oauthClientResource,
	oauthResource,
	type SignInDatabase,
} from '@agent-collaboration/sign-in-core';
import { eq, sql } from 'drizzle-orm';

import type { startLocalAuthHarness } from '#sign-in-test-support/test-fixtures/local-auth-harness';
import { storedRowProjection } from '#sign-in-test-support/test-fixtures/stored-row-projection';

export async function readStoredClientCredential(
	database: SignInDatabase,
	clientId: string,
): Promise<unknown> {
	const rows = await database
		.select({ clientSecret: sql`${oauthClient.clientSecret}` })
		.from(oauthClient)
		.where(eq(oauthClient.clientId, clientId))
		.limit(1);
	return rows[0] ?? null;
}

/** Exact issuer rows plus each workspace's admission state, in stable proof order. */
export async function readWorkspaceClientState(
	harness: Awaited<ReturnType<typeof startLocalAuthHarness>>,
	clientId: string,
	workspaceIds: readonly string[],
): Promise<readonly unknown[]> {
	return Promise.all([
		harness.database
			.select(storedRowProjection(oauthClient))
			.from(oauthClient)
			.orderBy(oauthClient.clientId)
			.then((rows) => rows),
		harness.database
			.select(storedRowProjection(oauthResource))
			.from(oauthResource)
			.orderBy(oauthResource.identifier)
			.then((rows) => rows),
		harness.database
			.select(storedRowProjection(oauthClientResource))
			.from(oauthClientResource)
			.orderBy(oauthClientResource.clientId, oauthClientResource.resourceId)
			.then((rows) => rows),
		...workspaceIds.map(async (workspaceId): Promise<unknown> =>
			(await harness.gateway(`/__auth-proof?workspace=${workspaceId}&client=${clientId}`)).json(),
		),
	]);
}
