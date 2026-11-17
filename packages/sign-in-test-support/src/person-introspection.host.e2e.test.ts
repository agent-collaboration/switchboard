import { member, oauthClient, session } from '@agent-collaboration/sign-in-core';
import { and, eq } from 'drizzle-orm';
import { decodeJwt } from 'jose';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import { controlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-sign-in-clock';
import { startLocalAuthHarness } from '#sign-in-test-support/test-fixtures/local-auth-harness';
import {
	personConfirmationProbeHeader,
	personConfirmationProbeSchema,
	personConfirmationObservationSchema,
	type PersonConfirmationProbe,
} from '#sign-in-test-support/test-fixtures/person-confirmation-proof';

useControlledSignInClock();
type Harness = Awaited<ReturnType<typeof startLocalAuthHarness>>;
const clientSchema = z.strictObject({ clientId: z.string(), clientSecret: z.string() });
type Client = z.infer<typeof clientSchema>;

async function createConfidentialCaller(harness: Harness): Promise<Client> {
	const response = await harness.auth('/__auth-proof/introspection-client', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ kind: 'create' }),
	});
	expect(response.status).toBe(200);
	const client = clientSchema.parse(await response.json());
	const [registered] = await harness.database
		.select({ method: oauthClient.tokenEndpointAuthMethod, disabled: oauthClient.disabled })
		.from(oauthClient)
		.where(eq(oauthClient.clientId, client.clientId));
	expect(registered).toEqual({ method: 'client_secret_basic', disabled: false });
	return client;
}

function introspect(
	harness: Harness,
	token: string,
	authentication?: {
		readonly authorization?: string;
		readonly clientId?: string;
		readonly confirmationProbe?: PersonConfirmationProbe;
	},
): Promise<Response> {
	return harness.auth('/api/auth/oauth2/introspect', {
		method: 'POST',
		headers: {
			'content-type': 'application/x-www-form-urlencoded',
			...(authentication?.authorization === undefined
				? {}
				: { authorization: authentication.authorization }),
			...(authentication?.confirmationProbe === undefined
				? {}
				: { [personConfirmationProbeHeader]: JSON.stringify(authentication.confirmationProbe) }),
		},
		body: new URLSearchParams({
			token,
			...(authentication?.clientId === undefined ? {} : { client_id: authentication.clientId }),
		}),
	});
}
function credentials(client: Client): { readonly authorization: string } {
	return { authorization: `Basic ${btoa(`${client.clientId}:${client.clientSecret}`)}` };
}
async function expectClientRefused(response: Response): Promise<void> {
	expect(response.status).toBe(401);
	const body = z.record(z.string(), z.unknown()).parse(await response.json());
	expect(body.error).toBe('invalid_client');
	for (const claim of ['active', 'sub', 'sid', 'aud', 'exp', 'checkedAt', 'email'])
		expect(body).not.toHaveProperty(claim);
}

describe('real client-authenticated Person introspection', () => {
	it('takes checkedAt at the first real confirmation read, after provider work and before later awaited work', async () => {
		const harness = await startLocalAuthHarness();
		let sessionId: string | undefined;
		try {
			const token = await harness.ownerToken();
			const claims = z.object({ sid: z.uuidv7() }).parse(decodeJwt(token));
			sessionId = claims.sid;
			const client = await createConfidentialCaller(harness);
			const armed = await harness.auth(`/__auth-proof/confirmation-hold/arm?key=${sessionId}`, {
				method: 'POST',
			});
			expect(armed.status).toBe(200);
			const pending = introspect(harness, token, {
				...credentials(client),
				confirmationProbe: personConfirmationProbeSchema.parse({
					sessionId,
					advanceBeforeReadMilliseconds: 10_000,
				}),
			});
			const entered = await harness.auth(
				`/__auth-proof/confirmation-hold/entered?key=${sessionId}`,
			);
			expect(entered.status).toBe(200);
			const firstRead = personConfirmationObservationSchema.parse(await entered.json());
			expect(firstRead.sessionId).toBe(sessionId);
			expect(firstRead.checkedAt).toBe(controlledSignInClock.now() + 10_000);
			const moved = await harness.auth('/__auth-proof/set-clock', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ milliseconds: firstRead.checkedAt + 60_000 }),
			});
			expect(moved.status).toBe(200);
			const released = await harness.auth(
				`/__auth-proof/confirmation-hold/release?key=${sessionId}`,
				{ method: 'POST' },
			);
			expect(released.status).toBe(200);
			const active = await pending;
			expect(active.status).toBe(200);
			expect(await active.json()).toMatchObject({
				active: true,
				sid: sessionId,
				checkedAt: firstRead.checkedAt,
			});
		} finally {
			if (sessionId !== undefined)
				await harness.auth(`/__auth-proof/confirmation-hold/release?key=${sessionId}`, {
					method: 'POST',
				});
			await harness.close();
		}
	});
	it('refuses missing credentials, the wrong secret, a public client and a disabled confidential client without identity claims', async () => {
		const harness = await startLocalAuthHarness();
		try {
			const token = await harness.ownerToken();
			const client = await createConfidentialCaller(harness);
			await expectClientRefused(await introspect(harness, token));
			await expectClientRefused(
				await introspect(
					harness,
					token,
					credentials({ ...client, clientSecret: 'incorrect-client-secret' }),
				),
			);
			await expectClientRefused(
				await introspect(harness, token, { clientId: harness.target.ownerCliClientId }),
			);
			const disabled = await harness.auth('/__auth-proof/introspection-client', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ kind: 'disable', clientId: client.clientId }),
			});
			expect(disabled.status).toBe(200);
			expect(
				await harness.database
					.select({ disabled: oauthClient.disabled })
					.from(oauthClient)
					.where(eq(oauthClient.clientId, client.clientId)),
			).toEqual([{ disabled: true }]);
			await expectClientRefused(await introspect(harness, token, credentials(client)));
		} finally {
			await harness.close();
		}
	});

	it.each(['revoked-session', 'removed-person', 'expired-token'])(
		'returns active then privacy-preserving inactive after %s',
		async (change) => {
			const harness = await startLocalAuthHarness();
			try {
				const token = await harness.ownerToken();
				const claims = z
					.object({
						sub: z.uuidv7(),
						sid: z.uuidv7(),
						organization_id: z.uuidv7(),
						exp: z.number().int(),
					})
					.parse(decodeJwt(token));
				const client = await createConfidentialCaller(harness);
				const active = await introspect(harness, token, credentials(client));
				expect(active.status).toBe(200);
				expect(await active.json()).toMatchObject({
					active: true,
					sub: claims.sub,
					sid: claims.sid,
					aud: harness.target.managementAudience,
					exp: claims.exp,
					checkedAt: controlledSignInClock.now(),
				});
				if (change === 'revoked-session')
					await harness.database.delete(session).where(eq(session.id, claims.sid));
				else if (change === 'removed-person')
					await harness.database
						.delete(member)
						.where(
							and(eq(member.userId, claims.sub), eq(member.organizationId, claims.organization_id)),
						);
				else {
					const advanced = await harness.auth('/__auth-proof/set-clock', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ milliseconds: claims.exp * 1000 + 1 }),
					});
					expect(advanced.status).toBe(200);
				}
				const inactive = await introspect(harness, token, credentials(client));
				expect(inactive.status).toBe(200);
				expect(await inactive.json()).toEqual({ active: false });
			} finally {
				await harness.close();
			}
		},
	);
});
