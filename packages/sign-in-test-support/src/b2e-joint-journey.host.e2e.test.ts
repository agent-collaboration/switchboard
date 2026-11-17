import { createHash } from 'node:crypto';

import {
	epochMillisecondsSchema,
	fleetAdminRoutePaths,
	organization,
	organizationAuthorizationRevisions,
	personOrganizationAuthorizationRevisions as personFence,
	type FleetAdminRequest,
} from '@agent-collaboration/sign-in-core';
import {
	createMemoryProofKeyStore,
	refreshFleetCli,
	requireFleetTarget,
	runFleetAdminCommand,
	runFleetCommand,
	signInFleetCli,
	type FleetCliSession,
	type FleetTarget,
} from '@agent-collaboration/sign-in-owner-cli';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { useCentralProcessTeardown } from '#sign-in-test-support/test-fixtures/b2e/central-control-process';
import {
	jointArtifactsDirectory,
	jointCentralCheckoutDirectory,
	jointCentralNode,
	jointCentralPin,
} from '#sign-in-test-support/test-fixtures/b2e/joint-central-pins';
import type { JointFixture } from '#sign-in-test-support/test-fixtures/b2e/joint-fixture';
import { startJointNode } from '#sign-in-test-support/test-fixtures/b2e/joint-node-central';
import { startJointWorkerd } from '#sign-in-test-support/test-fixtures/b2e/joint-workerd-central';
import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import {
	controlledSignInClock,
	controlledSignInIds,
} from '#sign-in-test-support/test-fixtures/controlled-sign-in-clock';
import { fleetCliIoFor } from '#sign-in-test-support/test-fixtures/fleet-cli-fixture';
import { ensureLocalOwnerOrganization } from '#sign-in-test-support/test-fixtures/local-owner-organization';
import { openOrganizationAdminPage } from '#sign-in-test-support/test-fixtures/organization-admin-page-driver';
import {
	peoplePost,
	signInConfirmedPeopleBrowser,
} from '#sign-in-test-support/test-fixtures/people-browser-login';
import { webSignInCrypto } from '#sign-in-test-support/test-fixtures/recording-sign-in-capabilities';

useControlledSignInClock();
// A case whose `finally` never runs (still awaiting when Vitest times it out) leaves its
// central process (launcher or bridge) running; this file's teardown ends it.
useCentralProcessTeardown();
const host = process.env.SIGN_IN_TEST_HOST ?? 'cloudflare';
const artifactsDirectory = jointArtifactsDirectory();
const checkoutDirectory = jointCentralCheckoutDirectory();
const centralNode = jointCentralNode();
const ownerEmail = 'owner@example.invalid';
const memberEmail = 'member@example.invalid';

/**
 * Central's read-only, complete observation of one organization (codex-router
 * `collaboration-central-core::signin_test_observation`, R-observe): exactly its fields, each
 * read from central's own rows; nothing here is defaulted or derived.
 */
const observationSchema = z.strictObject({
	complete: z.literal(true),
	/** The stored compact statement exactly as central received it. */
	statement: z.string().nullable(),
	/** Facts central read from those stored bytes (not a verification); expiry may be absent. */
	stamp: z
		.strictObject({
			digest: z.string(),
			keyId: z.string().nullable(),
			expiresAt: z.number().nullable(),
		})
		.nullable(),
	records: z.array(
		z.strictObject({
			kind: z.string(),
			requestId: z.string(),
			targetId: z.string(),
			createdAtMillis: z.number(),
		}),
	),
	organizationFloor: z.strictObject({ revision: z.number(), state: z.string() }).nullable(),
	personFloors: z.array(
		z.strictObject({
			subjectId: z.string(),
			personId: z.string(),
			revision: z.number(),
			state: z.string(),
		}),
	),
	usedRequests: z.array(z.strictObject({ id: z.string() })),
	workspaces: z.array(z.strictObject({ workspaceId: z.string(), name: z.string() })),
});
/** A valid stamp's expiry, as central stored it: a renewal compares real instants, never a default. */
function stampExpiry(observation: Observation): number {
	const expiresAt = observation.stamp?.expiresAt;
	if (expiresAt === null || expiresAt === undefined)
		throw new Error('Central observed no stamp expiry where a valid stamp is expected');
	return expiresAt;
}
type Observation = z.infer<typeof observationSchema>;

interface Owned {
	readonly joint: JointFixture;
	readonly organizationId: string;
	readonly ownerId: string;
	readonly ownerCookie: string;
	readonly now: () => number;
}

/** The owner signs in, creates the organization (provisioned over the link) and bootstraps. */
async function ownerReady(): Promise<Owned> {
	let now = controlledSignInClock.now();
	const authenticatorClock = { now: () => epochMillisecondsSchema.parse(now) };
	const joint =
		host === 'node'
			? await startJointNode({ artifactsDirectory: artifactsDirectory ?? '', authenticatorClock })
			: await startJointWorkerd({
					// A selected workerd run without the pinned checkout or Node fails here; it never skips.
					checkoutDirectory: checkoutDirectory ?? '',
					node: centralNode ?? '',
					authenticatorClock,
				});
	try {
		const { harness } = joint;
		const ownerId = await signInConfirmedPeopleBrowser({ harness, email: ownerEmail });
		const organizationId = await ensureLocalOwnerOrganization({
			auth: harness.auth,
			database: harness.database,
		});
		const bootstrap = await harness.auth('/api/auth/owner/bootstrap', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{}',
		});
		expect(bootstrap.status).toBe(200);
		await harness.settleDeferredWork();
		const original = joint.setJointTime;
		return {
			joint: {
				...joint,
				async setJointTime(milliseconds): Promise<void> {
					await original(milliseconds);
					now = epochMillisecondsSchema.parse(milliseconds);
				},
			},
			organizationId,
			ownerId,
			ownerCookie: harness.cookie(),
			now: () => now,
		};
	} catch (error) {
		await joint.close();
		throw error;
	}
}

async function observe(owned: Owned): Promise<Observation> {
	return observationSchema.parse(await owned.joint.observe(owned.organizationId));
}

async function pairOf(
	owned: Owned,
	personId: string,
): Promise<{
	readonly id: string;
	readonly revision: number;
	readonly acknowledgedRevision: number;
	readonly state: string;
}> {
	const row = (
		await owned.joint.harness.database
			.select({
				id: personFence.id,
				revision: personFence.revision,
				acknowledgedRevision: personFence.acknowledgedRevision,
				state: personFence.state,
			})
			.from(personFence)
			.where(
				and(
					eq(personFence.personId, personId),
					eq(personFence.organizationId, owned.organizationId),
				),
			)
	)[0];
	if (row === undefined) throw new Error('Retained pair missing');
	return row;
}

async function synchronization(owned: Owned, personId: string): Promise<string> {
	const response = await owned.joint.harness.auth('/__auth-proof/authorization-sync', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			kind: 'personInOrganization',
			organizationId: owned.organizationId,
			personId,
		}),
	});
	return z.object({ kind: z.literal('available'), value: z.string() }).parse(await response.json())
		.value;
}

/** Node's periodic drain, as its timer job runs it. */
/** The drain a fence change's after-response hint runs; no timer runs it (WS3). */
async function hintDrain(owned: Owned): Promise<Response> {
	return owned.joint.harness.auth('/__auth-proof/authorization-drain', { method: 'POST' });
}

/** The member joins through a real invitation and acceptance in their own browser. */
async function memberJoins(
	owned: Owned,
): Promise<{ readonly memberId: string; readonly memberCookie: string }> {
	const { harness } = owned.joint;
	const invited = await peoplePost(
		harness,
		'invite-member',
		{ organizationId: owned.organizationId, email: memberEmail, role: 'member' },
		owned.ownerCookie,
	);
	const invitationId = z.object({ id: z.uuidv7() }).parse(await invited.json()).id;
	const memberId = await signInConfirmedPeopleBrowser({ harness, email: memberEmail });
	expect((await peoplePost(harness, 'accept-invitation', { invitationId })).status).toBe(200);
	await harness.settleDeferredWork();
	return { memberId, memberCookie: harness.cookie() };
}

function adminPost(
	owned: Owned,
	route: 'create-workspace' | 'workspace-lookup' | 'change-records',
	body: Readonly<Record<string, unknown>>,
	cookie: string,
): Promise<Response> {
	return owned.joint.harness.auth(`/api/auth/organization-admin/${route}`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			origin: new URL(owned.joint.harness.issuer).origin,
			cookie,
		},
		body: JSON.stringify(body),
	});
}

const isPersonPush =
	(personId: string) =>
	({ path, body }: { readonly path: string; readonly body: unknown }): boolean =>
		path === '/internal/organization-authorization-revisions' &&
		z.object({ kind: z.literal('person'), personId: z.literal(personId) }).safeParse(body).success;

/** A renewal send: a provisioning request whose signed statement names the stamp it replaces. */
function isRenewalSend({ path, body }: { readonly path: string; readonly body: unknown }): boolean {
	if (path !== '/internal/organization-provisioning') return false;
	const statement = z.object({ organizationStatement: z.string() }).safeParse(body);
	if (!statement.success) return false;
	return typeof statementClaims(statement.data.organizationStatement)['replaces'] === 'string';
}

/** One part of a compact JWS, decoded here and not by any producer or consumer under test. */
function jwsPart(statement: string, index: 0 | 1): Record<string, unknown> {
	return z
		.record(z.string(), z.unknown())
		.parse(
			JSON.parse(Buffer.from(statement.split('.')[index] ?? '', 'base64url').toString('utf8')),
		);
}

function statementClaims(statement: string): Record<string, unknown> {
	return jwsPart(statement, 1);
}

/** A production-signed renewal proposal naming `replaces`, from the server-only signer. */
async function signProposal(owned: Owned, replaces: string): Promise<string> {
	const response = await owned.joint.harness.auth('/__auth-proof/organization-statement', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ organizationId: owned.organizationId, replaces }),
	});
	expect(response.status).toBe(200);
	return z.object({ statement: z.string() }).parse(await response.json()).statement;
}

/** One statement through the host's production provisioning client and the real link. */
async function sendProposal(owned: Owned, organizationStatement: string): Promise<unknown> {
	const response = await owned.joint.harness.auth('/__auth-proof/organization-provisioning-send', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ organizationId: owned.organizationId, organizationStatement }),
	});
	expect(response.status).toBe(200);
	return response.json();
}

/** A real Fleet call: one production drain pass over the organization's re-opened fence,
 * whose push first passes the stamp guard (B2 renew-on-use). */
async function guardedDrainPass(owned: Owned): Promise<void> {
	await owned.joint.harness.database
		.update(organizationAuthorizationRevisions)
		.set({ acknowledgedRevision: 0, nextAttemptAt: 0 })
		.where(eq(organizationAuthorizationRevisions.id, owned.organizationId));
	const response = await owned.joint.harness.auth('/__auth-proof/authorization-drain', {
		method: 'POST',
	});
	expect(response.status).toBe(200);
}

async function stampRecord(owned: Owned): Promise<unknown> {
	return (
		await owned.joint.harness.database
			.select({
				digest: organization.fleetStampDigest,
				expiresAt: organization.fleetStampExpiresAt,
				signingKeyId: organization.fleetStampSigningKeyId,
				sent: organization.fleetStampSent,
			})
			.from(organization)
			.where(eq(organization.id, owned.organizationId))
	)[0];
}

const isDigestRead = ({ path }: { readonly path: string }): boolean =>
	path === '/internal/organization-statement-digest';

/**
 * The private digest read's closed reply, as it must be for a stored statement: its SHA-256 as
 * lowercase hex, its protected header's `kid` and its `exp` in seconds, all taken from the bytes.
 */
function digestReplyFor(statement: string): {
	readonly digest: string;
	readonly expiresAt: unknown;
	readonly signingKeyId: unknown;
} {
	return {
		digest: createHash('sha256').update(statement).digest('hex'),
		expiresAt: jwsPart(statement, 1)['exp'],
		signingKeyId: jwsPart(statement, 0)['kid'],
	};
}

/** Each link exchange since `from`, named by route and central's status. */
function linkSince(owned: Owned, from: number): readonly string[] {
	const names: Readonly<Record<string, string>> = {
		[fleetAdminRoutePaths.ReadChangeRecords]: 'admin',
		'/internal/organization-statement-digest': 'digest',
		'/internal/organization-provisioning': 'setup',
		'/internal/organization-authorization-revisions': 'push',
	};
	return owned.joint.link.events
		.slice(from)
		.map(
			(event) =>
				`${names[event.path] ?? event.path}:${event.kind === 'forwarded' ? String(event.status) : event.kind}`,
		);
}

/** Sign-in's fence for the organization: every row's revision and ACK. */
async function fenceAcks(owned: Owned): Promise<{
	readonly organization: readonly { readonly revision: number; readonly acknowledged: number }[];
	readonly pairs: readonly {
		readonly personId: string;
		readonly revision: number;
		readonly acknowledged: number;
		readonly state: string;
	}[];
}> {
	const database = owned.joint.harness.database;
	return {
		organization: await database
			.select({
				revision: organizationAuthorizationRevisions.revision,
				acknowledged: organizationAuthorizationRevisions.acknowledgedRevision,
			})
			.from(organizationAuthorizationRevisions)
			.where(eq(organizationAuthorizationRevisions.id, owned.organizationId)),
		pairs: await database
			.select({
				personId: personFence.personId,
				revision: personFence.revision,
				acknowledged: personFence.acknowledgedRevision,
				state: personFence.state,
			})
			.from(personFence)
			.where(eq(personFence.organizationId, owned.organizationId)),
	};
}

/**
 * WS7 (Lead, 13 Nov): after an empty restart, central holds a fresh setup statement, sign-in's
 * record names it, and central holds every floor at sign-in's current revisions, each ACKed.
 */
async function expectRecoveredOnBothSides(owned: Owned): Promise<void> {
	const observed = await observe(owned);
	expect(observed.statement).not.toBeNull();
	expect(statementClaims(observed.statement ?? '')['replaces']).toBeUndefined();
	expect(
		observed.records.filter((record) => record.kind === 'organizationProvisioned'),
	).toHaveLength(1);
	const stored = digestReplyFor(observed.statement ?? '');
	expect(await stampRecord(owned)).toEqual({
		digest: stored.digest,
		expiresAt: stored.expiresAt,
		signingKeyId: stored.signingKeyId,
		sent: null,
	});
	const fence = await fenceAcks(owned);
	expect(fence.organization.map((row) => row.acknowledged)).toEqual(
		fence.organization.map((row) => row.revision),
	);
	expect(observed.organizationFloor).toMatchObject({ revision: fence.organization[0]?.revision });
	for (const pair of fence.pairs) {
		expect(pair.acknowledged).toBe(pair.revision);
		expect(observed.personFloors).toContainEqual(
			expect.objectContaining({
				personId: pair.personId,
				revision: pair.revision,
				state: pair.state,
			}),
		);
	}
}

const isCreateWorkspace = ({ path }: { readonly path: string }): boolean =>
	path === fleetAdminRoutePaths.CreateWorkspace;
const isAdminRoute = ({ path }: { readonly path: string }): boolean =>
	path.startsWith('/organization-admin/');

/** Central's replay window for a create (R31): 24 hours, plus one second. */
const pastReplayWindowMs = 86_401_000;

/** The owner confirms the authenticator app again, as a page or CLI step-up would ask. */
async function confirmOwnerApp(owned: Owned): Promise<void> {
	const { harness } = owned.joint;
	expect((await harness.totpAuthenticator.confirmApp(ownerEmail, harness.auth)).ok).toBe(true);
}

/** The owner CLI's real `fleet-create-workspace`, its printed lines and exit code. */
async function ownerCliCreate(
	owned: Owned,
	cli: {
		readonly store: ReturnType<typeof createMemoryProofKeyStore>;
		readonly sent: Parameters<typeof fleetCliIoFor>[0]['sent'];
	},
	options: { readonly operationId: string; readonly name: string },
): Promise<{ readonly exitCode: number; readonly lines: readonly string[] }> {
	const { harness } = owned.joint;
	const lines: string[] = [];
	const exitCode = await runFleetCommand({
		command: 'fleet-create-workspace',
		target: { ...harness.target, organizationId: owned.organizationId },
		options: { 'operation-id': options.operationId, name: options.name },
		environment: {
			io: fleetCliIoFor({ harness, cookie: owned.ownerCookie, now: owned.now, sent: cli.sent }),
			store: () => cli.store,
			async confirmSecondFactor(): Promise<boolean> {
				return (await harness.totpAuthenticator.confirmApp(ownerEmail, harness.auth)).ok;
			},
			write: (line) => lines.push(line),
		},
	});
	return { exitCode, lines };
}

const workspaceCreatedFor = (observed: Observation, operationId: string): readonly unknown[] =>
	observed.records.filter(
		(record) => record.kind === 'workspaceCreated' && record.requestId === operationId,
	);

// B2e pairing 1: Node sign-in against real Tokio central over the
// real link. Selected only with the pinned artifacts; a selected run never skips a case.
const pairingLabel =
	host === 'node' ? 'Node sign-in + Tokio central' : 'workerd sign-in + workerd central';
describe.runIf(artifactsDirectory !== null)(
	`B2e joint journey, ${pairingLabel} at ${jointCentralPin.commit.slice(0, 10)} (under test)`,
	() => {
		it("provisioning: the owner's new organization is stamped through the real link and central records it once", async () => {
			// Arrange / Act: ownerReady creates and provisions the organization.
			const owned = await ownerReady();
			try {
				const observed = await observe(owned);
				// Assert: central's own answer to the provisioning send, then both sides' state.
				expect(
					owned.joint.link.events
						.filter((event) => event.path === '/internal/organization-provisioning')
						.map((event) => (event.kind === 'forwarded' ? event.status : event.kind)),
				).toEqual([200]);
				expect(
					await owned.joint.harness.database
						.select({ state: organization.fleetState })
						.from(organization)
						.where(eq(organization.id, owned.organizationId)),
				).toEqual([{ state: 'ready' }]);
				expect(observed.stamp).not.toBeNull();
				// D5: setup's digest read seeded sign-in's record with central's own stored facts.
				const stored = digestReplyFor(observed.statement ?? '');
				expect(await stampRecord(owned)).toEqual({
					digest: stored.digest,
					expiresAt: stored.expiresAt,
					signingKeyId: stored.signingKeyId,
					sent: null,
				});
				expect(
					owned.joint.link.events
						.filter((event) => event.path === '/internal/organization-statement-digest')
						.map((event) => (event.kind === 'forwarded' ? event.status : event.kind)),
				).toEqual([200]);
				expect(
					observed.records.filter((record) => record.kind === 'organizationProvisioned'),
				).toHaveLength(1);
				expect(observed.organizationFloor).toMatchObject({ revision: 1, state: 'active' });
				// The record is dated by the launcher clock, not the system clock.
				expect(
					observed.records
						.filter((record) => record.kind === 'organizationProvisioned')
						.map((record) => record.createdAtMillis),
				).toEqual([controlledSignInClock.now()]);
			} finally {
				await owned.joint.close();
			}
		});

		it('renewal on use: in the 60-day window two concurrent Fleet calls leave one stamp in doubt; both send its exact bytes, central applies it once and answers the replay', async () => {
			// Arrange: one guarded call seeds sign-in's record from central's own digest read.
			const owned = await ownerReady();
			try {
				const before = await observe(owned);
				const storedStatement = before.statement ?? '';
				expect(storedStatement).not.toBe('');
				await guardedDrainPass(owned);
				const expectedFacts = digestReplyFor(storedStatement);
				expect(await stampRecord(owned)).toEqual({
					digest: expectedFacts.digest,
					expiresAt: expectedFacts.expiresAt,
					signingKeyId: expectedFacts.signingKeyId,
					sent: null,
				});
				expect(before.stamp).toMatchObject({
					digest: expectedFacts.digest,
					keyId: expectedFacts.signingKeyId,
					expiresAt: expectedFacts.expiresAt,
				});
				const publishedKeys = z
					.object({ keys: z.array(z.looseObject({ kid: z.string() })) })
					.parse(await (await owned.joint.harness.auth('/api/auth/jwks')).json());
				expect(publishedKeys.keys.map((key) => key.kid)).toContain(expectedFacts.signingKeyId);
				// 61 days on, inside the 120-day statement's 60-day renewal window.
				await owned.joint.setJointTime(owned.now() + 61 * 86_400_000);
				const eventsBefore = owned.joint.link.events.length;
				const first = owned.joint.link.holdNext(isRenewalSend);
				const second = owned.joint.link.holdNext(isRenewalSend);
				// Act: two production drain passes; each push passes its organization's guard. The
				// first signs and claims; the second finds that stamp in doubt and re-sends it.
				const firstRun = guardedDrainPass(owned);
				await first.entered;
				await owned.joint.setJointTime(owned.now() + 1_000);
				const secondRun = guardedDrainPass(owned);
				await second.entered;
				const renewedAt = owned.now();
				second.release();
				await secondRun;
				const afterRenewal = await observe(owned);
				first.release();
				await firstRun;
				const afterReplay = await observe(owned);
				// Assert
				const events = owned.joint.link.events.slice(eventsBefore);
				const held = events.filter((event) => event.kind === 'held');
				expect(held).toHaveLength(2);
				expect(new Set(held.map((event) => event.bodySha256)).size).toBe(1);
				expect(
					events
						.filter(
							(event) =>
								event.path === '/internal/organization-provisioning' && event.kind === 'forwarded',
						)
						.map((event) => event.kind === 'forwarded' && event.status),
				).toEqual([200, 200]);
				// The seeded record decided both calls: no digest read in the window.
				expect(events.filter((event) => isDigestRead(event))).toEqual([]);
				expect(afterRenewal.stamp?.digest).not.toBe(before.stamp?.digest);
				expect(stampExpiry(afterRenewal)).toBeGreaterThan(stampExpiry(before));
				// Central's applying-time witness: one renewal record, at the moved live-Fleet clock.
				expect(
					afterRenewal.records
						.filter((record) => record.kind === 'stampRenewed')
						.map((record) => record.createdAtMillis),
				).toEqual([renewedAt]);
				expect(afterReplay.stamp).toEqual(afterRenewal.stamp);
				expect(afterReplay.records).toEqual(afterRenewal.records);
				// Sign-in's record now names central's stamp, and nothing is left in doubt.
				const renewed = digestReplyFor(afterReplay.statement ?? '');
				expect(await stampRecord(owned)).toEqual({
					digest: renewed.digest,
					expiresAt: renewed.expiresAt,
					signingKeyId: renewed.signingKeyId,
					sent: null,
				});
			} finally {
				await owned.joint.close();
			}
		});

		it('renewal: two distinct signed proposals name the same digest; central applies the first released and refuses the other as stale, its stamp and records unchanged', async () => {
			// Arrange: 61 days on, two production-signed proposals one second apart, both naming
			// central's stored digest. Production sends at most one (rule 1); the proof route sends
			// each through the host's production provisioning client and the real link.
			const owned = await ownerReady();
			try {
				const before = await observe(owned);
				const storedDigest = digestReplyFor(before.statement ?? '').digest;
				await owned.joint.setJointTime(owned.now() + 61 * 86_400_000);
				const first = await signProposal(owned, storedDigest);
				await owned.joint.setJointTime(owned.now() + 1_000);
				const second = await signProposal(owned, storedDigest);
				const eventsBefore = owned.joint.link.events.length;
				const heldFirst = owned.joint.link.holdNext(isRenewalSend);
				const heldSecond = owned.joint.link.holdNext(isRenewalSend);
				// Act: the later proposal is released first.
				const firstSend = sendProposal(owned, first);
				await heldFirst.entered;
				const secondSend = sendProposal(owned, second);
				await heldSecond.entered;
				const renewedAt = owned.now();
				heldSecond.release();
				const secondAnswer = await secondSend;
				const afterRenewal = await observe(owned);
				heldFirst.release();
				const firstAnswer = await firstSend;
				const afterStale = await observe(owned);
				// Assert
				const events = owned.joint.link.events.slice(eventsBefore);
				expect(
					new Set(events.filter((event) => event.kind === 'held').map((event) => event.bodySha256))
						.size,
				).toBe(2);
				expect(
					events
						.filter(
							(event) =>
								event.path === '/internal/organization-provisioning' && event.kind === 'forwarded',
						)
						.map((event) => event.kind === 'forwarded' && event.status),
				).toEqual([200, 409]);
				expect(secondAnswer).toEqual({ kind: 'provisioned' });
				expect(firstAnswer).toEqual({ kind: 'refused', reason: 'stale' });
				expect(afterRenewal.stamp?.digest).toBe(digestReplyFor(second).digest);
				expect(stampExpiry(afterRenewal)).toBeGreaterThan(stampExpiry(before));
				expect(
					afterRenewal.records
						.filter((record) => record.kind === 'stampRenewed')
						.map((record) => record.createdAtMillis),
				).toEqual([renewedAt]);
				expect(afterStale.stamp).toEqual(afterRenewal.stamp);
				expect(afterStale.records).toEqual(afterRenewal.records);
			} finally {
				await owned.joint.close();
			}
		});

		it('revision push: removing a member reaches central as an inactive floor, its ACK is recorded, and the pair reads synced', async () => {
			// Arrange
			const owned = await ownerReady();
			try {
				const { memberId } = await memberJoins(owned);
				const joined = await pairOf(owned, memberId);
				const floorsAfterJoin = (await observe(owned)).personFloors;
				// Act
				const removed = await peoplePost(
					owned.joint.harness,
					'remove-member',
					{ organizationId: owned.organizationId, memberIdOrEmail: memberEmail },
					owned.ownerCookie,
				);
				await owned.joint.harness.settleDeferredWork();
				// Assert: the same subject moved to inactive at the next revision, on both sides.
				expect(removed.status).toBe(200);
				expect(floorsAfterJoin).toContainEqual(
					expect.objectContaining({
						subjectId: joined.id,
						personId: memberId,
						revision: joined.revision,
						state: 'active',
					}),
				);
				const after = await pairOf(owned, memberId);
				expect(after).toMatchObject({
					revision: joined.revision + 1,
					acknowledgedRevision: joined.revision + 1,
					state: 'inactive',
				});
				expect((await observe(owned)).personFloors).toContainEqual(
					expect.objectContaining({
						subjectId: joined.id,
						revision: joined.revision + 1,
						state: 'inactive',
					}),
				);
				expect(await synchronization(owned, memberId)).toBe('synced');
			} finally {
				await owned.joint.close();
			}
		});

		it('lost ACK: central applies the removal but its reply is dropped; the pair stays pending until the next drain at +60 s resends the same bytes', async () => {
			// Arrange
			const owned = await ownerReady();
			try {
				const { memberId } = await memberJoins(owned);
				const joined = await pairOf(owned, memberId);
				const drop = owned.joint.link.dropReplyOfNext(isPersonPush(memberId));
				// Act
				await peoplePost(
					owned.joint.harness,
					'remove-member',
					{ organizationId: owned.organizationId, memberIdOrEmail: memberEmail },
					owned.ownerCookie,
				);
				await owned.joint.harness.settleDeferredWork();
				await drop.dropped;
				const centralAfterDrop = await observe(owned);
				const pairAfterDrop = await pairOf(owned, memberId);
				const syncAfterDrop = await synchronization(owned, memberId);
				const eventsBeforeEarlyDrain = owned.joint.link.events.length;
				expect((await hintDrain(owned)).status).toBe(200);
				const eventsAfterEarlyDrain = owned.joint.link.events.length;
				await owned.joint.setJointTime(owned.now() + 60_000);
				expect((await hintDrain(owned)).status).toBe(200);
				// Assert: central applied it once; sign-in learned of it only from the resend.
				expect(centralAfterDrop.personFloors).toContainEqual(
					expect.objectContaining({
						subjectId: joined.id,
						revision: joined.revision + 1,
						state: 'inactive',
					}),
				);
				expect(pairAfterDrop).toMatchObject({
					revision: joined.revision + 1,
					acknowledgedRevision: joined.revision,
				});
				expect(syncAfterDrop).toBe('pending');
				expect(eventsAfterEarlyDrain).toBe(eventsBeforeEarlyDrain);
				const dropped = owned.joint.link.events.find((event) => event.kind === 'reply-dropped');
				const resent = owned.joint.link.events.at(-1);
				expect(resent).toMatchObject({
					kind: 'forwarded',
					status: 200,
					bodySha256: dropped?.bodySha256,
				});
				expect(await pairOf(owned, memberId)).toMatchObject({
					acknowledgedRevision: joined.revision + 1,
				});
				expect(await synchronization(owned, memberId)).toBe('synced');
			} finally {
				await owned.joint.close();
			}
		});

		it("admin page: the owner's create, lookup and records apply in central; a member's are refused notPermitted with no effect", async () => {
			// Arrange
			const owned = await ownerReady();
			try {
				const operationId = controlledSignInIds.nextId();
				// Act: the owner, through the cookie-only forwarding routes.
				const created = await adminPost(
					owned,
					'create-workspace',
					{ organizationId: owned.organizationId, operationId, name: 'research', description: '' },
					owned.ownerCookie,
				);
				// Central's verdict first: a refused credential shows as the forwarder's 502 body.
				const createdBody: unknown = await created.json();
				expect([created.status, createdBody]).toMatchObject([200, { result: 'applied' }]);
				const createdResult = z
					.object({
						result: z.literal('applied'),
						workspace: z.object({ workspaceId: z.string() }),
					})
					.parse(createdBody);
				const lookedUp = await adminPost(
					owned,
					'workspace-lookup',
					{
						organizationId: owned.organizationId,
						workspaceId: createdResult.workspace.workspaceId,
					},
					owned.ownerCookie,
				);
				const listed = await adminPost(
					owned,
					'change-records',
					{ organizationId: owned.organizationId, after: null, limit: 100 },
					owned.ownerCookie,
				);
				const afterOwner = await observe(owned);
				const { memberCookie } = await memberJoins(owned);
				const beforeMember = await observe(owned);
				const memberAnswers = await Promise.all([
					adminPost(
						owned,
						'create-workspace',
						{
							organizationId: owned.organizationId,
							operationId: controlledSignInIds.nextId(),
							name: 'blocked',
							description: '',
						},
						memberCookie,
					),
					adminPost(
						owned,
						'workspace-lookup',
						{
							organizationId: owned.organizationId,
							workspaceId: createdResult.workspace.workspaceId,
						},
						memberCookie,
					),
					adminPost(
						owned,
						'change-records',
						{ organizationId: owned.organizationId, after: null, limit: 10 },
						memberCookie,
					),
				]);
				const afterMember = await observe(owned);
				// Assert
				expect(await lookedUp.json()).toMatchObject({
					result: 'found',
					workspace: { workspaceId: createdResult.workspace.workspaceId, name: 'research' },
				});
				expect(await listed.json()).toMatchObject({ result: 'records' });
				expect(afterOwner.workspaces).toContainEqual(
					expect.objectContaining({
						workspaceId: createdResult.workspace.workspaceId,
						name: 'research',
					}),
				);
				expect(afterOwner.records).toContainEqual(
					expect.objectContaining({ kind: 'workspaceCreated', requestId: operationId }),
				);
				expect(
					await Promise.all(
						memberAnswers.map(async (answer) => [answer.status, await answer.json()]),
					),
				).toEqual(memberAnswers.map(() => [200, { result: 'refused', reason: 'notPermitted' }]));
				expect(afterMember.workspaces).toEqual(beforeMember.workspaces);
				expect(afterMember.records).toEqual(beforeMember.records);
				expect(afterMember.usedRequests).toEqual(beforeMember.usedRequests);
			} finally {
				await owned.joint.close();
			}
		});

		it('owner CLI through the relay: create, then a same-key refresh, then lookup, all applied by real central', async () => {
			// Arrange
			const owned = await ownerReady();
			try {
				const sent: Parameters<typeof fleetCliIoFor>[0]['sent'] = [];
				const io = fleetCliIoFor({
					harness: owned.joint.harness,
					cookie: owned.ownerCookie,
					now: owned.now,
					sent,
				});
				const target = requireFleetTarget({
					...owned.joint.harness.target,
					organizationId: owned.organizationId,
				});
				const store = createMemoryProofKeyStore(webSignInCrypto);
				const operationId = controlledSignInIds.nextId();
				const command = (
					session: FleetCliSession,
					operation: FleetAdminRequest,
				): ReturnType<typeof runFleetAdminCommand> =>
					runFleetAdminCommand({
						target,
						store,
						session,
						operation,
						io,
						confirmSecondFactor: async () => false,
					});
				// Act
				const session = await signInFleetCli({ target, store, io });
				const created = await command(session, {
					operation: 'CreateWorkspace',
					organizationId: owned.organizationId,
					operationId,
					name: 'cli-research',
					description: '',
				});
				const refreshed = await refreshFleetCli({ target, store, io });
				if (refreshed === null) throw new Error('Refresh refused');
				const workspaceId =
					created.kind === 'answered' && created.result.result === 'applied'
						? created.result.workspace.workspaceId
						: '';
				const lookedUp = await command(refreshed, {
					operation: 'WorkspaceLookup',
					organizationId: owned.organizationId,
					workspaceId,
				});
				// Assert
				expect(created).toMatchObject({ kind: 'answered', result: { result: 'applied' } });
				expect(lookedUp).toMatchObject({
					kind: 'answered',
					result: { result: 'found', workspace: { workspaceId, name: 'cli-research' } },
				});
				const observed = await observe(owned);
				expect(observed.records).toContainEqual(
					expect.objectContaining({
						kind: 'workspaceCreated',
						requestId: operationId,
						targetId: workspaceId,
					}),
				);
				expect(
					sent.filter((request) =>
						request.url.pathname.startsWith('/api/auth/organization-admin/v1/'),
					),
				).toHaveLength(2);
			} finally {
				await owned.joint.close();
			}
		});

		it("duplicate name from the admin page: central answers nameInUse, the page's one lookup at its own operation finds nothing, and it shows the nameInUse words; workspaces and records are unchanged", async () => {
			// Arrange: the owner has created "shared-name" through the API route.
			const owned = await ownerReady();
			try {
				const created = await adminPost(
					owned,
					'create-workspace',
					{
						organizationId: owned.organizationId,
						operationId: controlledSignInIds.nextId(),
						name: 'shared-name',
						description: '',
					},
					owned.ownerCookie,
				);
				expect(await created.json()).toMatchObject({ result: 'applied' });
				const page = await openOrganizationAdminPage({
					harness: owned.joint.harness,
					cookie: owned.ownerCookie,
				});
				const before = await observe(owned);
				const replies = owned.joint.link.captureReplies(isCreateWorkspace);
				// The page's own load looked the existing workspace up; only the submit's requests count.
				const loadRequests = page.requests.length;
				// Act: the same name in other case, from another operation.
				const shown = await page.submitCreate({ name: 'Shared-Name' });
				const after = await observe(owned);
				// Assert
				expect(shown).toBe('A workspace with that name already exists.');
				expect(replies.map((reply) => [reply.status, reply.body])).toEqual([
					[200, { result: 'refused', reason: 'nameInUse' }],
				]);
				const sent = page.requests
					.slice(loadRequests)
					.filter((request) => /\/(create-workspace|workspace-lookup)$/u.test(request.path));
				const operationId = z.object({ operationId: z.string() }).parse(sent[0]?.body).operationId;
				expect(sent.map((request) => request.path.split('/').at(-1))).toEqual([
					'create-workspace',
					'workspace-lookup',
				]);
				expect(sent[1]?.body).toEqual({
					organizationId: owned.organizationId,
					workspaceId: operationId,
				});
				expect(page.reloads()).toBe(0);
				// An admitted refusal consumes its proof; the workspace and record sets do not change.
				expect(after.workspaces).toEqual(before.workspaces);
				expect(after.records).toEqual(before.records);
			} finally {
				await owned.joint.close();
			}
		});

		it('replay within 24 hours: the same create sent again gets byte-identical bytes back, and central holds one workspace and one workspaceCreated record', async () => {
			// Arrange
			const owned = await ownerReady();
			try {
				const operationId = controlledSignInIds.nextId();
				const body = {
					organizationId: owned.organizationId,
					operationId,
					name: 'replayed',
					description: '',
				};
				const replies = owned.joint.link.captureReplies(isCreateWorkspace);
				// Act: two sends, each with its own fresh credential and proof.
				const first = await adminPost(owned, 'create-workspace', body, owned.ownerCookie);
				await owned.joint.setJointTime(owned.now() + 60_000);
				const second = await adminPost(owned, 'create-workspace', body, owned.ownerCookie);
				const answers = [await first.json(), await second.json()];
				const observed = await observe(owned);
				// Assert
				expect([first.status, second.status]).toEqual([200, 200]);
				expect(answers[1]).toEqual(answers[0]);
				expect(replies).toHaveLength(2);
				expect(replies[0]?.body).toMatchObject({
					result: 'applied',
					workspace: { workspaceId: operationId, name: 'replayed' },
				});
				expect([replies[1]?.bodySha256, replies[1]?.bodyLength]).toEqual([
					replies[0]?.bodySha256,
					replies[0]?.bodyLength,
				]);
				expect(workspaceCreatedFor(observed, operationId)).toHaveLength(1);
				expect(observed.workspaces.filter((workspace) => workspace.name === 'replayed')).toEqual([
					{ workspaceId: operationId, name: 'replayed' },
				]);
			} finally {
				await owned.joint.close();
			}
		});

		it('late retry from the admin page: the first create applies but its reply is lost; past 24 hours the same operation meets nameInUse, one lookup finds its own workspace, and the page reports it created', async () => {
			// Arrange
			const owned = await ownerReady();
			try {
				const page = await openOrganizationAdminPage({
					harness: owned.joint.harness,
					cookie: owned.ownerCookie,
				});
				const drop = owned.joint.link.dropReplyOfNext(isCreateWorkspace);
				const lost = await page.submitCreate({ name: 'late-page' });
				await drop.dropped;
				const afterLost = await observe(owned);
				await owned.joint.setJointTime(owned.now() + pastReplayWindowMs);
				await confirmOwnerApp(owned);
				const replies = owned.joint.link.captureReplies(isCreateWorkspace);
				// Act: the person tries again on the same page.
				const shown = await page.submitCreate({ name: 'late-page' });
				const after = await observe(owned);
				// Assert
				expect(lost).toBe('Central is unavailable. Try again.');
				expect(shown).toBe('Workspace created.');
				expect(page.reloads()).toBe(1);
				expect(replies.map((reply) => [reply.status, reply.body])).toEqual([
					[200, { result: 'refused', reason: 'nameInUse' }],
				]);
				const sent = page.requests.filter((request) =>
					/\/(create-workspace|workspace-lookup)$/u.test(request.path),
				);
				const operationIds = sent.map((request) =>
					z
						.object({ operationId: z.string().optional(), workspaceId: z.string().optional() })
						.parse(request.body),
				);
				expect(sent.map((request) => request.path.split('/').at(-1))).toEqual([
					'create-workspace',
					'create-workspace',
					'workspace-lookup',
				]);
				expect(operationIds[1]?.operationId).toBe(operationIds[0]?.operationId);
				expect(operationIds[2]?.workspaceId).toBe(operationIds[0]?.operationId);
				expect(workspaceCreatedFor(after, operationIds[0]?.operationId ?? '')).toHaveLength(1);
				expect(after.workspaces).toEqual(afterLost.workspaces);
				expect(after.records).toEqual(afterLost.records);
			} finally {
				await owned.joint.close();
			}
		});

		it('late retry from the owner CLI: the first create applies but its reply is lost; past 24 hours the repeated command meets nameInUse, one lookup finds its own workspace, and the CLI prints "Workspace created."', async () => {
			// Arrange
			const owned = await ownerReady();
			try {
				const cli = { store: createMemoryProofKeyStore(webSignInCrypto), sent: [] };
				const operationId = controlledSignInIds.nextId();
				const drop = owned.joint.link.dropReplyOfNext(isCreateWorkspace);
				const lost = await ownerCliCreate(owned, cli, { operationId, name: 'late-cli' });
				await drop.dropped;
				const afterLost = await observe(owned);
				await owned.joint.setJointTime(owned.now() + pastReplayWindowMs);
				await confirmOwnerApp(owned);
				const replies = owned.joint.link.captureReplies(isAdminRoute);
				// Act: the repeat the CLI itself suggested.
				const repeated = await ownerCliCreate(owned, cli, { operationId, name: 'late-cli' });
				const after = await observe(owned);
				// Assert
				expect(lost).toEqual({
					exitCode: 1,
					lines: [
						`Central did not answer. Repeat the command with --operation-id ${operationId}; it will not run twice.`,
					],
				});
				expect(repeated.exitCode).toBe(0);
				expect(repeated.lines[0]).toBe('Workspace created.');
				expect(JSON.parse(repeated.lines[1] ?? 'null')).toMatchObject({
					workspace: { workspaceId: operationId, name: 'late-cli' },
				});
				expect(replies.map((reply) => [reply.status, reply.body])).toEqual([
					[200, { result: 'refused', reason: 'nameInUse' }],
					[
						200,
						expect.objectContaining({
							result: 'found',
							workspace: expect.objectContaining({ workspaceId: operationId }),
						}),
					],
				]);
				expect(workspaceCreatedFor(after, operationId)).toHaveLength(1);
				expect(after.workspaces).toEqual(afterLost.workspaces);
				expect(after.records).toEqual(afterLost.records);
			} finally {
				await owned.joint.close();
			}
		});

		it('conflict on the admin page: a lost reply keeps the operation; a changed name under it is a conflict with its own words, and the next try applies under a fresh operation', async () => {
			// Arrange
			const owned = await ownerReady();
			try {
				const page = await openOrganizationAdminPage({
					harness: owned.joint.harness,
					cookie: owned.ownerCookie,
				});
				const drop = owned.joint.link.dropReplyOfNext(isCreateWorkspace);
				const lost = await page.submitCreate({ name: 'first-name' });
				await drop.dropped;
				const replies = owned.joint.link.captureReplies(isCreateWorkspace);
				// Act: the person edits the name and tries again, then once more.
				const conflicted = await page.submitCreate({ name: 'second-name' });
				const retried = await page.submitCreate({ name: 'second-name' });
				const after = await observe(owned);
				// Assert
				expect(lost).toBe('Central is unavailable. Try again.');
				expect(conflicted).toBe(
					'That request was already used for a different workspace. Try again.',
				);
				expect(retried).toBe('Workspace created.');
				expect(replies.map((reply) => reply.body)).toEqual([
					{ result: 'refused', reason: 'conflict' },
					expect.objectContaining({ result: 'applied' }),
				]);
				const creates = page.requests
					.filter((request) => request.path.endsWith('/create-workspace'))
					.map((request) =>
						z.object({ operationId: z.string(), name: z.string() }).parse(request.body),
					);
				expect(creates.map((create) => create.name)).toEqual([
					'first-name',
					'second-name',
					'second-name',
				]);
				expect(creates[1]?.operationId).toBe(creates[0]?.operationId);
				expect(creates[2]?.operationId).not.toBe(creates[0]?.operationId);
				expect(after.workspaces.map((workspace) => workspace.name).toSorted()).toEqual([
					'first-name',
					'second-name',
				]);
				expect(workspaceCreatedFor(after, creates[0]?.operationId ?? '')).toHaveLength(1);
				expect(workspaceCreatedFor(after, creates[2]?.operationId ?? '')).toHaveLength(1);
			} finally {
				await owned.joint.close();
			}
		});

		it("drifted and expired stamp (R29, R-adopt): central's digest read answers its expired facts; sign-in adopts them on the stale refusal and releases no push, then its next call replaces central's digest and its push goes out", async () => {
			// Arrange: central applies a proposal sign-in never confirmed, so the two drift.
			const owned = await ownerReady();
			try {
				const before = await observe(owned);
				const signInDigest = digestReplyFor(before.statement ?? '').digest;
				const drifted = await signProposal(owned, signInDigest);
				expect(await sendProposal(owned, drifted)).toEqual({ kind: 'provisioned' });
				const driftedFacts = digestReplyFor(drifted);
				expect(await stampRecord(owned)).toMatchObject({ digest: signInDigest, sent: null });
				// Both stamps are past their 120-day lifetime.
				await owned.joint.setJointTime(owned.now() + 121 * 86_400_000);
				const beforeFirst = await observe(owned);
				const firstEvents = owned.joint.link.events.length;
				// Act 1: one real Fleet call (a production drain pass through the stamp guard).
				await guardedDrainPass(owned);
				const afterFirst = await observe(owned);
				const adopted = await stampRecord(owned);
				const firstSent = owned.joint.link.events.slice(firstEvents);
				const secondEvents = owned.joint.link.events.length;
				// Act 2: the next one.
				await guardedDrainPass(owned);
				const afterSecond = await observe(owned);
				const secondSent = owned.joint.link.events.slice(secondEvents);
				// Assert 1: stale, then central's expired facts adopted; no revision push went out.
				const forwarded = (events: typeof firstSent): readonly (readonly [string, number])[] =>
					events.flatMap((event) =>
						event.kind === 'forwarded' ? [[event.path, event.status] as const] : [],
					);
				expect(forwarded(firstSent)).toEqual([
					['/internal/organization-provisioning', 409],
					['/internal/organization-statement-digest', 200],
				]);
				expect(adopted).toMatchObject({
					digest: driftedFacts.digest,
					expiresAt: driftedFacts.expiresAt,
					sent: null,
				});
				expect(afterFirst.statement).toBe(drifted);
				// Central is untouched by the first call: still its own expired stamp, no new record.
				expect(afterFirst.stamp).toEqual(beforeFirst.stamp);
				expect(afterFirst.records).toEqual(beforeFirst.records);
				// Assert 2: a Replace of central's digest applies, then the revision push goes out.
				expect(forwarded(secondSent)).toEqual([
					['/internal/organization-provisioning', 200],
					['/internal/organization-authorization-revisions', 200],
				]);
				// Sign-in's record settled on the stamp central now holds, and the push was ACKed.
				const renewedFacts = digestReplyFor(afterSecond.statement ?? '');
				expect(await stampRecord(owned)).toMatchObject({
					digest: renewedFacts.digest,
					expiresAt: renewedFacts.expiresAt,
					sent: null,
				});
				expect(afterSecond.stamp).toMatchObject({
					digest: renewedFacts.digest,
					expiresAt: renewedFacts.expiresAt,
				});
				const organizationFence = (
					await owned.joint.harness.database
						.select({
							revision: organizationAuthorizationRevisions.revision,
							acknowledgedRevision: organizationAuthorizationRevisions.acknowledgedRevision,
						})
						.from(organizationAuthorizationRevisions)
						.where(eq(organizationAuthorizationRevisions.id, owned.organizationId))
				)[0];
				expect(organizationFence?.acknowledgedRevision).toBe(organizationFence?.revision);
				expect(statementClaims(afterSecond.statement ?? '')['replaces']).toBe(driftedFacts.digest);
				expect(stampExpiry(afterSecond)).toBeGreaterThan(owned.now() / 1000);
				expect(afterSecond.records.filter((record) => record.kind === 'stampRenewed').length).toBe(
					afterFirst.records.filter((record) => record.kind === 'stampRenewed').length + 1,
				);
			} finally {
				await owned.joint.close();
			}
		});

		// Boundary: native fenced sign-out, the real periodic drain and
		// Rust's refusal. Not the product public sign-out route or its automatic drain hint, which
		// slice 4 proves at component level.
		it("revoked token (native fence, real drain, Rust refusal): after the owner's native sign-out, with the hint's push held, the old token's next relay first delivers the revocation through its own guard, so central refuses it refreshRequired with no effect", async () => {
			// Arrange: the owner's CLI token, admitted by central.
			const owned = await ownerReady();
			try {
				const io = fleetCliIoFor({
					harness: owned.joint.harness,
					cookie: owned.ownerCookie,
					now: owned.now,
					sent: [],
				});
				const target: FleetTarget = requireFleetTarget({
					...owned.joint.harness.target,
					organizationId: owned.organizationId,
				});
				const store = createMemoryProofKeyStore(webSignInCrypto);
				const session = await signInFleetCli({ target, store, io });
				const readRecords = (): ReturnType<typeof runFleetAdminCommand> =>
					runFleetAdminCommand({
						target,
						store,
						session,
						operation: {
							operation: 'ReadChangeRecords',
							organizationId: owned.organizationId,
							after: null,
							limit: 10,
						},
						io,
						confirmSecondFactor: async () => false,
					});
				expect(await readRecords()).toMatchObject({
					kind: 'answered',
					result: { result: 'records' },
				});
				const ownerPairBefore = await pairOf(owned, owned.ownerId);
				// Act: native sign-out bumps the owner's pair; the hint's own push is held at the link.
				const signOut = await owned.joint.harness.auth('/__auth-proof/authorization-fence', {
					method: 'POST',
					headers: { 'content-type': 'application/json', cookie: owned.ownerCookie },
					body: JSON.stringify({ kind: 'native', path: 'sign-out', body: {} }),
				});
				expect(signOut.status).toBe(200);
				const hold = owned.joint.link.holdNext(isPersonPush(owned.ownerId));
				const drained = hintDrain(owned);
				await hold.entered;
				const beforeRelay = await observe(owned);
				const eventsBefore = owned.joint.link.events.length;
				// WS3, Lead Q1 = A: the relay's guard delivers the pending revocation before the call.
				const duringHeldHint = await readRecords();
				const afterRelay = await observe(owned);
				const relayEvents = owned.joint.link.events.slice(eventsBefore);
				hold.release();
				expect((await drained).status).toBe(200);
				// Assert: the floor, delivered first by the relay's own guard, did the refusing.
				expect(beforeRelay.personFloors).not.toContainEqual(
					expect.objectContaining({
						personId: owned.ownerId,
						revision: ownerPairBefore.revision + 1,
					}),
				);
				const forwardedPaths = relayEvents
					.filter((event) => event.kind === 'forwarded')
					.map((event) => event.path);
				const revocationIndex = forwardedPaths.indexOf(
					'/internal/organization-authorization-revisions',
				);
				const adminIndex = forwardedPaths.findIndex((path) =>
					path.startsWith('/organization-admin/'),
				);
				expect(revocationIndex).toBeGreaterThanOrEqual(0);
				expect(adminIndex).toBeGreaterThan(revocationIndex);
				expect(duringHeldHint).toEqual({
					kind: 'answered',
					result: { result: 'refused', reason: 'refreshRequired' },
				});
				expect(await pairOf(owned, owned.ownerId)).toMatchObject({
					revision: ownerPairBefore.revision + 1,
					acknowledgedRevision: ownerPairBefore.revision + 1,
				});
				expect(afterRelay.personFloors).toContainEqual(
					expect.objectContaining({
						personId: owned.ownerId,
						revision: ownerPairBefore.revision + 1,
						state: 'active',
					}),
				);
				// The refusal itself adds no marker, record or workspace row. Floors are not compared:
				// the guard delivered the owner's floor above, by design (R-observe qualification).
				expect(afterRelay.usedRequests).toEqual(beforeRelay.usedRequests);
				expect(afterRelay.records).toEqual(beforeRelay.records);
				expect(afterRelay.workspaces).toEqual(beforeRelay.workspaces);
				// The released hint push replays a floor central already holds: still refused after.
				expect(await readRecords()).toEqual({
					kind: 'answered',
					result: { result: 'refused', reason: 'refreshRequired' },
				});
			} finally {
				await owned.joint.close();
			}
		});

		it("central restarts empty (WS7 R-notdue, R-floors): the owner's next admin call meets central's 503, sign-in probes none, sets the organization up again, pushes its floors again and the retried call is answered", async () => {
			// Arrange: steady state, provisioned with its floors pushed; the stamp is not due.
			const owned = await ownerReady();
			try {
				const before = await observe(owned);
				expect(before.organizationFloor).not.toBeNull();
				const pairs = (await fenceAcks(owned)).pairs.length;
				expect(pairs).toBeGreaterThan(0);
				await owned.joint.restartCentralEmpty();
				const eventsBefore = owned.joint.link.events.length;
				// Act: an ordinary admin call through sign-in, on the first use after the restart.
				const listed = await adminPost(
					owned,
					'change-records',
					{ organizationId: owned.organizationId, after: null, limit: 100 },
					owned.ownerCookie,
				);
				// Assert: answered on that first use, by the one retry after the recovery.
				expect([listed.status, await listed.json()]).toMatchObject([200, { result: 'records' }]);
				expect(linkSince(owned, eventsBefore)).toEqual([
					'admin:503',
					'digest:404',
					'setup:200',
					'digest:200',
					...Array.from({ length: 1 + pairs }, () => 'push:200'),
					'admin:200',
				]);
				await expectRecoveredOnBothSides(owned);
			} finally {
				await owned.joint.close();
			}
		});

		it("central restarts empty (WS7 R-push503): a member removed after the restart leaves a pending revision; the owner's next call meets central's 503 on that push, recovers and then goes out, with the removal applied", async () => {
			// Arrange: a member joined before the restart; their removal comes after it.
			const owned = await ownerReady();
			try {
				const { memberId } = await memberJoins(owned);
				const joined = await pairOf(owned, memberId);
				await owned.joint.restartCentralEmpty();
				const removed = await peoplePost(
					owned.joint.harness,
					'remove-member',
					{ organizationId: owned.organizationId, memberIdOrEmail: memberEmail },
					owned.ownerCookie,
				);
				expect(removed.status).toBe(200);
				await owned.joint.harness.settleDeferredWork();
				expect(await pairOf(owned, memberId)).toMatchObject({
					revision: joined.revision + 1,
					state: 'inactive',
				});
				expect((await pairOf(owned, memberId)).acknowledgedRevision).toBeLessThan(
					joined.revision + 1,
				);
				const pairs = (await fenceAcks(owned)).pairs.length;
				const eventsBefore = owned.joint.link.events.length;
				// Act: the owner's next admin call.
				const listed = await adminPost(
					owned,
					'change-records',
					{ organizationId: owned.organizationId, after: null, limit: 100 },
					owned.ownerCookie,
				);
				// Assert: the push met central's 503 first; recovery delivered every floor, the
				// removal included, before the call went out once.
				expect([listed.status, await listed.json()]).toMatchObject([200, { result: 'records' }]);
				expect(linkSince(owned, eventsBefore)).toEqual([
					'push:503',
					'digest:404',
					'setup:200',
					'digest:200',
					...Array.from({ length: 1 + pairs }, () => 'push:200'),
					'admin:200',
				]);
				await expectRecoveredOnBothSides(owned);
				expect(await synchronization(owned, memberId)).toBe('synced');
			} finally {
				await owned.joint.close();
			}
		});
	},
);
