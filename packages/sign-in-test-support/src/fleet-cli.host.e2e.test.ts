import {
	fleetAdminIntentDigest,
	fleetAdminProofKeyThumbprint,
	personOrganizationAuthorizationRevisions as personFence,
	session as sessionTable,
	signFleetAdminProof,
} from '@agent-collaboration/sign-in-core';
import {
	createMemoryProofKeyStore,
	refreshFleetCli,
	runFleetAdminCommand,
	selectProofKeyStore,
	signInFleetCli,
	type FleetCliSession,
} from '@agent-collaboration/sign-in-owner-cli';
import { eq } from 'drizzle-orm';
import { calculateJwkThumbprint, decodeJwt, jwtVerify } from 'jose';
import { expect, it } from 'vitest';
import { z } from 'zod';

import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import { expectNoIssuedCredentials } from '#sign-in-test-support/test-fixtures/credential-free-refusal';
import {
	createRequest,
	fakeSecurityRunner,
	initialTime,
	ownerEmail,
	publicKeys,
	setupFleetCli,
	sha256,
} from '#sign-in-test-support/test-fixtures/fleet-cli-fixture';
import { webSignInCrypto } from '#sign-in-test-support/test-fixtures/recording-sign-in-capabilities';

useControlledSignInClock();

it('fleet CLI: loopback sign-in binds the token and refresh credential to the CLI key; commands go through the relay; refresh needs no browser', async () => {
	// Arrange
	const fixture = await setupFleetCli();
	const { harness, target, io } = fixture;
	try {
		const store = createMemoryProofKeyStore(webSignInCrypto);
		// Act: sign in, create through the relay, then refresh.
		const session = await signInFleetCli({ target, store, io });
		const operation = createRequest(fixture);
		const created = await runFleetAdminCommand({
			target,
			store,
			session,
			operation,
			io,
			confirmSecondFactor: async () => {
				throw new Error('no step-up expected');
			},
		});
		const heldAfterSignIn = await store.load();
		const refreshed = await refreshFleetCli({ target, store, io });
		const heldAfterRefresh = await store.load();
		// Assert: the issuer signed both tokens, for the admin audience, bound to this key.
		const thumbprint = await calculateJwkThumbprint(session.key.publicJwk, 'sha256');
		expect(await fleetAdminProofKeyThumbprint(webSignInCrypto, session.key)).toBe(thumbprint);
		const keys = await publicKeys(harness);
		for (const token of [session.accessToken, refreshed?.accessToken ?? '']) {
			const verified = await jwtVerify(token, keys, {
				issuer: harness.issuer,
				audience: target.centralAdminAudience,
				typ: 'at+jwt',
				currentDate: new Date(initialTime),
			});
			expect(verified.payload).toMatchObject({
				token_profile: 'person-fleet',
				client_id: target.ownerFleetCliClientId,
				cnf: { jkt: thumbprint },
			});
		}
		expect(refreshed?.accessToken).not.toBe(session.accessToken);
		expect(fixture.browserVisits()).toBe(1);
		expect(heldAfterSignIn?.refreshToken).toEqual(expect.any(String));
		expect(heldAfterRefresh?.refreshToken).not.toBe(heldAfterSignIn?.refreshToken);
		// The relay forwarded exactly the CLI's bytes, and central applied it.
		expect(created).toMatchObject({ kind: 'answered', result: { result: 'applied' } });
		const relayed = fixture.sent.filter((request) =>
			request.url.pathname.startsWith('/api/auth/organization-admin/v1/'),
		);
		expect(relayed.map((request) => request.url.pathname)).toEqual([
			'/api/auth/organization-admin/v1/create-workspace',
		]);
		const [arrival] = harness.centralAdmin.arrivals;
		expect(arrival?.bodySha256).toBe(sha256(relayed[0]?.body ?? ''));
		expect(arrival?.proofKeyThumbprint).toBe(thumbprint);
		expect(harness.centralAdmin.workspaces).toHaveLength(1);
	} finally {
		await harness.close();
	}
});

/** One raw refresh-grant call, read before the CLI maps it: status and body as the issuer sent. */
async function rawRefresh(props: {
	readonly fixture: Awaited<ReturnType<typeof setupFleetCli>>;
	readonly key: FleetCliSession['key'];
	readonly refreshToken: string;
}): Promise<{ readonly status: number; readonly body: unknown }> {
	const { fixture } = props;
	const tokenEndpoint = new URL('/api/auth/oauth2/token', fixture.harness.issuer).toString();
	const response = await fetch(tokenEndpoint, {
		method: 'POST',
		headers: {
			'content-type': 'application/x-www-form-urlencoded',
			dpop: await signFleetAdminProof(webSignInCrypto, {
				key: props.key,
				htu: tokenEndpoint,
				requestId: fixture.io.nextId(),
				issuedAtSeconds: Math.floor(fixture.io.now() / 1000),
			}),
		},
		body: new URLSearchParams({
			grant_type: 'refresh_token',
			refresh_token: props.refreshToken,
			client_id: fixture.target.ownerFleetCliClientId,
			resource: fixture.target.centralAdminAudience,
		}),
	});
	return { status: response.status, body: z.unknown().parse(await response.json()) };
}

async function ownerPairRevision(
	fixture: Awaited<ReturnType<typeof setupFleetCli>>,
	personId: string,
): Promise<number | undefined> {
	return (
		await fixture.harness.database
			.select({ revision: personFence.revision })
			.from(personFence)
			.where(eq(personFence.personId, personId))
	)[0]?.revision;
}

it("fleet CLI: with Keychain custody each fresh store instance (a later CLI run's store over one shared stand-in keychain) refreshes from the credential the previous one rotated, same key, no fallback", async () => {
	// Arrange: three fresh store instances (not OS subprocesses) over one stand-in keychain,
	// through the production store selection.
	const fixture = await setupFleetCli();
	const { harness, target, io } = fixture;
	try {
		const runner = fakeSecurityRunner();
		const warnings: string[] = [];
		const freshStore = (): ReturnType<typeof selectProofKeyStore> =>
			selectProofKeyStore({
				platform: 'darwin',
				memoryOnly: false,
				runner,
				crypto: webSignInCrypto,
				issuer: target.issuer,
				clientId: target.ownerFleetCliClientId,
				warn: (message) => warnings.push(message),
			});
		// Act
		const signedIn = await signInFleetCli({ target, store: freshStore(), io });
		const secondStore = freshStore();
		const second = await refreshFleetCli({ target, store: secondStore, io });
		const thirdStore = freshStore();
		const third = await refreshFleetCli({ target, store: thirdStore, io });
		// Assert: no fallback, and the third store used the credential the second one rotated.
		expect(warnings).toEqual([]);
		expect([secondStore.custody, thirdStore.custody]).toEqual(['keychain', 'keychain']);
		expect(second).not.toBeNull();
		expect(third).not.toBeNull();
		const thumbprint = await calculateJwkThumbprint(signedIn.key.publicJwk, 'sha256');
		for (const session of [second, third])
			expect(decodeJwt(session?.accessToken ?? '').cnf).toEqual({ jkt: thumbprint });
		expect(fixture.browserVisits()).toBe(1);
	} finally {
		await harness.close();
	}
});

it('fleet CLI: a refresh with another key is invalid_dpop_proof and leaves the credential usable; after native sign-out the refresh is invalid_grant with no credential', async () => {
	// Arrange
	const fixture = await setupFleetCli();
	const { harness, target, io } = fixture;
	try {
		const store = createMemoryProofKeyStore(webSignInCrypto);
		const session = await signInFleetCli({ target, store, io });
		const held = await store.load();
		if (held === null) throw new Error('No credential held');
		const personId = z.string().parse(decodeJwt(session.accessToken).sub);
		const sid = z.string().parse(decodeJwt(session.accessToken).sid);
		// Act: the latest unconsumed refresh credential, with a different key.
		const wrongKey = await rawRefresh({
			fixture,
			key: await createMemoryProofKeyStore(webSignInCrypto).createKey(),
			refreshToken: held.refreshToken,
		});
		// The same credential with the right key still works: the refusal consumed nothing.
		const rightKey = await refreshFleetCli({ target, store, io });
		const rotated = await store.load();
		if (rotated === null) throw new Error('No rotated credential');
		// Native sign-out, through the production fenced adapter.
		const revisionBeforeSignOut = await ownerPairRevision(fixture, personId);
		const signOut = await harness.auth('/__auth-proof/authorization-fence', {
			method: 'POST',
			headers: { 'content-type': 'application/json', cookie: fixture.cookie },
			body: JSON.stringify({ kind: 'native', path: 'sign-out', body: {} }),
		});
		const sessionRows = await harness.database
			.select({ id: sessionTable.id })
			.from(sessionTable)
			.where(eq(sessionTable.id, sid));
		const signedOut = await rawRefresh({
			fixture,
			key: rotated.key,
			refreshToken: rotated.refreshToken,
		});
		// Assert
		expect(wrongKey.status).toBeGreaterThanOrEqual(400);
		expect(wrongKey.body).toMatchObject({ error: 'invalid_dpop_proof' });
		expectNoIssuedCredentials(wrongKey.body);
		expect(rightKey).not.toBeNull();
		expect(signOut.status).toBe(200);
		expect(sessionRows).toEqual([]);
		expect(await ownerPairRevision(fixture, personId)).toBe((revisionBeforeSignOut ?? 0) + 1);
		expect(signedOut.status).toBe(400);
		expect(signedOut.body).toMatchObject({ error: 'invalid_grant' });
		expectNoIssuedCredentials(signedOut.body);
	} finally {
		await harness.close();
	}
});

it('fleet CLI snapshot probe: once the session row is gone the refresh is invalid_grant with no credential, and the CLI clears its store', async () => {
	// A narrower probe than native sign-out: the row is deleted directly, so only the
	// issuance snapshot's session read is exercised.
	const fixture = await setupFleetCli();
	const { harness, target, io } = fixture;
	try {
		const store = createMemoryProofKeyStore(webSignInCrypto);
		const session = await signInFleetCli({ target, store, io });
		const held = await store.load();
		if (held === null) throw new Error('No credential held');
		const sid = z.string().parse(decodeJwt(session.accessToken).sid);
		await harness.database.delete(sessionTable).where(eq(sessionTable.id, sid));
		const raw = await rawRefresh({ fixture, key: held.key, refreshToken: held.refreshToken });
		expect(raw.status).toBe(400);
		expect(raw.body).toMatchObject({ error: 'invalid_grant' });
		expectNoIssuedCredentials(raw.body);
		expect(await refreshFleetCli({ target, store, io })).toBeNull();
		expect(await store.load()).toBeNull();
	} finally {
		await harness.close();
	}
});

it('fleet CLI: after a stale factor, a real app confirmation, a same-key refresh and one retry apply once; a cancelled confirmation refreshes and retries nothing', async () => {
	// Arrange: past central's 900-second window since the owner's app confirmation.
	const fixture = await setupFleetCli();
	const { harness, target, io } = fixture;
	try {
		const store = createMemoryProofKeyStore(webSignInCrypto);
		await fixture.setTime(initialTime + 901_000);
		const session = await signInFleetCli({ target, store, io });
		const cancelledOperation = createRequest(fixture, 'cancelled');
		const tokenCallsBefore = fixture.sent.filter(
			(request) => request.url.pathname === '/api/auth/oauth2/token',
		).length;
		// Act: first a cancelled confirmation, then a confirmed one.
		const cancelled = await runFleetAdminCommand({
			target,
			store,
			session,
			operation: cancelledOperation,
			io,
			confirmSecondFactor: async () => false,
		});
		const tokenCallsAfterCancel = fixture.sent.filter(
			(request) => request.url.pathname === '/api/auth/oauth2/token',
		).length;
		const operation = createRequest(fixture);
		const confirmed = await runFleetAdminCommand({
			target,
			store,
			session,
			operation,
			io,
			confirmSecondFactor: async () =>
				(await harness.totpAuthenticator.confirmApp(ownerEmail, harness.auth)).ok,
		});
		// Assert
		expect(cancelled).toEqual({ kind: 'not-confirmed' });
		expect(tokenCallsAfterCancel).toBe(tokenCallsBefore);
		expect(confirmed).toMatchObject({ kind: 'answered', result: { result: 'applied' } });
		const arrivals = harness.centralAdmin.arrivals;
		expect(
			arrivals.map((arrival) =>
				arrival.outcome.kind === 'answered' ? arrival.outcome.result.result : arrival.outcome.kind,
			),
		).toEqual(['refused', 'refused', 'applied']);
		const [, refused, applied] = arrivals;
		expect(applied?.proofKeyThumbprint).toBe(refused?.proofKeyThumbprint);
		expect(applied?.bodySha256).toBe(refused?.bodySha256);
		expect(applied?.accessTokenHash).not.toBe(refused?.accessTokenHash);
		expect(harness.centralAdmin.workspaces.map((workspace) => workspace.name)).toEqual([
			'research',
		]);
		const intent = await fleetAdminIntentDigest(webSignInCrypto, operation);
		const relayedProofs = fixture.sent
			.filter(
				(request) => request.url.pathname === '/api/auth/organization-admin/v1/create-workspace',
			)
			.slice(1)
			.map((request) => decodeJwt(request.headers.get('dpop') ?? ''));
		expect(relayedProofs.map((proof) => proof.intent)).toEqual([intent, intent]);
		expect(relayedProofs[0]?.jti).not.toBe(relayedProofs[1]?.jti);
	} finally {
		await harness.close();
	}
});
