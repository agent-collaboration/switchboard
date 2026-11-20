import { member, oauthResource, organization, session } from '@agent-collaboration/sign-in-core';
import { and, eq } from 'drizzle-orm';
import { expect, it } from 'vitest';

import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import { controlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-sign-in-clock';
import {
	captureExpiredSessionCleanup,
	expectExpiredSessionCleanup,
} from '#sign-in-test-support/test-fixtures/expired-session-cleanup-proof';
import { startLocalAuthHarness } from '#sign-in-test-support/test-fixtures/local-auth-harness';
import {
	createOrganizationReadScenario,
	expectUnchangedOrganizationRead,
	setOrganizationReadClock,
} from '#sign-in-test-support/test-fixtures/organization-read-scenario';
import { signInPeopleBrowser } from '#sign-in-test-support/test-fixtures/people-browser-login';
import { allSignInRowFingerprints } from '#sign-in-test-support/test-fixtures/stored-row-fingerprints';

useControlledSignInClock();
const path = '/api/auth/organization/self-context';

it('people: self-context distinguishes signed out from a verified person with zero memberships without selecting or writing', async (): Promise<void> => {
	const harness = await startLocalAuthHarness();
	try {
		// Native oauthProvider init seeds its configured resources on the first request.
		expect((await harness.auth('/api/auth/jwks')).status).toBe(200);
		const centralAdminAudience = harness.target.centralAdminAudience;
		if (centralAdminAudience === undefined) throw new Error('Central admin audience is missing');
		expect(
			await harness.database
				.select({ identifier: oauthResource.identifier })
				.from(oauthResource)
				.orderBy(oauthResource.identifier),
		).toEqual(
			[harness.target.managementAudience, centralAdminAudience]
				.toSorted((left, right) => left.localeCompare(right))
				.map((identifier) => ({ identifier })),
		);
		expect(await harness.database.select().from(member)).toEqual([]);
		expect(await harness.database.select().from(session)).toEqual([]);
		await expectUnchangedOrganizationRead({
			harness,
			request: () => harness.auth(path, { headers: { cookie: '' } }),
			status: 401,
			body: { kind: 'signed-out' },
		});
		// The configured first owner may sign in before creating any organization.
		await signInPeopleBrowser({ harness, email: 'owner@example.invalid' });
		await expectUnchangedOrganizationRead({
			harness,
			request: () => harness.auth(path),
			status: 200,
			body: { kind: 'available', choices: [], activeOrganizationId: null },
		});
	} finally {
		await harness.close();
	}
});

it('people: self-context returns exactly the callers sorted memberships and only a current membership as the stored choice', async (): Promise<void> => {
	const scenario = await createOrganizationReadScenario();
	const { harness, ownerId, ownerCookie, ownerSessionId, organizationId, otherOrganizationId } =
		scenario;
	try {
		const rows = await harness.database
			.select({
				organizationId: organization.id,
				organizationName: organization.name,
				role: member.role,
			})
			.from(member)
			.innerJoin(organization, eq(member.organizationId, organization.id))
			.where(eq(member.userId, ownerId));
		const choices = rows.toSorted((left, right) =>
			left.organizationId.localeCompare(right.organizationId),
		);
		const read = (): Promise<Response> => harness.auth(path, { headers: { cookie: ownerCookie } });
		await expectUnchangedOrganizationRead({
			harness,
			request: read,
			status: 200,
			body: { kind: 'available', choices, activeOrganizationId: organizationId },
		});
		// Fixture: a stale stored selection reads as null and is not repaired by reading.
		await harness.database
			.delete(member)
			.where(and(eq(member.userId, ownerId), eq(member.organizationId, organizationId)));
		await expectUnchangedOrganizationRead({
			harness,
			request: read,
			status: 200,
			body: {
				kind: 'available',
				choices: choices.filter((choice) => choice.organizationId === otherOrganizationId),
				activeOrganizationId: null,
			},
		});
		// One remaining membership is not automatically selected by this read.
		expect(
			await harness.database
				.select({ active: session.activeOrganizationId })
				.from(session)
				.where(eq(session.id, ownerSessionId)),
		).toEqual([{ active: organizationId }]);
		await harness.database
			.update(session)
			.set({ activeOrganizationId: otherOrganizationId })
			.where(eq(session.id, ownerSessionId));
		await expectUnchangedOrganizationRead({
			harness,
			request: read,
			status: 200,
			body: {
				kind: 'available',
				choices: choices.filter((choice) => choice.organizationId === otherOrganizationId),
				activeOrganizationId: otherOrganizationId,
			},
		});
		await expectUnchangedOrganizationRead({
			harness,
			request: () =>
				harness.auth(`${path}?personId=${ownerId}`, { headers: { cookie: ownerCookie } }),
			status: 400,
			body: { error: 'invalid-request' },
		});
	} finally {
		await harness.close();
	}
});

it.each(['absent', 'old'] as const)(
	'people: self-context needs no %s second-factor confirmation and never refreshes it or the session',
	async (confirmation): Promise<void> => {
		const scenario = await createOrganizationReadScenario();
		const { harness } = scenario;
		try {
			await harness.database
				.update(session)
				.set({
					secondFactorAt:
						confirmation === 'absent' ? null : controlledSignInClock.now() - 86_400_000,
					secondFactorMethod: confirmation === 'absent' ? null : 'totp',
				})
				.where(eq(session.id, scenario.ownerSessionId));
			// Beyond native updateAge, inside expiry: a default session read would refresh.
			await setOrganizationReadClock(harness, controlledSignInClock.now() + 86_460_000);
			const before = await allSignInRowFingerprints(harness);
			const response = await harness.auth(path, { headers: { cookie: scenario.ownerCookie } });
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({
				kind: 'available',
				choices: [
					{
						organizationId: scenario.organizationId,
						organizationName: 'Owner organization',
						role: 'owner',
					},
					{
						organizationId: scenario.otherOrganizationId,
						organizationName: 'Other organization canary',
						role: 'owner',
					},
				].toSorted((left, right) => left.organizationId.localeCompare(right.organizationId)),
				activeOrganizationId: scenario.organizationId,
			});
			expect(response.headers.getSetCookie()).toEqual([]);
			expect(await allSignInRowFingerprints(harness)).toEqual(before);
		} finally {
			await setOrganizationReadClock(harness, controlledSignInClock.now());
			await harness.close();
		}
	},
);

it('people: an expired self-context performs exactly native session cleanup, retained fence bumps and the queued ACK drain', async (): Promise<void> => {
	const scenario = await createOrganizationReadScenario();
	const { harness } = scenario;
	try {
		const expiresAt = controlledSignInClock.now() + 1_000;
		await harness.database
			.update(session)
			.set({ expiresAt: new Date(expiresAt) })
			.where(eq(session.id, scenario.ownerSessionId));
		expect(
			await harness.database
				.select({ expiresAt: session.expiresAt })
				.from(session)
				.where(eq(session.id, scenario.ownerSessionId)),
		).toEqual([{ expiresAt: new Date(expiresAt) }]);
		const before = await captureExpiredSessionCleanup(harness);
		await setOrganizationReadClock(harness, expiresAt + 1);
		const response = await harness.auth(path, {
			headers: { cookie: scenario.ownerCookie },
		});
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ kind: 'signed-out' });
		await expectExpiredSessionCleanup({
			harness,
			before,
			response,
			sessionId: scenario.ownerSessionId,
			personId: scenario.ownerId,
			now: expiresAt + 1,
		});
	} finally {
		await setOrganizationReadClock(harness, controlledSignInClock.now());
		await harness.close();
	}
});

it.each(['session', 'memberships'] as const)(
	'people: a real %s driver failure makes self-context unavailable rather than signed out or empty',
	async (failure): Promise<void> => {
		const scenario = await createOrganizationReadScenario();
		const { harness } = scenario;
		try {
			const [stored] = await harness.database
				.select({ token: session.token })
				.from(session)
				.where(eq(session.id, scenario.ownerSessionId));
			if (stored === undefined) throw new Error('Session fault fixture missing');
			const before = await allSignInRowFingerprints(harness);
			await harness.setDatabaseFault(
				failure === 'session'
					? { operation: 'select', table: 'session', key: stored.token }
					: {
							operation: 'select',
							table: 'member',
							key: scenario.ownerId,
							projection: 'memberships',
						},
			);
			const response = await harness.auth(path, { headers: { cookie: scenario.ownerCookie } });
			expect(response.status).toBe(503);
			expect(await response.json()).toEqual({ kind: 'unavailable' });
			await harness.setDatabaseFault(null);
			expect(await allSignInRowFingerprints(harness)).toEqual(before);
		} finally {
			await harness.setDatabaseFault(null);
			await harness.close();
		}
	},
);
