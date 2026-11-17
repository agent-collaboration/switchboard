import { createHash } from 'node:crypto';

import {
	jwks,
	organization,
	organizationAuthorizationRevisions,
	organizationIdSchema,
	type OrganizationId,
} from '@agent-collaboration/sign-in-core';
import { createPersonTokenVerifier } from '@agent-collaboration/tool-access/contracts';
import { eq } from 'drizzle-orm';
import { createLocalJWKSet, decodeJwt, decodeProtectedHeader, jwtVerify } from 'jose';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { z } from 'zod';
// The recording peer stands in for central's answers only; its stored-stamp facts are what
// central reports for a verified stamp. CAS stays central's proof.

import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import {
	controlledSignInClock,
	controlledSignInIds,
} from '#sign-in-test-support/test-fixtures/controlled-sign-in-clock';
import {
	managementAudience,
	startLocalAuthHarness,
} from '#sign-in-test-support/test-fixtures/local-auth-harness';
import {
	armRenewalDeadline,
	fireDeadlineAfterCentralHolds,
	setRenewalDeadlineBarrier,
} from '#sign-in-test-support/test-fixtures/renewal-deadline-proof';

useControlledSignInClock();
let harness: Awaited<ReturnType<typeof startLocalAuthHarness>>;
let ownerAccessToken: string;
let ownerOrganizationId: OrganizationId;
beforeAll(async (): Promise<void> => {
	harness = await startLocalAuthHarness();
	ownerAccessToken = await harness.ownerToken();
	ownerOrganizationId = organizationIdSchema.parse(decodeJwt(ownerAccessToken).organization_id);
});
afterAll(async (): Promise<void> => {
	await harness?.close();
});
const identityAudience = 'https://central.example.invalid/identity';
const stampType = 'fleet-organization-stamp+jwt';
const publicKeysSchema = z.object({
	keys: z.array(
		z.object({
			kty: z.literal('OKP'),
			crv: z.literal('Ed25519'),
			x: z.string(),
			kid: z.string(),
		}),
	),
});

async function publicKeys(): Promise<z.infer<typeof publicKeysSchema>> {
	const response = await harness.auth('/api/auth/jwks');
	expect(response.status).toBe(200);
	return publicKeysSchema.parse(await response.json());
}
async function signStatement(extra: Readonly<Record<string, unknown>> = {}): Promise<string> {
	const response = await harness.auth('/__auth-proof/organization-statement', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ organizationId: ownerOrganizationId, ...extra }),
	});
	expect(response.status).toBe(200);
	return z.object({ statement: z.string() }).parse(await response.json()).statement;
}
function verificationOptions(nowMilliseconds: number = controlledSignInClock.now()): {
	readonly issuer: string;
	readonly audience: string;
	readonly typ: string;
	readonly algorithms: string[];
	readonly currentDate: Date;
} {
	return {
		issuer: harness.issuer,
		audience: identityAudience,
		typ: stampType,
		algorithms: ['EdDSA'],
		currentDate: new Date(nowMilliseconds),
	};
}

async function markOwnerOrganizationReady(): Promise<void> {
	const changed = await harness.database
		.update(organization)
		.set({ fleetState: 'ready' })
		.where(eq(organization.id, ownerOrganizationId))
		.returning({ id: organization.id });
	expect(changed).toEqual([{ id: ownerOrganizationId }]);
}

async function setHostClock(milliseconds: number): Promise<void> {
	const response = await harness.auth('/__auth-proof/set-clock', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ milliseconds }),
	});
	expect(response.status).toBe(200);
}

it('organization stamp: the real native key signs the exact 120-day profile and public JWKS verifies it', async (): Promise<void> => {
	// Arrange / Act: the fixture invokes the production server-only native endpoint.
	const statement = await signStatement();
	const keys = await publicKeys();
	const rows = await harness.database.select({ id: jwks.id }).from(jwks);
	const issuedAt = Math.floor(controlledSignInClock.now() / 1000);
	// Assert: neither native storage, signing nor the public JWKS is a stand-in.
	expect(rows).toHaveLength(1);
	expect(decodeProtectedHeader(statement)).toEqual({
		typ: stampType,
		alg: 'EdDSA',
		kid: rows[0]?.id,
	});
	expect(decodeJwt(statement)).toEqual({
		purpose: 'fleet-organization-stamp',
		version: 1,
		iss: harness.issuer,
		aud: identityAudience,
		sub: ownerOrganizationId,
		organization_id: ownerOrganizationId,
		iat: issuedAt,
		exp: issuedAt + 10_368_000,
	});
	const verified = await jwtVerify(statement, createLocalJWKSet(keys), verificationOptions());
	expect(verified.payload).toEqual(decodeJwt(statement));
});

it('organization stamp: a caller cannot select claims, algorithm or native key and the signing API has no public route', async (): Promise<void> => {
	// Arrange: a valid signing control and a native key already exist.
	await signStatement();
	const before = await harness.database.select({ id: jwks.id }).from(jwks);
	// Act: these extra members reach production's closed server-only body parser.
	const refused = await Promise.all(
		[
			{ payload: { sub: 'caller', exp: 9999999999 } },
			{ iss: 'https://attacker.invalid', aud: 'https://attacker.invalid' },
			{ alg: 'HS256', signingAlgorithm: 'HS256' },
			{ kid: 'caller-key', signingKeyId: 'caller-key' },
		].map(async (extra): Promise<number> => {
			const response = await harness.auth('/__auth-proof/organization-statement', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ organizationId: ownerOrganizationId, ...extra }),
			});
			return response.status;
		}),
	);
	expect(refused).toEqual([400, 400, 400, 400]);
	const publicStatuses = await Promise.all(
		['/api/auth/sign-organization-statement', '/api/auth/signOrganizationStatement'].map(
			async (pathname): Promise<number> => {
				const response = await harness.auth(pathname, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ organizationId: ownerOrganizationId }),
				});
				return response.status;
			},
		),
	);
	expect(publicStatuses).toEqual([404, 404]);
	// Assert: no caller-selected key or signature was created by refused inputs.
	expect(await harness.database.select({ id: jwks.id }).from(jwks)).toEqual(before);
});

it('organization stamp: the predecessor is signed and editing it invalidates the native signature', async (): Promise<void> => {
	// Arrange
	const predecessor = 'a'.repeat(64);
	const statement = await signStatement({ replaces: predecessor });
	const keys = createLocalJWKSet(await publicKeys());
	const verified = await jwtVerify(statement, keys, verificationOptions());
	expect(verified.payload.replaces).toBe(predecessor);
	// Act: change the digest without asking the native signer.
	const [header, , signature] = statement.split('.');
	const changed = Buffer.from(
		JSON.stringify({ ...verified.payload, replaces: 'b'.repeat(64) }),
	).toString('base64url');
	// Assert
	await expect(
		jwtVerify(`${header}.${changed}.${signature}`, keys, verificationOptions()),
	).rejects.toThrow();
});

it('organization stamp: a native OAuth access token and a stamp cannot substitute for one another', async (): Promise<void> => {
	// Arrange: OAuth code exchange is performed by the delivered owner CLI, not a fixture signer.
	const accessToken = ownerAccessToken;
	const stamp = await signStatement();
	const keys = createLocalJWKSet(await publicKeys());
	const personVerifier = createPersonTokenVerifier({
		deployment: harness.issuer,
		audience: managementAudience,
		jwksUrl: new URL('/api/auth/jwks', harness.issuer),
		now: controlledSignInClock.now,
		jwksFetch: async (input, init) => harness.auth(new URL(input).pathname, init),
	});
	// Act / Assert: each real signature is accepted only under its own profile.
	expect(decodeProtectedHeader(accessToken).typ).toBe('at+jwt');
	expect((await personVerifier.verify(accessToken)).kind).toBe('verified');
	await expect(jwtVerify(accessToken, keys, verificationOptions())).rejects.toThrow();
	await expect(personVerifier.verify(stamp)).resolves.toEqual({
		kind: 'refused',
		reason: 'wrong-token-type',
	});
	await expect(jwtVerify(stamp, keys, verificationOptions())).resolves.toHaveProperty(
		'payload.purpose',
		'fleet-organization-stamp',
	);
});

const lifetimeSeconds = 10_368_000; // Owner choice 3f: 120 days.
const renewalWindowSeconds = 5_184_000; // Owner choice 3f: renew with 60 days left.

async function storedStampFor(statement: string): Promise<{
	readonly digest: string;
	readonly expiresAt: number;
	readonly signingKeyId: string;
}> {
	const header = decodeProtectedHeader(statement);
	const claims = decodeJwt(statement);
	if (typeof header.kid !== 'string' || typeof claims.exp !== 'number')
		throw new Error('Native statement lacks kid or exp');
	return {
		digest: createHash('sha256').update(statement, 'utf8').digest('hex'),
		expiresAt: claims.exp,
		signingKeyId: header.kid,
	};
}

async function addReadyOrganization(slug: string): Promise<OrganizationId> {
	const id = organizationIdSchema.parse(controlledSignInIds.nextId());
	await harness.database.insert(organization).values({
		id,
		name: slug,
		slug,
		createdAt: new Date(controlledSignInClock.now()),
		fleetState: 'ready',
	});
	return id;
}

/** A real Fleet call: one pass of the production drain, which pushes each pending fence
 * only after its organization's stamp guard (B2 renew-on-use). */
async function pushPendingFences(...organizationIds: readonly OrganizationId[]): Promise<unknown> {
	await Promise.all(
		organizationIds.map(async (id) =>
			harness.database
				.insert(organizationAuthorizationRevisions)
				.values({
					id,
					revision: 1,
					state: 'active',
					permissionPolicyDigest: 'a'.repeat(64),
					nextAttemptAt: 0,
					createdAt: 0,
					updatedAt: 0,
				})
				.onConflictDoUpdate({
					target: organizationAuthorizationRevisions.id,
					set: { acknowledgedRevision: 0, nextAttemptAt: 0 },
				}),
		),
	);
	const response = await harness.auth('/__auth-proof/authorization-drain', { method: 'POST' });
	expect(response.status).toBe(200);
	return response.json();
}

/** Each case starts from an empty record, so the first use seeds it from central (D3). */
async function clearStampRecord(organizationId: OrganizationId): Promise<void> {
	await harness.database
		.update(organization)
		.set({
			fleetStampDigest: null,
			fleetStampExpiresAt: null,
			fleetStampSigningKeyId: null,
			fleetStampSent: null,
			fleetStampRenewedAt: null,
			fleetStampUnansweredTries: 0,
			fleetStampRefusedTries: 0,
			fleetStampLastTryAt: null,
			fleetStampLastTryOutcome: null,
		})
		.where(eq(organization.id, organizationId));
}

async function stampRecord(organizationId: OrganizationId): Promise<unknown> {
	return (
		await harness.database
			.select({
				digest: organization.fleetStampDigest,
				expiresAt: organization.fleetStampExpiresAt,
				signingKeyId: organization.fleetStampSigningKeyId,
				sent: organization.fleetStampSent,
				unanswered: organization.fleetStampUnansweredTries,
				refused: organization.fleetStampRefusedTries,
				lastTryOutcome: organization.fleetStampLastTryOutcome,
			})
			.from(organization)
			.where(eq(organization.id, organizationId))
	)[0];
}

function pushedOrganizations(fromPush: number): readonly string[] {
	return harness.centralProvisioning.pushes
		.slice(fromPush)
		.filter((push) => push.kind === 'organization')
		.map((push) => push.organizationId);
}

async function expectRenewedStatement(props: {
	readonly statement: string;
	readonly organizationId: OrganizationId;
	readonly replaces: string;
	readonly issuedAt: number;
}): Promise<void> {
	const verified = await jwtVerify(
		props.statement,
		createLocalJWKSet(await publicKeys()),
		verificationOptions(props.issuedAt * 1000),
	);
	expect(verified.payload).toEqual({
		purpose: 'fleet-organization-stamp',
		version: 1,
		iss: harness.issuer,
		aud: identityAudience,
		sub: props.organizationId,
		organization_id: props.organizationId,
		iat: props.issuedAt,
		exp: props.issuedAt + lifetimeSeconds,
		replaces: props.replaces,
	});
}

it('renewal on use: a guarded Fleet call re-signs exactly the due and retired-key stamps first, each naming its own digest, then makes every call', async (): Promise<void> => {
	// Arrange: three ready organizations with empty records. The owner's stamp is a real native
	// statement with exactly 60 days left at the chosen time; one has 60 days + 1 s; one carries
	// a retired kid.
	await markOwnerOrganizationReady();
	const notDue = await addReadyOrganization('renewal-not-due');
	const retiredKey = await addReadyOrganization('renewal-retired-key');
	await clearStampRecord(ownerOrganizationId);
	const ownerStamp = await storedStampFor(await signStatement());
	const renewAt = ownerStamp.expiresAt - renewalWindowSeconds;
	const notDueStamp = {
		digest: 'b'.repeat(64),
		expiresAt: renewAt + renewalWindowSeconds + 1,
		signingKeyId: ownerStamp.signingKeyId,
	};
	harness.centralProvisioning.holdStamp(ownerOrganizationId, ownerStamp);
	harness.centralProvisioning.holdStamp(notDue, notDueStamp);
	harness.centralProvisioning.holdStamp(retiredKey, {
		digest: 'c'.repeat(64),
		expiresAt: renewAt + renewalWindowSeconds + 1,
		signingKeyId: 'retired-native-key',
	});
	harness.centralProvisioning.replyWith('provisioned');
	harness.centralProvisioning.replyToPushesWith('acknowledge');
	const readsBefore = harness.centralProvisioning.digestReads.length;
	const sendsBefore = harness.centralProvisioning.sends.length;
	const pushesBefore = harness.centralProvisioning.pushes.length;
	await setHostClock(renewAt * 1000);
	try {
		// Act: the production drain pushes all three organizations' pending fences.
		await pushPendingFences(ownerOrganizationId, notDue, retiredKey);
		// Assert: each record was seeded once from central; only the two due stamps were re-signed.
		expect(harness.centralProvisioning.digestReads.slice(readsBefore).toSorted()).toEqual(
			[ownerOrganizationId, notDue, retiredKey].toSorted(),
		);
		const sent = harness.centralProvisioning.sends.slice(sendsBefore);
		expect(sent.map((send) => send.organizationId).toSorted()).toEqual(
			[ownerOrganizationId, retiredKey].toSorted(),
		);
		for (const send of sent) {
			const organizationId = organizationIdSchema.parse(send.organizationId);
			// iat equals the set time: the core clock the guard used moved on this host.
			await expectRenewedStatement({
				statement: send.organizationStatement,
				organizationId,
				replaces: organizationId === ownerOrganizationId ? ownerStamp.digest : 'c'.repeat(64),
				issuedAt: renewAt,
			});
			expect(await stampRecord(organizationId)).toEqual({
				...(await storedStampFor(send.organizationStatement)),
				sent: null,
				unanswered: 0,
				refused: 0,
				lastTryOutcome: null,
			});
		}
		expect(await stampRecord(notDue)).toEqual({
			...notDueStamp,
			sent: null,
			unanswered: 0,
			refused: 0,
			lastTryOutcome: null,
		});
		// Every original call went out after its guard: a valid stamp never blocks it.
		expect(pushedOrganizations(pushesBefore).toSorted()).toEqual(
			[ownerOrganizationId, notDue, retiredKey].toSorted(),
		);
	} finally {
		await setHostClock(controlledSignInClock.now());
	}
});

it.each(['stale', 'invalid-statement', 'organization-mismatch'] as const)(
	'renewal on use: a %s refusal is counted as refused, clears the sent stamp and the call over a valid stamp still goes out',
	async (refusal): Promise<void> => {
		// Arrange: one due stamp; central refuses the replacement and keeps its own stamp.
		await markOwnerOrganizationReady();
		await clearStampRecord(ownerOrganizationId);
		const stamp = await storedStampFor(await signStatement());
		const renewAt = stamp.expiresAt - renewalWindowSeconds;
		harness.centralProvisioning.holdStamp(ownerOrganizationId, stamp);
		harness.centralProvisioning.replyWith(refusal);
		harness.centralProvisioning.replyToPushesWith('acknowledge');
		const sendsBefore = harness.centralProvisioning.sends.length;
		const pushesBefore = harness.centralProvisioning.pushes.length;
		await setHostClock(renewAt * 1000);
		try {
			// Act
			await pushPendingFences(ownerOrganizationId);
			// Assert: one replacement, no retry and no fallback to setup.
			const sent = harness.centralProvisioning.sends
				.slice(sendsBefore)
				.filter((send) => send.organizationId === ownerOrganizationId);
			expect(sent).toHaveLength(1);
			expect(decodeJwt(sent[0]?.organizationStatement ?? '').replaces).toBe(stamp.digest);
			// stale reconciles from central's current stamp (rule 3); the others clear (D2).
			expect(await stampRecord(ownerOrganizationId)).toEqual({
				...stamp,
				sent: null,
				unanswered: 0,
				refused: 1,
				lastTryOutcome: `refused-${refusal}`,
			});
			expect(pushedOrganizations(pushesBefore)).toEqual([ownerOrganizationId]);
		} finally {
			await setHostClock(controlledSignInClock.now());
		}
	},
);

it('renewal on use: a lost answer keeps the sent stamp and the next call re-sends exactly those bytes', async (): Promise<void> => {
	await markOwnerOrganizationReady();
	await clearStampRecord(ownerOrganizationId);
	const stamp = await storedStampFor(await signStatement());
	const renewAt = stamp.expiresAt - renewalWindowSeconds;
	harness.centralProvisioning.holdStamp(ownerOrganizationId, stamp);
	harness.centralProvisioning.replyToPushesWith('acknowledge');
	const sendsBefore = harness.centralProvisioning.sends.length;
	const pushesBefore = harness.centralProvisioning.pushes.length;
	await setHostClock(renewAt * 1000);
	try {
		// Act: the first call's renewal answer is lost; a later call finds central applied it.
		harness.centralProvisioning.replyWith('lost-reply');
		await pushPendingFences(ownerOrganizationId);
		const afterLoss = await stampRecord(ownerOrganizationId);
		await setHostClock(renewAt * 1000 + 60_000);
		harness.centralProvisioning.replyWith('provisioned');
		await pushPendingFences(ownerOrganizationId);
		// Assert
		const sent = harness.centralProvisioning.sends
			.slice(sendsBefore)
			.filter((send) => send.organizationId === ownerOrganizationId)
			.map((send) => send.organizationStatement);
		expect(sent).toHaveLength(2);
		expect(sent[1]).toBe(sent[0]);
		expect(afterLoss).toEqual({
			...stamp,
			sent: sent[0],
			unanswered: 1,
			refused: 0,
			lastTryOutcome: 'unanswered-unavailable',
		});
		expect(await stampRecord(ownerOrganizationId)).toEqual({
			...(await storedStampFor(sent[0] ?? '')),
			sent: null,
			unanswered: 1,
			refused: 0,
			lastTryOutcome: 'unanswered-unavailable',
		});
		// The valid stamp let both original calls out.
		expect(pushedOrganizations(pushesBefore)).toEqual([ownerOrganizationId, ownerOrganizationId]);
	} finally {
		await setHostClock(controlledSignInClock.now());
	}
});

it('renewal on use: over an expired stamp the call waits until renewal lands, then goes out', async (): Promise<void> => {
	await markOwnerOrganizationReady();
	await clearStampRecord(ownerOrganizationId);
	const stamp = await storedStampFor(await signStatement());
	harness.centralProvisioning.holdStamp(ownerOrganizationId, stamp);
	harness.centralProvisioning.replyToPushesWith('acknowledge');
	const sendsBefore = harness.centralProvisioning.sends.length;
	const pushesBefore = harness.centralProvisioning.pushes.length;
	await setHostClock(stamp.expiresAt * 1000);
	try {
		// Act: renewal fails at first, so the expired stamp holds the call back.
		harness.centralProvisioning.replyWith('unavailable');
		await pushPendingFences(ownerOrganizationId);
		const withheld = pushedOrganizations(pushesBefore);
		// The failed send stays in doubt: the next call re-sends it, and this time it lands.
		await setHostClock(stamp.expiresAt * 1000 + 60_000);
		harness.centralProvisioning.replyWith('provisioned');
		await pushPendingFences(ownerOrganizationId);
		// Assert
		expect(withheld).toEqual([]);
		const sent = harness.centralProvisioning.sends
			.slice(sendsBefore)
			.filter((send) => send.organizationId === ownerOrganizationId);
		expect(sent).toHaveLength(2);
		expect(sent[1]?.organizationStatement).toBe(sent[0]?.organizationStatement);
		expect(pushedOrganizations(pushesBefore)).toEqual([ownerOrganizationId]);
	} finally {
		await setHostClock(controlledSignInClock.now());
	}
});

it('central empty: an organization central forgot (it started empty) is set up again on its next Fleet call with a fresh setup statement, and the call then goes out (WS7)', async (): Promise<void> => {
	await markOwnerOrganizationReady();
	await clearStampRecord(ownerOrganizationId);
	harness.centralProvisioning.holdStamp(ownerOrganizationId, null);
	harness.centralProvisioning.replyWith('provisioned');
	harness.centralProvisioning.replyToPushesWith('acknowledge');
	const sendsBefore = harness.centralProvisioning.sends.length;
	const pushesBefore = harness.centralProvisioning.pushes.length;
	try {
		// Act: the drain's guard finds central holding nothing for the organization.
		await pushPendingFences(ownerOrganizationId);
		// Assert: one fresh setup statement, no predecessor; the record now names central's stamp.
		const sent = harness.centralProvisioning.sends
			.slice(sendsBefore)
			.filter((send) => send.organizationId === ownerOrganizationId)
			.map((send) => send.organizationStatement);
		expect(sent).toHaveLength(1);
		expect(decodeJwt(sent[0] ?? '').replaces).toBeUndefined();
		expect(await stampRecord(ownerOrganizationId)).toEqual({
			...(await storedStampFor(sent[0] ?? '')),
			sent: null,
			unanswered: 0,
			refused: 0,
			lastTryOutcome: null,
		});
		// The original call, the revision push, went out once the organization was set up again.
		expect(pushedOrganizations(pushesBefore)).toEqual([ownerOrganizationId]);
	} finally {
		harness.centralProvisioning.replyWith('provisioned');
	}
});
it("renewal on use: a renewal central never answers uses up its deadline, so with a revision pending neither organization's push goes out (Q2); the next call re-sends the same bytes and delivers both", async (): Promise<void> => {
	// Arrange: two ready organizations due for renewal; the owner's stamp is still valid, the
	// other's has expired. Central receives each renewal and never answers (D7).
	await markOwnerOrganizationReady();
	await clearStampRecord(ownerOrganizationId);
	const expired = await addReadyOrganization('deadline-expired');
	const ownerStamp = await storedStampFor(await signStatement());
	const renewAt = ownerStamp.expiresAt - renewalWindowSeconds;
	harness.centralProvisioning.holdStamp(ownerOrganizationId, ownerStamp);
	harness.centralProvisioning.holdStamp(expired, {
		digest: 'd'.repeat(64),
		expiresAt: renewAt - 1,
		signingKeyId: ownerStamp.signingKeyId,
	});
	harness.centralProvisioning.replyToPushesWith('acknowledge');
	harness.centralProvisioning.replyWith('hold');
	const sendsBefore = harness.centralProvisioning.sends.length;
	const pushesBefore = harness.centralProvisioning.pushes.length;
	await setHostClock(renewAt * 1000);
	try {
		// Act: each guard's deadline fires only after central holds its renewal unanswered.
		const prefix = `deadline-${controlledSignInIds.nextId()}`;
		for (const id of [ownerOrganizationId, expired])
			// oxlint-disable-next-line no-await-in-loop -- one barrier per organization.
			await armRenewalDeadline(harness, prefix, id);
		await setRenewalDeadlineBarrier(harness, prefix);
		const draining = pushPendingFences(ownerOrganizationId, expired);
		const heldOrder = [
			await fireDeadlineAfterCentralHolds(harness, prefix, 1),
			await fireDeadlineAfterCentralHolds(harness, prefix, 2),
		];
		await draining;
		await setRenewalDeadlineBarrier(harness, null);
		expect(heldOrder.toSorted()).toEqual([ownerOrganizationId, expired].toSorted());
		const firstPushes = pushedOrganizations(pushesBefore);
		const afterDeadline = [await stampRecord(ownerOrganizationId), await stampRecord(expired)];
		harness.centralProvisioning.releaseHeld();
		harness.centralProvisioning.replyWith('provisioned');
		await setHostClock(renewAt * 1000 + 60_000);
		await pushPendingFences(ownerOrganizationId, expired);
		// Assert: the one budget was spent on the renewal, so neither pending push went (Q1 = A).
		expect(firstPushes).toEqual([]);
		const sends = harness.centralProvisioning.sends.slice(sendsBefore);
		for (const [index, organizationId] of [ownerOrganizationId, expired].entries()) {
			const statements = sends
				.filter((send) => send.organizationId === organizationId)
				.map((send) => send.organizationStatement);
			expect(statements).toHaveLength(2);
			expect(statements[1]).toBe(statements[0]);
			expect(afterDeadline[index]).toMatchObject({
				sent: statements[0],
				unanswered: 1,
				refused: 0,
				lastTryOutcome: 'unanswered-timeout',
			});
		}
		expect(pushedOrganizations(pushesBefore).toSorted()).toEqual(
			[ownerOrganizationId, expired].toSorted(),
		);
	} finally {
		await setRenewalDeadlineBarrier(harness, null);
		harness.centralProvisioning.releaseHeld();
		harness.centralProvisioning.replyWith('provisioned');
		await setHostClock(controlledSignInClock.now());
	}
});

it('key change: every ready organization under a retired key is re-signed far from expiry, and a current-key one is left alone', async (): Promise<void> => {
	await markOwnerOrganizationReady();
	await clearStampRecord(ownerOrganizationId);
	const current = await addReadyOrganization('key-change-current');
	const stamp = await storedStampFor(await signStatement());
	harness.centralProvisioning.holdStamp(ownerOrganizationId, {
		...stamp,
		signingKeyId: 'retired-native-key',
	});
	harness.centralProvisioning.holdStamp(current, { ...stamp, digest: 'd'.repeat(64) });
	harness.centralProvisioning.replyWith('provisioned');
	const sendsBefore = harness.centralProvisioning.sends.length;
	// Act: the production key-change entry; no Fleet call and no timer is involved.
	const result = await harness.reSignForKeyChange();
	// Assert
	const sent = harness.centralProvisioning.sends
		.slice(sendsBefore)
		.filter((send) => [ownerOrganizationId, current].some((id) => id === send.organizationId));
	expect(sent.map((send) => send.organizationId)).toEqual([ownerOrganizationId]);
	await expectRenewedStatement({
		statement: sent[0]?.organizationStatement ?? '',
		organizationId: ownerOrganizationId,
		replaces: stamp.digest,
		issuedAt: Math.floor(controlledSignInClock.now() / 1000),
	});
	expect(result).toMatchObject({
		kind: 'complete',
		organizations: expect.arrayContaining([
			{ kind: 'current-key', organizationId: ownerOrganizationId },
			{ kind: 'current-key', organizationId: current },
		]),
	});
});
