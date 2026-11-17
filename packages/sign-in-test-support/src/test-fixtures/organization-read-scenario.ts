import { invitation, member, session, user } from '@agent-collaboration/sign-in-core';
import { and, eq } from 'drizzle-orm';
import { expect } from 'vitest';
import { z } from 'zod';

import {
	controlledSignInClock,
	controlledSignInIds,
} from '#sign-in-test-support/test-fixtures/controlled-sign-in-clock';
import { readCurrentBrowserSession } from '#sign-in-test-support/test-fixtures/current-browser-session';
import {
	captureExpiredSessionCleanup,
	expectExpiredSessionCleanup,
} from '#sign-in-test-support/test-fixtures/expired-session-cleanup-proof';
import { startLocalAuthHarness } from '#sign-in-test-support/test-fixtures/local-auth-harness';
import { ensureLocalOwnerOrganization } from '#sign-in-test-support/test-fixtures/local-owner-organization';
import { organizationReadProbeHeader } from '#sign-in-test-support/test-fixtures/organization-read-proof';
import {
	peoplePost,
	signInConfirmedPeopleBrowser,
} from '#sign-in-test-support/test-fixtures/people-browser-login';
import { allSignInRowFingerprints } from '#sign-in-test-support/test-fixtures/stored-row-fingerprints';

export type OrganizationReadHarness = Awaited<ReturnType<typeof startLocalAuthHarness>>;
export interface OrganizationReadScenario {
	readonly harness: OrganizationReadHarness;
	readonly ownerId: string;
	readonly ownerCookie: string;
	readonly ownerSessionId: string;
	readonly organizationId: string;
	readonly otherOrganizationId: string;
}
export type OrganizationReadKind = 'lookup' | 'list';

/** Case order matters: each request gets its own before/after storage proof. */
export function runOrganizationReadCases<TCase>(
	cases: readonly TCase[],
	runCase: (testCase: TCase) => Promise<void>,
): Promise<void> {
	return cases.reduce(async (previous: Promise<void>, testCase: TCase): Promise<void> => {
		await previous;
		await runCase(testCase);
	}, Promise.resolve());
}

/** Real social sign-in, factor confirmation and native organization creation. */
export async function createOrganizationReadScenario(): Promise<OrganizationReadScenario> {
	const harness = await startLocalAuthHarness();
	try {
		harness.centralProvisioning.replyWith('provisioned');
		const ownerId = await signInConfirmedPeopleBrowser({ harness, email: 'owner@example.invalid' });
		const organizationId = await ensureLocalOwnerOrganization({
			auth: harness.auth,
			database: harness.database,
		});
		const created = await peoplePost(harness, 'create', {
			name: 'Other organization canary',
			slug: 'other-read-organization',
		});
		expect(created.status).toBe(200);
		const otherOrganizationId = z.object({ id: z.uuidv7() }).parse(await created.json()).id;
		expect((await peoplePost(harness, 'set-active', { organizationId })).status).toBe(200);
		const ownerCookie = harness.cookie();
		const current = await readCurrentBrowserSession({
			cookie: ownerCookie,
			database: harness.database,
		});
		await harness.settleDeferredWork();
		return {
			harness,
			ownerId,
			ownerCookie,
			ownerSessionId: current.id,
			organizationId,
			otherOrganizationId,
		};
	} catch (error) {
		await harness.close();
		throw error;
	}
}

export async function inviteOrganizationReadPerson(props: {
	readonly scenario: OrganizationReadScenario;
	readonly email: string;
	readonly organizationId?: string;
}): Promise<string> {
	const { scenario, email } = props;
	const response = await peoplePost(
		scenario.harness,
		'invite-member',
		{
			organizationId: props.organizationId ?? scenario.organizationId,
			email,
			role: 'member',
		},
		scenario.ownerCookie,
	);
	// Native people changes intentionally remain part of the arrangement.
	expect(response.status).toBe(200);
	return z.object({ id: z.uuidv7() }).parse(await response.json()).id;
}

export async function joinOrganizationReadPerson(props: {
	readonly scenario: OrganizationReadScenario;
	readonly email: string;
	readonly organizationId?: string;
}): Promise<{ readonly personId: string; readonly cookie: string; readonly invitationId: string }> {
	const invitationId = await inviteOrganizationReadPerson(props);
	const personId = await signInConfirmedPeopleBrowser({
		harness: props.scenario.harness,
		email: props.email,
	});
	expect(
		(await peoplePost(props.scenario.harness, 'accept-invitation', { invitationId })).status,
	).toBe(200);
	expect(
		(
			await peoplePost(props.scenario.harness, 'set-active', {
				organizationId: props.organizationId ?? props.scenario.organizationId,
			})
		).status,
	).toBe(200);
	await props.scenario.harness.settleDeferredWork();
	return { personId, cookie: props.scenario.harness.cookie(), invitationId };
}

/** Deliberately labelled fixture rows supply histories native writes cannot produce on demand. */
export async function seedOrganizationReadInvitation(props: {
	readonly scenario: OrganizationReadScenario;
	readonly id?: string;
	readonly email: string;
	readonly status?: string;
	readonly expiresAt?: Date;
	readonly role?: string;
	readonly organizationId?: string;
}): Promise<string> {
	const id = z.uuidv7().parse(props.id ?? controlledSignInIds.nextId());
	await props.scenario.harness.database.insert(invitation).values({
		id,
		organizationId: props.organizationId ?? props.scenario.organizationId,
		email: props.email,
		role: props.role ?? 'member',
		status: props.status ?? 'pending',
		expiresAt: props.expiresAt ?? new Date(controlledSignInClock.now() + 60_000),
		createdAt: new Date(controlledSignInClock.now()),
		inviterId: props.scenario.ownerId,
	});
	return id;
}

export async function setOrganizationReadClock(
	harness: OrganizationReadHarness,
	milliseconds: number,
): Promise<void> {
	const response = await harness.auth('/__auth-proof/set-clock', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ milliseconds }),
	});
	expect(response.status).toBe(200);
}

export function organizationReadPath(
	scenario: OrganizationReadScenario,
	kind: OrganizationReadKind,
): string {
	return kind === 'lookup'
		? '/api/auth/organization/person-membership'
		: `/api/auth/organization/people-list?organizationId=${scenario.organizationId}&offset=0`;
}

export function requestOrganizationRead(props: {
	readonly scenario: OrganizationReadScenario;
	readonly kind: OrganizationReadKind;
	readonly cookie?: string;
	readonly headers?: Readonly<Record<string, string>>;
	readonly email?: string;
}): Promise<Response> {
	return props.scenario.harness.auth(organizationReadPath(props.scenario, props.kind), {
		method: props.kind === 'lookup' ? 'POST' : 'GET',
		headers: {
			cookie: props.cookie ?? props.scenario.ownerCookie,
			...(props.kind === 'lookup' ? { 'content-type': 'application/json' } : {}),
			...props.headers,
		},
		...(props.kind === 'lookup'
			? {
					body: JSON.stringify({
						organizationId: props.scenario.organizationId,
						email: props.email ?? 'owner@example.invalid',
					}),
				}
			: {}),
	});
}

/** Snapshot every table, including factors, before and after each read. */
export async function expectUnchangedOrganizationRead(props: {
	readonly harness: OrganizationReadHarness;
	readonly request: () => Promise<Response>;
	readonly status: number;
	readonly body: unknown;
}): Promise<string> {
	await props.harness.settleDeferredWork();
	const before = await allSignInRowFingerprints(props.harness);
	const response = await props.request();
	const body = await response.text();
	expect(response.status).toBe(props.status);
	expect(JSON.parse(body)).toEqual(props.body);
	expect(response.headers.get('cache-control')).toBe('no-store');
	expect(await allSignInRowFingerprints(props.harness)).toEqual(before);
	return body;
}

export async function organizationReadCounts(
	harness: OrganizationReadHarness,
): Promise<{ readonly lookup: number; readonly list: number }> {
	const response = await harness.auth('/__auth-proof/database-control');
	expect(response.status).toBe(200);
	return z
		.object({
			organizationReads: z.strictObject({
				lookup: z.number().int().nonnegative(),
				list: z.number().int().nonnegative(),
			}),
		})
		.parse(await response.json()).organizationReads;
}

export type OrganizationReadRevocation =
	| 'ended'
	| 'expired'
	| 'organization-changed'
	| 'permission-lost';
export type OrganizationReadRefusal =
	| 'member'
	| 'foreign-owner'
	| 'removed-owner'
	| 'ended'
	| 'expired'
	| 'signed-out';

export async function expectOrganizationReadRefusal(props: {
	readonly scenario: OrganizationReadScenario;
	readonly kind: OrganizationReadKind;
	readonly refusal: OrganizationReadRefusal;
}): Promise<void> {
	const { scenario, refusal } = props;
	const { harness } = scenario;
	let cookie = scenario.ownerCookie;
	if (refusal === 'member' || refusal === 'foreign-owner' || refusal === 'removed-owner') {
		const person = await joinOrganizationReadPerson({
			scenario,
			email: `${refusal}@example.invalid`,
			organizationId:
				refusal === 'foreign-owner' ? scenario.otherOrganizationId : scenario.organizationId,
		});
		cookie = person.cookie;
		if (refusal === 'foreign-owner')
			await harness.database
				.update(member)
				.set({ role: 'owner' })
				.where(eq(member.userId, person.personId));
		if (refusal === 'removed-owner') {
			// Fixture owner removal: native owner-removal protections are covered separately.
			await harness.database
				.update(member)
				.set({ role: 'owner' })
				.where(eq(member.userId, person.personId));
			await harness.database
				.delete(member)
				.where(
					and(
						eq(member.userId, person.personId),
						eq(member.organizationId, scenario.organizationId),
					),
				);
		}
	} else if (refusal === 'signed-out') cookie = '';
	else if (refusal === 'ended')
		await harness.database.delete(session).where(eq(session.id, scenario.ownerSessionId));
	else {
		await harness.database
			.update(session)
			.set({ expiresAt: new Date(controlledSignInClock.now() + 1_000) })
			.where(eq(session.id, scenario.ownerSessionId));
		expect(
			await harness.database
				.select({ expiresAt: session.expiresAt })
				.from(session)
				.where(eq(session.id, scenario.ownerSessionId)),
		).toEqual([{ expiresAt: new Date(controlledSignInClock.now() + 1_000) }]);
		await setOrganizationReadClock(harness, controlledSignInClock.now() + 1_001);
	}
	await harness.settleDeferredWork();
	const before = await allSignInRowFingerprints(harness);
	const expiredCleanup = refusal === 'expired' ? await captureExpiredSessionCleanup(harness) : null;
	const counts = await organizationReadCounts(harness);
	const response = await requestOrganizationRead({
		scenario,
		kind: props.kind,
		cookie,
	});
	expect(response.status).toBe(
		['member', 'foreign-owner', 'removed-owner'].includes(refusal) ? 403 : 401,
	);
	expect(await response.json()).toEqual({ kind: 'refused' });
	expect(response.headers.get('cache-control')).toBe('no-store');
	expect((await organizationReadCounts(harness))[props.kind]).toBe(counts[props.kind]);
	if (expiredCleanup !== null)
		await expectExpiredSessionCleanup({
			harness,
			before: expiredCleanup,
			response,
			sessionId: scenario.ownerSessionId,
			personId: scenario.ownerId,
			now: controlledSignInClock.now() + 1_001,
		});
	else expect(await allSignInRowFingerprints(harness)).toEqual(before);
}

/** The barrier is after the real facts/page select and before the second authorization check. */
export async function expectOrganizationReadRace(props: {
	readonly scenario: OrganizationReadScenario;
	readonly kind: OrganizationReadKind;
	readonly revocation: OrganizationReadRevocation;
}): Promise<void> {
	const { scenario, kind, revocation } = props;
	const { harness } = scenario;
	const key = controlledSignInIds.nextId();
	const barrier = (operation: 'arm' | 'entered' | 'release'): Promise<Response> =>
		harness.auth(`/__auth-proof/hold/${operation}?key=${key}`, {
			method: operation === 'entered' ? 'GET' : 'POST',
		});
	expect((await barrier('arm')).status).toBe(200);
	const beforeCounts = await organizationReadCounts(harness);
	const beforeRequest = await allSignInRowFingerprints(harness);
	const pending = requestOrganizationRead({
		scenario,
		kind,
		headers: {
			[organizationReadProbeHeader]: JSON.stringify({
				kind,
				organizationId: scenario.organizationId,
				key,
			}),
		},
	});
	try {
		const entered = await barrier('entered');
		expect(await entered.json()).toEqual({ point: 'organization-read', kind });
		if (revocation === 'ended')
			await harness.database.delete(session).where(eq(session.id, scenario.ownerSessionId));
		else if (revocation === 'expired') {
			const [stored] = await harness.database
				.select({ expiresAt: session.expiresAt })
				.from(session)
				.where(eq(session.id, scenario.ownerSessionId));
			if (stored === undefined) throw new Error('Race session absent');
			await setOrganizationReadClock(harness, stored.expiresAt.getTime() + 1);
		} else if (revocation === 'organization-changed')
			await harness.database
				.update(session)
				.set({ activeOrganizationId: scenario.otherOrganizationId })
				.where(eq(session.id, scenario.ownerSessionId));
		else
			await harness.database
				.update(member)
				.set({ role: 'member' })
				.where(
					and(
						eq(member.userId, scenario.ownerId),
						eq(member.organizationId, scenario.organizationId),
					),
				);
		const afterFixtureMutation = await allSignInRowFingerprints(harness);
		const changedTable = revocation === 'permission-lost' ? 'member' : 'session';
		expect(afterFixtureMutation).toEqual(
			revocation === 'expired'
				? beforeRequest
				: {
						...beforeRequest,
						[changedTable]: afterFixtureMutation[changedTable],
					},
		);
		expect((await barrier('release')).status).toBe(200);
		const response = await pending;
		expect(response.status).toBe(revocation === 'ended' || revocation === 'expired' ? 401 : 403);
		expect(await response.json()).toEqual({ kind: 'refused' });
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect((await organizationReadCounts(harness))[kind] - beforeCounts[kind]).toBe(1);
		expect(await allSignInRowFingerprints(harness)).toEqual(afterFixtureMutation);
	} finally {
		await barrier('release');
		await Promise.allSettled([pending]);
		await setOrganizationReadClock(harness, controlledSignInClock.now());
	}
}

/** Public list fixtures intentionally include unused user fields as privacy canaries. */
export async function seedOrganizationReadMember(props: {
	readonly scenario: OrganizationReadScenario;
	readonly index: number;
	readonly organizationId?: string;
}): Promise<{ readonly name: string; readonly email: string; readonly role: 'member' }> {
	const personId = controlledSignInIds.nextId();
	const createdAt = new Date(controlledSignInClock.now() + props.index + 1);
	const name = `Listed person ${props.index.toString().padStart(3, '0')}`;
	const email = `listed-${props.index}@example.invalid`;
	await props.scenario.harness.database.insert(user).values({
		id: personId,
		name,
		email,
		emailVerified: true,
		image: 'private-image-canary',
		createdAt,
		updatedAt: createdAt,
	});
	await props.scenario.harness.database.insert(member).values({
		id: controlledSignInIds.nextId(),
		organizationId: props.organizationId ?? props.scenario.organizationId,
		userId: personId,
		role: 'member',
		createdAt,
	});
	return { name, email, role: 'member' };
}
