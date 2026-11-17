import { passkey, session, signInAudit, twoFactor } from '@agent-collaboration/sign-in-core';
import { organizationPersonTokenClaimsSchema } from '@agent-collaboration/sign-in-core/person-identity';
import { and, eq } from 'drizzle-orm';
import { jwtVerify } from 'jose';
import { expect, it } from 'vitest';
import { z } from 'zod';

import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import { controlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-sign-in-clock';
import { readCurrentBrowserSession } from '#sign-in-test-support/test-fixtures/current-browser-session';
import { tokenForCurrentOwnerSession } from '#sign-in-test-support/test-fixtures/current-session-owner-token';
import { createObservedProofJwks } from '#sign-in-test-support/test-fixtures/jwks-fetch-observation';
import { startLocalAuthHarness } from '#sign-in-test-support/test-fixtures/local-auth-harness';
import { ensureLocalOwnerOrganization } from '#sign-in-test-support/test-fixtures/local-owner-organization';
import {
	passkeyConfirmationOptionsSchema,
	passkeyPost,
	registerBrowserPasskey,
} from '#sign-in-test-support/test-fixtures/passkey-browser-ceremonies';
import {
	signInConfirmedPeopleBrowser,
	signInPeopleBrowser,
} from '#sign-in-test-support/test-fixtures/people-browser-login';
import { createSoftwarePasskeyAuthenticator } from '#sign-in-test-support/test-fixtures/software-passkey-authenticator';

useControlledSignInClock();
const email = 'owner@example.invalid';

for (const backupState of ['device-bound', 'synced'] as const) {
	it(`people: a ${backupState} passkey confirms the current social session with real UV signatures and its stored method claim`, async () => {
		const harness = await startLocalAuthHarness();
		try {
			const personId = await signInConfirmedPeopleBrowser({ harness, email });
			await ensureLocalOwnerOrganization({ auth: harness.auth, database: harness.database });
			const authenticator = await createSoftwarePasskeyAuthenticator({ backupState });
			expect((await registerBrowserPasskey({ harness, authenticator })).status).toBe(200);
			await signInPeopleBrowser({ harness, email });
			const before = await readCurrentBrowserSession({
				cookie: harness.cookie(),
				database: harness.database,
			});
			expect(before.secondFactorAt).toBeNull();
			const optionsResponse = await passkeyPost(harness, 'confirm-options', {});
			expect(optionsResponse.status).toBe(200);
			const challenge = passkeyConfirmationOptionsSchema.parse(await optionsResponse.json());
			expect(challenge.options.allowCredentials.map((credential) => credential.id)).toEqual([
				authenticator.credentialId,
			]);
			const body = {
				challengeId: challenge.challengeId,
				response: authenticator.authenticationResponse({
					challenge: challenge.options.challenge,
					rpId: challenge.options.rpId,
					origin: harness.issuer,
				}),
			};
			const confirmed = await passkeyPost(harness, 'confirm', body);
			expect(confirmed.status).toBe(200);
			expect(confirmed.headers.getSetCookie()).toEqual([]);
			const after = await readCurrentBrowserSession({
				cookie: harness.cookie(),
				database: harness.database,
			});
			expect(after).toMatchObject({ id: before.id, personId, secondFactorMethod: 'passkey' });
			expect(after.secondFactorAt).not.toBeNull();
			const token = await tokenForCurrentOwnerSession(harness);
			const signed = await jwtVerify(
				token,
				createObservedProofJwks(new URL('/api/auth/jwks', harness.issuer)),
				{
					issuer: harness.issuer,
					audience: harness.target.managementAudience,
				},
			);
			const claims = organizationPersonTokenClaimsSchema.parse(signed.payload);
			expect(claims.sid).toBe(before.id);
			expect(claims.second_factor_method).toBe('passkey');
			expect(Object.hasOwn(signed.payload, 'amr')).toBe(false);
			expect(claims.second_factor_at).toBe(
				Math.floor(z.number().parse(after.secondFactorAt) / 1000),
			);
			expect((await passkeyPost(harness, 'confirm', body)).status).toBe(401);
			expect(
				await readCurrentBrowserSession({ cookie: harness.cookie(), database: harness.database }),
			).toEqual(after);
		} finally {
			await harness.close();
		}
	});
}

it('people: valid passkey signatures without UV cannot register or confirm, and passkey sign-in remains unoffered', async () => {
	const harness = await startLocalAuthHarness();
	try {
		const personId = await signInConfirmedPeopleBrowser({ harness, email });
		const rejected = await createSoftwarePasskeyAuthenticator();
		expect(
			(await registerBrowserPasskey({ harness, authenticator: rejected, userVerified: false }))
				.status,
		).toBe(403);
		expect(
			await harness.database
				.select({ id: passkey.id })
				.from(passkey)
				.where(eq(passkey.userId, personId)),
		).toEqual([]);
		const authenticator = await createSoftwarePasskeyAuthenticator();
		expect((await registerBrowserPasskey({ harness, authenticator })).status).toBe(200);
		await signInPeopleBrowser({ harness, email });
		const before = await readCurrentBrowserSession({
			cookie: harness.cookie(),
			database: harness.database,
		});
		const challenge = passkeyConfirmationOptionsSchema.parse(
			await (await passkeyPost(harness, 'confirm-options', {})).json(),
		);
		expect(
			(
				await passkeyPost(harness, 'confirm', {
					challengeId: challenge.challengeId,
					response: authenticator.authenticationResponse({
						challenge: challenge.options.challenge,
						rpId: challenge.options.rpId,
						origin: harness.issuer,
						userVerified: false,
					}),
				})
			).status,
		).toBe(401);
		expect(
			await readCurrentBrowserSession({ cookie: harness.cookie(), database: harness.database }),
		).toEqual(before);
		expect((await harness.auth('/api/auth/passkey/generate-authenticate-options')).status).toBe(
			404,
		);
		expect((await passkeyPost(harness, 'verify-authentication', { response: {} })).status).toBe(
			404,
		);
	} finally {
		await harness.close();
	}
});

it('people: a passkey challenge is bound to the actual social session and expires on the injected clock', async () => {
	const harness = await startLocalAuthHarness();
	try {
		await signInConfirmedPeopleBrowser({ harness, email });
		const authenticator = await createSoftwarePasskeyAuthenticator();
		expect((await registerBrowserPasskey({ harness, authenticator })).status).toBe(200);
		const challenge = passkeyConfirmationOptionsSchema.parse(
			await (await passkeyPost(harness, 'confirm-options', {})).json(),
		);
		const body = {
			challengeId: challenge.challengeId,
			response: authenticator.authenticationResponse({
				challenge: challenge.options.challenge,
				rpId: challenge.options.rpId,
				origin: harness.issuer,
			}),
		};
		await signInPeopleBrowser({ harness, email });
		const before = await readCurrentBrowserSession({
			cookie: harness.cookie(),
			database: harness.database,
		});
		expect((await passkeyPost(harness, 'confirm', body)).status).toBe(401);
		expect(
			await readCurrentBrowserSession({ cookie: harness.cookie(), database: harness.database }),
		).toEqual(before);
		const ownChallenge = passkeyConfirmationOptionsSchema.parse(
			await (await passkeyPost(harness, 'confirm-options', {})).json(),
		);
		const expiresAt = controlledSignInClock.now() + 300_000;
		expect(
			(
				await harness.auth('/__auth-proof/set-clock', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ milliseconds: expiresAt }),
				})
			).status,
		).toBe(200);
		expect(
			(
				await passkeyPost(harness, 'confirm', {
					challengeId: ownChallenge.challengeId,
					response: authenticator.authenticationResponse({
						challenge: ownChallenge.options.challenge,
						rpId: ownChallenge.options.rpId,
						origin: harness.issuer,
					}),
				})
			).status,
		).toBe(401);
		expect(
			await readCurrentBrowserSession({ cookie: harness.cookie(), database: harness.database }),
		).toEqual(before);
	} finally {
		await harness.close();
	}
});

it('people: a recorded passkey permits app replacement and the remaining passkey still confirms before re-enrollment rotates', async () => {
	const harness = await startLocalAuthHarness();
	try {
		const personId = await signInConfirmedPeopleBrowser({ harness, email });
		const authenticator = await createSoftwarePasskeyAuthenticator();
		expect((await registerBrowserPasskey({ harness, authenticator })).status).toBe(200);
		expect(
			(
				await harness.auth('/api/auth/two-factor/remove-app', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: '{}',
				})
			).status,
		).toBe(200);
		expect(
			await harness.database
				.select({ id: twoFactor.id })
				.from(twoFactor)
				.where(eq(twoFactor.userId, personId)),
		).toEqual([]);
		await signInPeopleBrowser({ harness, email });
		const before = await readCurrentBrowserSession({
			cookie: harness.cookie(),
			database: harness.database,
		});
		const challenge = passkeyConfirmationOptionsSchema.parse(
			await (await passkeyPost(harness, 'confirm-options', {})).json(),
		);
		expect(
			(
				await passkeyPost(harness, 'confirm', {
					challengeId: challenge.challengeId,
					response: authenticator.authenticationResponse({
						challenge: challenge.options.challenge,
						rpId: challenge.options.rpId,
						origin: harness.issuer,
					}),
				})
			).status,
		).toBe(200);
		expect((await harness.totpAuthenticator.enrollApp(email, harness.auth)).status).toBe(200);
		expect((await harness.totpAuthenticator.confirmApp(email, harness.auth)).status).toBe(200);
		const after = await readCurrentBrowserSession({
			cookie: harness.cookie(),
			database: harness.database,
		});
		expect(after.id).not.toBe(before.id);
		expect(after.secondFactorMethod).toBe('app');
		expect(
			await harness.database
				.select({ id: session.id })
				.from(session)
				.where(eq(session.id, before.id)),
		).toEqual([]);
		expect(
			await harness.database
				.select({ phase: signInAudit.phase })
				.from(signInAudit)
				.where(
					and(eq(signInAudit.actorUserId, personId), eq(signInAudit.changeKind, 'app-removed')),
				)
				.orderBy(signInAudit.phase),
		).toEqual([{ phase: 'intent' }, { phase: 'outcome' }]);
	} finally {
		await harness.close();
	}
});
