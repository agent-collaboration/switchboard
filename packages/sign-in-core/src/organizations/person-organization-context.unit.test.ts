import { expect, it, vi } from 'vitest';

import { organizationMembershipSchema } from '#sign-in-core/contracts/organization-membership';
import { readPersonOrganizationContext } from '#sign-in-core/organizations/person-organization-context';
import { liveOwnerSessionSchema } from '#sign-in-core/storage/models/person-session-records';

const person = '11111111-1111-7111-8111-111111111111';
const first = '22222222-2222-7222-8222-222222222222';
const second = '33333333-3333-7333-8333-333333333333';
const stale = '44444444-4444-7444-8444-444444444444';
const date = new Date('2030-01-01T00:00:00Z');
const session = liveOwnerSessionSchema.parse({
	user: {
		id: person,
		name: 'Person',
		email: 'person@example.com',
		emailVerified: true,
		image: null,
		createdAt: date,
		updatedAt: date,
	},
	session: {
		id: '55555555-5555-7555-8555-555555555555',
		token: 'test-token',
		userId: person,
		expiresAt: date,
		createdAt: date,
		updatedAt: date,
		ipAddress: null,
		userAgent: null,
		activeOrganizationId: stale,
	},
});
const memberships = Object.freeze([
	Object.freeze(
		organizationMembershipSchema.parse({
			organizationId: second,
			organizationName: 'Second',
			personId: person,
			role: 'member',
		}),
	),
	Object.freeze(
		organizationMembershipSchema.parse({
			organizationId: first,
			organizationName: 'First',
			personId: person,
			role: 'owner',
		}),
	),
]);
it('sorts a readonly membership snapshot and clears a stale selection', async () => {
	const membershipsForPerson = vi.fn(async () => ({
		kind: 'available' as const,
		value: memberships,
	}));
	const result = await readPersonOrganizationContext({
		session: { kind: 'session', value: session },
		store: { membershipsForPerson },
	});
	expect(result).toEqual({
		kind: 'available',
		activeOrganizationId: null,
		choices: [
			{ organizationId: first, organizationName: 'First', role: 'owner' },
			{ organizationId: second, organizationName: 'Second', role: 'member' },
		],
	});
	expect(membershipsForPerson).toHaveBeenCalledWith(person);
	expect(memberships.map((membership) => membership.organizationId)).toEqual([second, first]);
});
it('retains a valid selection and distinguishes a failed store from an empty result', async () => {
	const selected = liveOwnerSessionSchema.parse({
		...session,
		session: { ...session.session, activeOrganizationId: first },
	});
	await expect(
		readPersonOrganizationContext({
			session: { kind: 'session', value: selected },
			store: { membershipsForPerson: async () => ({ kind: 'available', value: memberships }) },
		}),
	).resolves.toMatchObject({ kind: 'available', activeOrganizationId: first });
	await expect(
		readPersonOrganizationContext({
			session: { kind: 'session', value: selected },
			store: {
				membershipsForPerson: async () => ({ kind: 'store-unavailable', reason: 'database-error' }),
			},
		}),
	).resolves.toEqual({ kind: 'unavailable' });
});
it.each(['signed-out', 'unavailable'] as const)(
	'returns %s without reading memberships',
	async (kind) => {
		const membershipsForPerson = vi.fn(async () => ({
			kind: 'available' as const,
			value: memberships,
		}));
		await expect(
			readPersonOrganizationContext({ session: { kind }, store: { membershipsForPerson } }),
		).resolves.toEqual({ kind });
		expect(membershipsForPerson).not.toHaveBeenCalled();
	},
);
