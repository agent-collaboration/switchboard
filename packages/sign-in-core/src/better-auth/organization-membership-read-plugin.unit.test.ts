import { betterAuth } from 'better-auth';
import { createAuthMiddleware, getSession, getSessionFromCtx } from 'better-auth/api';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { createOrganizationMembershipReadPlugin } from '#sign-in-core/better-auth/organization-membership-read-plugin';
import { checkOrganizationPermission } from '#sign-in-core/better-auth/organization-permission-check';
import { epochMillisecondsSchema } from '#sign-in-core/contracts/sign-in-platform';
import {
	liveOwnerSessionSchema,
	type LiveOwnerSession,
} from '#sign-in-core/storage/models/person-session-records';

vi.mock('better-auth/api', async (importOriginal) => {
	const original = await importOriginal<typeof import('better-auth/api')>();
	return {
		...original,
		getSession: vi.fn(original.getSession),
		getSessionFromCtx: vi.fn(original.getSessionFromCtx),
	};
});
vi.mock('#sign-in-core/better-auth/organization-permission-check', async (importOriginal) => {
	const original =
		await importOriginal<
			typeof import('#sign-in-core/better-auth/organization-permission-check')
		>();
	return { ...original, checkOrganizationPermission: vi.fn(original.checkOrganizationPermission) };
});
const issuer = 'https://sign-in.example.invalid';
const person = '11111111-1111-7111-8111-111111111111';
const organization = '22222222-2222-7222-8222-222222222222';
const otherOrganization = '33333333-3333-7333-8333-333333333333';
const now = new Date('2030-01-01T00:00:00Z');
const session = liveOwnerSessionSchema.parse({
	user: {
		id: person,
		name: 'Person',
		email: 'person@example.com',
		emailVerified: true,
		image: null,
		createdAt: now,
		updatedAt: now,
	},
	session: {
		id: '55555555-5555-7555-8555-555555555555',
		token: 'test-token',
		userId: person,
		expiresAt: new Date('2030-01-02T00:00:00Z'),
		createdAt: now,
		updatedAt: now,
		ipAddress: null,
		userAgent: null,
		activeOrganizationId: organization,
	},
});
type PluginProps = Parameters<typeof createOrganizationMembershipReadPlugin>[0];
function fixture(
	props: {
		readonly hookSession?: LiveOwnerSession | null;
		readonly readPersonSession?: PluginProps['store']['persons']['readPersonSession'];
		readonly readMemberRole?: PluginProps['store']['organizations']['readMemberRole'];
		readonly readPersonMembershipFacts?: PluginProps['store']['organizations']['readPersonMembershipFacts'];
		readonly listOrganizationPeople?: PluginProps['store']['organizations']['listOrganizationPeople'];
	} = {},
): {
	readonly request: (path: string, body?: unknown) => Promise<Response>;
	readonly facts: ReturnType<typeof vi.fn>;
	readonly list: ReturnType<typeof vi.fn>;
} {
	const facts = vi.fn<PluginProps['store']['organizations']['readPersonMembershipFacts']>(
		props.readPersonMembershipFacts ??
			(async () => ({ kind: 'available', value: { kind: 'member', role: 'member' } })),
	);
	const list = vi.fn<PluginProps['store']['organizations']['listOrganizationPeople']>(
		props.listOrganizationPeople ??
			(async () => ({
				kind: 'available',
				value: { members: [], memberTotal: 0, offset: 0, invitations: [] },
			})),
	);
	const plugin = createOrganizationMembershipReadPlugin({
		store: {
			persons: {
				readPersonSession:
					props.readPersonSession ?? (async () => ({ kind: 'available', value: session })),
			},
			organizations: {
				membershipsForPerson: async () => ({ kind: 'available', value: [] }),
				readMemberRole:
					props.readMemberRole ?? (async () => ({ kind: 'available', value: 'owner' })),
				readPersonMembershipFacts: facts,
				listOrganizationPeople: list,
			},
		},
		platform: {
			clock: { now: () => epochMillisecondsSchema.parse(now.getTime()) },
			crypto: globalThis.crypto,
		},
	});
	const injectedSession = props.hookSession === undefined ? session : props.hookSession;
	const auth = betterAuth({
		baseURL: issuer,
		secret: 'test-only-read-context-secret-'.repeat(3),
		hooks: {
			before: createAuthMiddleware(async () => ({
				context: { context: { session: injectedSession } },
			})),
		},
		plugins: [plugin],
	});
	return {
		facts,
		list,
		request: async (path, body): Promise<Response> =>
			auth.handler(
				new Request(
					`${issuer}/api/auth/organization/${path}`,
					body === undefined
						? { headers: { origin: issuer } }
						: {
								method: 'POST',
								headers: { origin: issuer, 'content-type': 'application/json' },
								body: JSON.stringify(body),
							},
				),
			),
	};
}
beforeEach(() => {
	vi.clearAllMocks();
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(now);
});
afterEach(() => {
	vi.useRealTimers();
});
it.each(['lookup', 'list'] as const)(
	'%s performs both real permission checks with organization:view before releasing',
	async (kind) => {
		const test = fixture();
		const response =
			kind === 'lookup'
				? await test.request('person-membership', {
						organizationId: organization,
						email: 'person@example.com',
					})
				: await test.request(`people-list?organizationId=${organization}&offset=0`);
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(await response.json()).toEqual(
			kind === 'lookup'
				? { kind: 'member', role: 'member' }
				: { kind: 'available', members: [], memberTotal: 0, nextOffset: null, invitations: [] },
		);
		expect(
			vi.mocked(checkOrganizationPermission).mock.calls.map(([input]) => input.permission),
		).toEqual(['organization:view', 'organization:view']);
	},
);
it.each(['lookup', 'list'] as const)(
	'%s refuses a different active organization before facts',
	async (kind) => {
		const test = fixture();
		const response =
			kind === 'lookup'
				? await test.request('person-membership', {
						organizationId: otherOrganization,
						email: 'person@example.com',
					})
				: await test.request(`people-list?organizationId=${otherOrganization}&offset=0`);
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ kind: 'refused' });
		expect(test.facts).not.toHaveBeenCalled();
		expect(test.list).not.toHaveBeenCalled();
	},
);
it.each(['lookup', 'list'] as const)(
	'%s discards facts when the second stored session disappears',
	async (kind) => {
		let reads = 0;
		const test = fixture({
			readPersonSession: async () => ({ kind: 'available', value: ++reads === 1 ? session : null }),
		});
		const response =
			kind === 'lookup'
				? await test.request('person-membership', {
						organizationId: organization,
						email: 'person@example.com',
					})
				: await test.request(`people-list?organizationId=${organization}&offset=0`);
		expect(response.status).toBe(401);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(await response.json()).toEqual({ kind: 'refused' });
		expect(reads).toBe(2);
	},
);
it('keeps store failure unavailable and rejects an extra body key before reading', async () => {
	const test = fixture({
		readPersonMembershipFacts: async () => ({
			kind: 'store-unavailable',
			reason: 'database-error',
		}),
	});
	const invalid = await test.request('person-membership', {
		organizationId: organization,
		email: 'person@example.com',
		extra: true,
	});
	expect(invalid.status).toBe(400);
	expect(invalid.headers.get('cache-control')).toBe('no-store');
	expect(await invalid.json()).toEqual({ error: 'invalid-request' });
	expect(test.facts).not.toHaveBeenCalled();
	const failed = await test.request('person-membership', {
		organizationId: organization,
		email: 'person@example.com',
	});
	expect(failed.status).toBe(503);
	expect(failed.headers.get('cache-control')).toBe('no-store');
	expect(await failed.json()).toEqual({ kind: 'unavailable' });
});
it('uses a null hook session without reading stored session or facts', async () => {
	const readPersonSession = vi.fn<PluginProps['store']['persons']['readPersonSession']>();
	const test = fixture({ hookSession: null, readPersonSession });
	const response = await test.request('person-membership', {
		organizationId: organization,
		email: 'person@example.com',
	});
	expect(response.status).toBe(401);
	expect(await response.json()).toEqual({ kind: 'refused' });
	expect(readPersonSession).not.toHaveBeenCalled();
	expect(getSession).not.toHaveBeenCalled();
	expect(getSessionFromCtx).not.toHaveBeenCalled();
	expect(test.facts).not.toHaveBeenCalled();
});

it.each(['session', 'role', 'list'] as const)(
	'returns unavailable when the %s read fails',
	async (failingRead) => {
		const failure = { kind: 'store-unavailable', reason: 'database-error' } as const;
		const test = fixture({
			readPersonSession: failingRead === 'session' ? async () => failure : undefined,
			readMemberRole: failingRead === 'role' ? async () => failure : undefined,
			listOrganizationPeople: failingRead === 'list' ? async () => failure : undefined,
		});
		const response = await test.request(`people-list?organizationId=${organization}&offset=0`);
		expect(response.status).toBe(503);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(await response.json()).toEqual({ kind: 'unavailable' });
		if (failingRead !== 'list') expect(test.list).not.toHaveBeenCalled();
	},
);
it('discards a lookup candidate when the second permission is lost', async () => {
	let reads = 0;
	const test = fixture({
		readMemberRole: async () => ({ kind: 'available', value: ++reads === 1 ? 'owner' : 'member' }),
	});
	const response = await test.request('person-membership', {
		organizationId: organization,
		email: 'person@example.com',
	});
	expect(response.status).toBe(403);
	expect(await response.json()).toEqual({ kind: 'refused' });
	expect(test.facts).toHaveBeenCalledOnce();
	expect(
		vi.mocked(checkOrganizationPermission).mock.calls.map(([input]) => input.permission),
	).toEqual(['organization:view', 'organization:view']);
});
