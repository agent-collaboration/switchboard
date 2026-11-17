import { invitation, member, session } from '@agent-collaboration/sign-in-core';
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
	inviteOrganizationReadPerson,
	joinOrganizationReadPerson,
	organizationReadCounts,
	requestOrganizationRead,
	runOrganizationReadCases,
	seedOrganizationReadInvitation,
	setOrganizationReadClock,
} from '#sign-in-test-support/test-fixtures/organization-read-scenario';
import { peoplePost } from '#sign-in-test-support/test-fixtures/people-browser-login';
import { allSignInRowFingerprints } from '#sign-in-test-support/test-fixtures/stored-row-fingerprints';

useControlledSignInClock();

it('people: lookup refuses real Person, agent and Fleet-session bearer credentials before reading facts', async (): Promise<void> => {
	const scenario = await createOrganizationReadScenario();
	try {
		await expectOrganizationReadBearerRefusals(scenario, 'lookup');
	} finally {
		await scenario.harness.close();
	}
});

it('people: lookup returns exact owner, member and invited answers; membership wins and invitation histories are fully read', async (): Promise<void> => {
	const scenario = await createOrganizationReadScenario();
	const { harness } = scenario;
	try {
		await joinOrganizationReadPerson({ scenario, email: 'member@example.invalid' });
		await seedOrganizationReadInvitation({ scenario, email: 'member@example.invalid' });
		await inviteOrganizationReadPerson({ scenario, email: 'pending@example.invalid' });
		const cancelledId = await inviteOrganizationReadPerson({
			scenario,
			email: 'history@example.invalid',
		});
		expect(
			(
				await peoplePost(
					harness,
					'cancel-invitation',
					{ invitationId: cancelledId },
					scenario.ownerCookie,
				)
			).status,
		).toBe(200);
		await inviteOrganizationReadPerson({ scenario, email: 'history@example.invalid' });
		// Fixture IDs force both row orders, independently of UUID randomness.
		await seedOrganizationReadInvitation({
			scenario,
			id: '019a9b18-e000-7000-8000-000000000001',
			email: 'forward-history@example.invalid',
			status: 'canceled',
		});
		await seedOrganizationReadInvitation({
			scenario,
			id: '019a9b18-e000-7000-8000-000000000002',
			email: 'forward-history@example.invalid',
		});
		await seedOrganizationReadInvitation({
			scenario,
			id: '019a9b18-e000-7000-8000-000000000003',
			email: 'reverse-history@example.invalid',
		});
		await seedOrganizationReadInvitation({
			scenario,
			id: '019a9b18-e000-7000-8000-000000000004',
			email: 'reverse-history@example.invalid',
			status: 'canceled',
		});
		await runOrganizationReadCases(
			[
				['owner@example.invalid', { kind: 'member', role: 'owner' }],
				['member@example.invalid', { kind: 'member', role: 'member' }],
				['pending@example.invalid', { kind: 'invited' }],
				['history@example.invalid', { kind: 'invited' }],
				['forward-history@example.invalid', { kind: 'invited' }],
				['reverse-history@example.invalid', { kind: 'invited' }],
				['  MeMbEr@Example.Invalid  ', { kind: 'member', role: 'member' }],
			] as const,
			async ([email, body]): Promise<void> => {
				await expectUnchangedOrganizationRead({
					harness,
					request: () => requestOrganizationRead({ scenario, kind: 'lookup', email }),
					status: 200,
					body,
				});
			},
		);
	} finally {
		await harness.close();
	}
});

it('people: lookup treats expiry equality, cancelled, rejected and accepted-but-removed invitations as not-member', async (): Promise<void> => {
	const scenario = await createOrganizationReadScenario();
	const { harness } = scenario;
	try {
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
		await seedOrganizationReadInvitation({
			scenario,
			email: 'rejected@example.invalid',
			status: 'rejected',
		});
		const cancelled = await inviteOrganizationReadPerson({
			scenario,
			email: 'cancelled@example.invalid',
		});
		expect(
			(
				await peoplePost(
					harness,
					'cancel-invitation',
					{ invitationId: cancelled },
					scenario.ownerCookie,
				)
			).status,
		).toBe(200);
		const removed = await joinOrganizationReadPerson({
			scenario,
			email: 'removed@example.invalid',
		});
		expect(
			(
				await peoplePost(
					harness,
					'remove-member',
					{ organizationId: scenario.organizationId, memberIdOrEmail: 'removed@example.invalid' },
					scenario.ownerCookie,
				)
			).status,
		).toBe(200);
		expect(
			await harness.database
				.select({ status: invitation.status })
				.from(invitation)
				.where(eq(invitation.id, removed.invitationId)),
		).toEqual([{ status: 'accepted' }]);
		expect(
			await harness.database.select().from(member).where(eq(member.userId, removed.personId)),
		).toEqual([]);
		await runOrganizationReadCases(
			['equal', 'expired', 'rejected', 'cancelled', 'removed'].map(
				(name) => `${name}@example.invalid`,
			),
			async (email): Promise<void> => {
				await expectUnchangedOrganizationRead({
					harness,
					request: () => requestOrganizationRead({ scenario, kind: 'lookup', email }),
					status: 200,
					body: { kind: 'not-member' },
				});
			},
		);
	} finally {
		await harness.close();
	}
});

it('people: lookup of someone only elsewhere and someone with no account has byte-identical bodies and no writes', async (): Promise<void> => {
	const scenario = await createOrganizationReadScenario();
	const { harness } = scenario;
	try {
		await joinOrganizationReadPerson({
			scenario,
			email: 'elsewhere@example.invalid',
			organizationId: scenario.otherOrganizationId,
		});
		// A foreign invitation also cannot make the absent subject invited here.
		await seedOrganizationReadInvitation({
			scenario,
			email: 'absent@example.invalid',
			organizationId: scenario.otherOrganizationId,
		});
		const elsewhere = await expectUnchangedOrganizationRead({
			harness,
			request: () =>
				requestOrganizationRead({ scenario, kind: 'lookup', email: 'elsewhere@example.invalid' }),
			status: 200,
			body: { kind: 'not-member' },
		});
		const absent = await expectUnchangedOrganizationRead({
			harness,
			request: () =>
				requestOrganizationRead({ scenario, kind: 'lookup', email: 'absent@example.invalid' }),
			status: 200,
			body: { kind: 'not-member' },
		});
		expect(elsewhere).toBe(absent);
	} finally {
		await harness.close();
	}
});

it('people: malformed lookup bodies and content types get one generic 400 before any subject read', async (): Promise<void> => {
	const scenario = await createOrganizationReadScenario();
	const { harness } = scenario;
	try {
		await runOrganizationReadCases(
			[
				[
					'application/json',
					JSON.stringify({ organizationId: scenario.organizationId, email: '' }),
				],
				[
					'application/json',
					JSON.stringify({ organizationId: scenario.organizationId, email: 'not an email' }),
				],
				[
					'application/json',
					JSON.stringify({
						organizationId: '123e4567-e89b-42d3-a456-426614174000',
						email: 'owner@example.invalid',
					}),
				],
				[
					'application/json',
					JSON.stringify({
						organizationId: scenario.organizationId,
						email: 'owner@example.invalid',
						extra: true,
					}),
				],
				[
					'text/plain',
					JSON.stringify({
						organizationId: scenario.organizationId,
						email: 'owner@example.invalid',
					}),
				],
				['application/json', '{'],
			] as const,
			async ([contentType, body]): Promise<void> => {
				const before = await organizationReadCounts(harness);
				await expectUnchangedOrganizationRead({
					harness,
					request: () =>
						harness.auth('/api/auth/organization/person-membership', {
							method: 'POST',
							headers: { cookie: scenario.ownerCookie, 'content-type': contentType },
							body,
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

it.each(['status', 'expiry', 'member-role'] as const)(
	'people: lookup fails closed on malformed stored %s without shortening the facts or writing',
	async (malformed): Promise<void> => {
		const scenario = await createOrganizationReadScenario();
		const { harness } = scenario;
		try {
			const email =
				malformed === 'member-role' ? 'owner@example.invalid' : 'malformed@example.invalid';
			if (malformed === 'member-role')
				// Only the subject role is malformed: the owner actor's other member is used below.
				await joinOrganizationReadPerson({ scenario, email: 'bad-role@example.invalid' });
			if (malformed === 'member-role')
				await harness.database
					.update(member)
					.set({ role: 'unknown-role' })
					.where(
						and(eq(member.organizationId, scenario.organizationId), eq(member.role, 'member')),
					);
			else {
				await seedOrganizationReadInvitation({
					scenario,
					email,
					status: malformed === 'status' ? 'unknown-status' : 'pending',
					expiresAt: new Date(malformed === 'expiry' ? -1 : controlledSignInClock.now() + 60_000),
				});
				// A valid pending row cannot hide an undecodable row in the same read.
				await seedOrganizationReadInvitation({ scenario, email });
			}
			await expectUnchangedOrganizationRead({
				harness,
				request: () =>
					requestOrganizationRead({
						scenario,
						kind: 'lookup',
						email: malformed === 'member-role' ? 'bad-role@example.invalid' : email,
					}),
				status: 503,
				body: { kind: 'unavailable' },
			});
		} finally {
			await harness.close();
		}
	},
);

it.each(['member', 'foreign-owner', 'removed-owner', 'ended', 'expired', 'signed-out'] as const)(
	'people: lookup refuses %s before a facts query and releases no subject fields',
	async (refusal): Promise<void> => {
		const scenario = await createOrganizationReadScenario();
		try {
			await expectOrganizationReadRefusal({ scenario, kind: 'lookup', refusal });
		} finally {
			await setOrganizationReadClock(scenario.harness, controlledSignInClock.now());
			await scenario.harness.close();
		}
	},
);

it.each(['ended', 'expired', 'organization-changed', 'permission-lost'] as const)(
	'people: lookup discards real held facts after the owners session is %s',
	async (revocation): Promise<void> => {
		const scenario = await createOrganizationReadScenario();
		try {
			await expectOrganizationReadRace({ scenario, kind: 'lookup', revocation });
		} finally {
			await scenario.harness.close();
		}
	},
);

it.each(['session', 'permission', 'facts', 'invitations'] as const)(
	'people: lookup reports unavailable after a real %s select fault and writes nothing',
	async (failure): Promise<void> => {
		const scenario = await createOrganizationReadScenario();
		const { harness } = scenario;
		try {
			const [stored] = await harness.database
				.select({ token: session.token })
				.from(session)
				.where(eq(session.id, scenario.ownerSessionId));
			if (stored === undefined) throw new Error('Lookup session fixture absent');
			const before = await allSignInRowFingerprints(harness);
			if (failure === 'session')
				await harness.setDatabaseFault({
					operation: 'select',
					table: 'session',
					key: stored.token,
				});
			else if (failure === 'permission')
				await harness.setDatabaseFault({
					operation: 'select',
					table: 'member',
					key: scenario.ownerId,
				});
			else
				await harness.setDatabaseFault({
					operation: 'select',
					table: failure === 'facts' ? 'member' : 'invitation',
					key: scenario.organizationId,
					projection: failure === 'facts' ? 'membership-facts' : 'membership-invitations',
				});
			const response = await requestOrganizationRead({
				scenario,
				kind: 'lookup',
				email: 'absent@example.invalid',
			});
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

it('people: lookup accepts an old confirmation without renewing it while invite still requires a fresh confirmation', async (): Promise<void> => {
	const scenario = await createOrganizationReadScenario();
	const { harness } = scenario;
	try {
		await harness.database
			.update(session)
			.set({ secondFactorAt: controlledSignInClock.now() - 86_400_000 })
			.where(eq(session.id, scenario.ownerSessionId));
		await expectUnchangedOrganizationRead({
			harness,
			request: () => requestOrganizationRead({ scenario, kind: 'lookup' }),
			status: 200,
			body: { kind: 'member', role: 'owner' },
		});
		const before = await allSignInRowFingerprints(harness);
		const refused = await peoplePost(
			harness,
			'invite-member',
			{
				organizationId: scenario.organizationId,
				email: 'fresh-required@example.invalid',
				role: 'member',
			},
			scenario.ownerCookie,
		);
		expect(refused.status).toBe(403);
		expect(await allSignInRowFingerprints(harness)).toEqual(before);
	} finally {
		await harness.close();
	}
});
