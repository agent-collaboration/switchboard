import { invitation, member, user } from '@agent-collaboration/sign-in-core';
import { and, eq } from 'drizzle-orm';
import { expect, it } from 'vitest';

import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import { controlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-sign-in-clock';
import { expectOrganizationReadBearerRefusals } from '#sign-in-test-support/test-fixtures/organization-read-bearer-scenario';
import {
	createOrganizationReadScenario,
	expectOrganizationReadRace,
	expectOrganizationReadRefusal,
	expectUnchangedOrganizationRead,
	joinOrganizationReadPerson,
	organizationReadCounts,
	requestOrganizationRead,
	runOrganizationReadCases,
	seedOrganizationReadInvitation,
	seedOrganizationReadMember,
	setOrganizationReadClock,
} from '#sign-in-test-support/test-fixtures/organization-read-scenario';
import { allSignInRowFingerprints } from '#sign-in-test-support/test-fixtures/stored-row-fingerprints';

useControlledSignInClock();

it('people: people-list refuses real Person, agent and Fleet-session bearer credentials before reading a member page', async (): Promise<void> => {
	const scenario = await createOrganizationReadScenario();
	try {
		await expectOrganizationReadBearerRefusals(scenario, 'list');
	} finally {
		await scenario.harness.close();
	}
});

it('people: owner people-list returns exactly 51 own-organization members over two ordered pages and only pending unexpired nonmember invitations', async (): Promise<void> => {
	const scenario = await createOrganizationReadScenario();
	const { harness } = scenario;
	try {
		const [owner] = await harness.database
			.select({ name: user.name, email: user.email })
			.from(user)
			.where(eq(user.id, scenario.ownerId));
		if (owner === undefined) throw new Error('Owner list fixture absent');
		const expectedMembers = [{ ...owner, role: 'owner' }];
		// Fixture metadata never belongs in the read projection.
		await harness.database
			.update(user)
			.set({ image: 'private-owner-image-canary' })
			.where(eq(user.id, scenario.ownerId));
		await runOrganizationReadCases(
			Array.from({ length: 50 }, (_, index) => index),
			async (index): Promise<void> => {
				expectedMembers.push(await seedOrganizationReadMember({ scenario, index }));
			},
		);
		await seedOrganizationReadMember({
			scenario,
			index: 999,
			organizationId: scenario.otherOrganizationId,
		});
		await seedOrganizationReadInvitation({ scenario, email: 'shown@example.invalid' });
		await seedOrganizationReadInvitation({ scenario, email: 'owner@example.invalid' });
		await seedOrganizationReadInvitation({
			scenario,
			email: 'foreign-canary@example.invalid',
			organizationId: scenario.otherOrganizationId,
		});
		await runOrganizationReadCases(
			['accepted', 'canceled', 'rejected'],
			async (status): Promise<void> => {
				await seedOrganizationReadInvitation({
					scenario,
					email: `${status}@example.invalid`,
					status,
				});
			},
		);
		await seedOrganizationReadInvitation({
			scenario,
			email: 'equal@example.invalid',
			expiresAt: new Date(controlledSignInClock.now()),
		});
		await seedOrganizationReadInvitation({
			scenario,
			email: 'expired@example.invalid',
			expiresAt: new Date(controlledSignInClock.now() - 1),
		});
		const invitations = [{ email: 'shown@example.invalid', role: 'member' }];
		const ids = [
			...(await harness.database.select({ id: user.id }).from(user)),
			...(await harness.database.select({ id: member.id }).from(member)),
			...(await harness.database.select({ id: invitation.id }).from(invitation)),
		].map((row) => row.id);
		await runOrganizationReadCases([0, 50], async (offset): Promise<void> => {
			const body = await expectUnchangedOrganizationRead({
				harness,
				request: () =>
					harness.auth(
						`/api/auth/organization/people-list?organizationId=${scenario.organizationId}&offset=${offset}`,
						{ headers: { cookie: scenario.ownerCookie } },
					),
				status: 200,
				body: {
					kind: 'available',
					members: expectedMembers.slice(offset, offset + 50),
					memberTotal: 51,
					nextOffset: offset === 0 ? 50 : null,
					invitations,
				},
			});
			for (const forbidden of [
				...ids,
				scenario.otherOrganizationId,
				'private-image-canary',
				'private-owner-image-canary',
				'foreign-canary',
				'listed-999',
			])
				expect(body).not.toContain(forbidden);
		});
	} finally {
		await harness.close();
	}
});

it.each(['member', 'foreign-owner', 'removed-owner', 'ended', 'expired', 'signed-out'] as const)(
	'people: people-list refuses %s before the member page query with no listed fields',
	async (refusal): Promise<void> => {
		const scenario = await createOrganizationReadScenario();
		try {
			await expectOrganizationReadRefusal({ scenario, kind: 'list', refusal });
		} finally {
			await setOrganizationReadClock(scenario.harness, controlledSignInClock.now());
			await scenario.harness.close();
		}
	},
);

it.each(['ended', 'expired', 'organization-changed', 'permission-lost'] as const)(
	'people: people-list discards the real held member page after the owners session is %s',
	async (revocation): Promise<void> => {
		const scenario = await createOrganizationReadScenario();
		try {
			await expectOrganizationReadRace({ scenario, kind: 'list', revocation });
		} finally {
			await scenario.harness.close();
		}
	},
);

it('people: invalid people-list queries return one generic 400 before any member page query', async (): Promise<void> => {
	const scenario = await createOrganizationReadScenario();
	const { harness } = scenario;
	try {
		await runOrganizationReadCases(
			[
				`organizationId=${scenario.organizationId}&offset=0&extra=1`,
				'organizationId=123e4567-e89b-42d3-a456-426614174000&offset=0',
				`organizationId=${scenario.organizationId}&offset=7`,
				`organizationId=${scenario.organizationId}&offset=-50`,
			],
			async (query): Promise<void> => {
				const before = await organizationReadCounts(harness);
				await expectUnchangedOrganizationRead({
					harness,
					request: () =>
						harness.auth(`/api/auth/organization/people-list?${query}`, {
							headers: { cookie: scenario.ownerCookie },
						}),
					status: 400,
					body: { error: 'invalid-request' },
				});
				expect(await organizationReadCounts(harness)).toEqual(before);
			},
		);
	} finally {
		await harness.close();
	}
});

it.each([
	'member-role',
	'member-email',
	'invitation-role',
	'invitation-status',
	'invitation-expiry',
	'invitation-email',
] as const)(
	'people: people-list reports unavailable for malformed stored %s rather than a shortened list',
	async (malformed): Promise<void> => {
		const scenario = await createOrganizationReadScenario();
		const { harness } = scenario;
		try {
			if (malformed === 'member-role' || malformed === 'member-email') {
				const seeded = await seedOrganizationReadMember({ scenario, index: 1 });
				if (malformed === 'member-email')
					await harness.database
						.update(user)
						.set({ email: 'malformed email' })
						.where(eq(user.email, seeded.email));
				else {
					const [person] = await harness.database
						.select({ id: user.id })
						.from(user)
						.where(eq(user.email, seeded.email));
					if (person === undefined) throw new Error('Malformed member fixture missing');
					await harness.database
						.update(member)
						.set({ role: 'unknown-role' })
						.where(
							and(eq(member.userId, person.id), eq(member.organizationId, scenario.organizationId)),
						);
				}
			} else {
				await seedOrganizationReadInvitation({
					scenario,
					email: malformed === 'invitation-email' ? 'malformed email' : 'malformed@example.invalid',
					role: malformed === 'invitation-role' ? 'unknown-role' : 'member',
					status: malformed === 'invitation-status' ? 'unknown-status' : 'pending',
					expiresAt: new Date(
						malformed === 'invitation-expiry' ? -1 : controlledSignInClock.now() + 60_000,
					),
				});
				await seedOrganizationReadInvitation({ scenario, email: 'valid@example.invalid' });
			}
			await expectUnchangedOrganizationRead({
				harness,
				request: () => requestOrganizationRead({ scenario, kind: 'list' }),
				status: 503,
				body: { kind: 'unavailable' },
			});
		} finally {
			await harness.close();
		}
	},
);

it.each(['people-members', 'people-count', 'people-invitations'] as const)(
	'people: people-list reports unavailable after a real %s select fault and writes nothing',
	async (projection): Promise<void> => {
		const scenario = await createOrganizationReadScenario();
		const { harness } = scenario;
		try {
			const before = await allSignInRowFingerprints(harness);
			await harness.setDatabaseFault({
				operation: 'select',
				table: projection === 'people-invitations' ? 'invitation' : 'member',
				key: scenario.organizationId,
				projection,
			});
			const response = await requestOrganizationRead({ scenario, kind: 'list' });
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

it('people: native organization reads stay 404 for an owner and a member while all stored rows remain unchanged', async (): Promise<void> => {
	const scenario = await createOrganizationReadScenario();
	const { harness } = scenario;
	try {
		const joined = await joinOrganizationReadPerson({ scenario, email: 'member@example.invalid' });
		await runOrganizationReadCases(
			[scenario.ownerCookie, joined.cookie].flatMap((cookie) =>
				['list', 'get-full-organization', 'list-members', 'list-invitations'].map((route) => ({
					cookie,
					route,
				})),
			),
			async ({ cookie, route }): Promise<void> => {
				const before = await allSignInRowFingerprints(harness);
				const response = await harness.auth(
					`/api/auth/organization/${route}?organizationId=${scenario.organizationId}`,
					{ headers: { cookie } },
				);
				expect(response.status).toBe(404);
				expect(await response.json()).toEqual({ error: 'not-found' });
				expect(await allSignInRowFingerprints(harness)).toEqual(before);
			},
		);
	} finally {
		await harness.close();
	}
});
