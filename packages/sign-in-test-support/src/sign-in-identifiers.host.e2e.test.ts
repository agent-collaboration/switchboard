import { oauthClient, session } from '@agent-collaboration/sign-in-core';
import { expect, it } from 'vitest';
import { z } from 'zod';

import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import { expectNoIssuedCredentials } from '#sign-in-test-support/test-fixtures/credential-free-refusal';
import {
	startLocalAuthHarness,
	workspaceOne,
	registeredClientId,
	registrationRequestId,
} from '#sign-in-test-support/test-fixtures/local-auth-harness';
import { readStoredUuidInventory } from '#sign-in-test-support/test-fixtures/stored-uuid-inventory';

useControlledSignInClock();

it('real owner and agent issuance stores only v7 UUIDs while credentials remain opaque and a v4 operation writes nothing', async () => {
	const harness = await startLocalAuthHarness();
	try {
		const owner = await harness.ownerToken();
		const response = await harness.gateway(`/management/workspaces/${workspaceOne}/agents`, {
			method: 'POST',
			headers: { authorization: `Bearer ${owner}`, 'content-type': 'application/json' },
			body: JSON.stringify({ requestId: registrationRequestId, persona: 'operator' }),
		});
		expect(response.status).toBe(200);
		const credential = z
			.object({ clientId: z.literal(registeredClientId), clientSecret: z.string().min(1) })
			.parse(await response.json());
		expect(z.uuid().safeParse(credential.clientSecret).success).toBe(false);
		const sessions = await harness.database.select({ token: session.token }).from(session);
		expect(sessions.length).toBeGreaterThan(0);
		expect(sessions.every((row) => !z.uuid().safeParse(row.token).success)).toBe(true);
		const before = await harness.database.select().from(oauthClient).orderBy(oauthClient.clientId);
		const refused = await harness.gateway(`/management/workspaces/${workspaceOne}/agents`, {
			method: 'POST',
			headers: { authorization: `Bearer ${owner}`, 'content-type': 'application/json' },
			body: JSON.stringify({
				requestId: '11111111-1111-4111-8111-111111111111',
				persona: 'operator',
			}),
		});
		expect(refused.ok).toBe(false);
		expectNoIssuedCredentials(await refused.json());
		expect(await harness.database.select().from(oauthClient).orderBy(oauthClient.clientId)).toEqual(
			before,
		);
		const inventory = await readStoredUuidInventory(harness.database);
		expect(inventory.uuidValues).toBeGreaterThan(0);
		expect(inventory.nonV7Locations).toEqual([]);
		expect(harness.effects).toHaveLength(0);
	} finally {
		await harness.close();
	}
});
