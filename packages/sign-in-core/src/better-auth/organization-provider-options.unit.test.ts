import { describe, expect, it } from 'vitest';

import { createOrganizationProviderPlugin } from '#sign-in-core/better-auth/organization-provider-options';
import { createProviderRequestState } from '#sign-in-core/better-auth/provider-request-state';
import { epochMillisecondsSchema, uuid7Schema } from '#sign-in-core/contracts/sign-in-platform';
import {
	organizationChangeRecordId,
	type OrganizationChangePhase,
	type OrganizationPeopleChange,
} from '#sign-in-core/organizations/organization-change-record';
import { organizationIdSchema, personIdSchema } from '#sign-in-core/storage/models/sign-in-store';

const actorId = personIdSchema.parse('11111111-1111-7111-8111-111111111111');
const targetId = personIdSchema.parse('22222222-2222-7222-8222-222222222222');
const organizationId = organizationIdSchema.parse('33333333-3333-7333-8333-333333333333');
const requestId = uuid7Schema.parse('44444444-4444-7444-8444-444444444444');
const invitationId = uuid7Schema.parse('55555555-5555-7555-8555-555555555555');
const actor = {
	id: actorId,
	name: 'Owner',
	email: 'owner@example.invalid',
	emailVerified: true,
	createdAt: new Date(0),
	updatedAt: new Date(0),
};
const target = { ...actor, id: targetId, email: 'member@example.invalid' };
const organization = {
	id: organizationId,
	name: 'Organization',
	slug: 'organization',
	createdAt: new Date(0),
};
const invitation = {
	id: invitationId,
	email: target.email,
	role: 'member',
	organizationId,
	inviterId: actorId,
	status: 'pending' as const,
	expiresAt: new Date(2_208_988_800_000),
	createdAt: new Date(0),
};
const member = {
	id: '66666666-6666-7666-8666-666666666666',
	userId: targetId,
	organizationId,
	role: 'member',
	createdAt: new Date(0),
};
type ChangeOperation =
	| 'invited'
	| 'invitation-cancelled'
	| 'invitation-accepted'
	| 'member-removed';

function fixture(failure: OrganizationChangePhase | null = null): {
	readonly plugin: ReturnType<typeof createOrganizationProviderPlugin>;
	readonly calls: readonly {
		readonly change: OrganizationPeopleChange;
		readonly phase: OrganizationChangePhase;
	}[];
	readonly before: (operation: ChangeOperation) => Promise<void>;
	readonly after: (operation: ChangeOperation) => Promise<void>;
} {
	const state = createProviderRequestState();
	state.organizationActor = { kind: 'authenticated', personId: actorId, sessionId: requestId };
	const calls: { change: OrganizationPeopleChange; phase: OrganizationChangePhase }[] = [];
	const plugin = createOrganizationProviderPlugin({
		ownerEmail: actor.email,
		requestState: state,
		signStatement: async () => 'header.claims.signature',
		platform: {
			clock: { now: () => epochMillisecondsSchema.parse(1_800_000_000_000) },
			ids: { nextId: () => requestId },
			log: () => {},
			centralClient: {
				readStatementDigest: async () => ({ kind: 'unavailable', reason: 'unavailable' }),
				pushAuthorizationRevision: async () => ({ kind: 'unknown', reason: 'unavailable' }),
				sendFleetAdminRequest: async () => ({
					kind: 'unknown' as const,
					reason: 'unavailable' as const,
				}),
				relayFleetAdminRequest: async () => ({
					kind: 'unknown' as const,
					reason: 'unavailable' as const,
				}),
				provisionOrganization: async () => ({ kind: 'unknown', reason: 'unavailable' }),
			},
		},
		store: {
			factors: {
				readSession: async () => ({
					kind: 'available',
					value: {
						confirmation: {
							kind: 'confirmed',
							at: epochMillisecondsSchema.parse(1_800_000_000_000),
							method: 'app',
						},
						enrollment: {
							kind: 'enrolled',
							setAt: epochMillisecondsSchema.parse(1_800_000_000_000),
						},
					},
				}),
			},
			peopleChanges: {
				read: async () => ({ kind: 'available', value: [] }),
				record: async (change, phase) => {
					if (phase === failure) return { kind: 'store-unavailable', reason: 'database-error' };
					calls.push({ change, phase });
					return { kind: 'available', value: undefined };
				},
			},
			organizations: {
				membershipsForPerson: async () => ({ kind: 'available', value: [] }),
				readMemberRole: async () => ({ kind: 'available', value: null }),
				readFleetState: async () => ({ kind: 'available', value: 'settingUp' }),
				markFleetReady: async () => ({ kind: 'available', value: undefined }),
			},
		},
	});
	const hooks = plugin.options.organizationHooks;
	if (hooks === undefined) throw new Error('Organization hooks must be configured');
	return {
		plugin,
		calls,
		async before(operation): Promise<void> {
			switch (operation) {
				case 'invited':
					await hooks.beforeCreateInvitation?.({ organization, inviter: target, invitation });
					return;
				case 'invitation-cancelled':
					await hooks.beforeCancelInvitation?.({ organization, cancelledBy: target, invitation });
					return;
				case 'invitation-accepted':
					await hooks.beforeAcceptInvitation?.({ organization, user: target, invitation });
					return;
				case 'member-removed':
					await hooks.beforeRemoveMember?.({ organization, user: target, member });
					return;
			}
		},
		async after(operation): Promise<void> {
			switch (operation) {
				case 'invited':
					await hooks.afterCreateInvitation?.({ organization, inviter: target, invitation });
					return;
				case 'invitation-cancelled':
					await hooks.afterCancelInvitation?.({ organization, cancelledBy: target, invitation });
					return;
				case 'invitation-accepted':
					await hooks.afterAcceptInvitation?.({ organization, user: target, invitation, member });
					return;
				case 'member-removed':
					await hooks.afterRemoveMember?.({ organization, user: target, member });
					return;
			}
		},
	};
}

const operations = [
	'invited',
	'invitation-cancelled',
	'invitation-accepted',
	'member-removed',
] as const;
describe('native organization hook recording under OD26', () => {
	it.each(operations)(
		'records %s using the request actor and two deterministic phase identities',
		async (operation) => {
			// Arrange: hook payload users deliberately name the target, not the authenticated requester.
			const setup = fixture();
			// Act
			await setup.before(operation);
			expect(setup.calls).toHaveLength(1);
			await setup.after(operation);
			// Assert
			expect(
				setup.calls.map(({ change, phase }) => ({
					...change,
					phase,
					id: organizationChangeRecordId(change, phase),
				})),
			).toEqual(
				['intent', 'outcome'].map((phase) => ({
					requestId,
					actorUserId: actorId,
					organizationId,
					change: operation,
					targetId:
						operation === 'invited'
							? target.email
							: operation === 'member-removed'
								? targetId
								: invitationId,
					phase,
					id: `${requestId}:${operation}:${phase}`,
				})),
			);
		},
	);
	it.each(operations)(
		'refuses %s before native effect when its intent cannot be written',
		async (operation) => {
			// Arrange
			const setup = fixture('intent');
			// Act / Assert
			await expect(setup.before(operation)).rejects.toThrow();
			expect(setup.calls).toEqual([]);
		},
	);
	it.each(operations)(
		'keeps only the intent after the outcome write is lost for %s',
		async (operation) => {
			// Arrange
			const setup = fixture('outcome');
			await setup.before(operation);
			// Act / Assert: the native after-hook reports unavailable; later reads perform no settlement.
			await expect(setup.after(operation)).rejects.toThrow();
			expect(setup.calls).toHaveLength(1);
			expect(setup.calls[0]?.phase).toBe('intent');
		},
	);
	it('limits organization creation to the configured verified person, independent of role membership', async () => {
		// Arrange
		const permission = fixture().plugin.options.allowUserToCreateOrganization;
		if (typeof permission !== 'function')
			throw new Error('Creation must use the configured callback');
		// Act / Assert
		expect(await permission(actor)).toBe(true);
		expect(await permission(target)).toBe(false);
		expect(await permission({ ...actor, emailVerified: false })).toBe(false);
	});
	it('requires verified invitation email and keeps automatic cancel-on-reinvite disabled', () => {
		// Arrange / Act
		const options = fixture().plugin.options;
		// Assert: these native options avoid unrecorded bypasses.
		expect(options.requireEmailVerificationOnInvitation).toBe(true);
		expect(options.cancelPendingInvitationsOnReInvite).toBe(false);
	});
});
