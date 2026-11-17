import { betterAuth } from 'better-auth';
import { createAuthEndpoint, getSession } from 'better-auth/api';
import { expect, it, vi } from 'vitest';

import {
	acquireReadSession,
	readStoredOrganizationSession,
} from '#sign-in-core/better-auth/organization-read-session';
import { liveOwnerSessionSchema } from '#sign-in-core/storage/models/person-session-records';

vi.mock('better-auth/api', async (importOriginal) => {
	const original = await importOriginal<typeof import('better-auth/api')>();
	return { ...original, getSession: vi.fn(() => vi.fn(original.getSession())) };
});

const now = new Date('2030-01-01T00:00:00Z');
const session = liveOwnerSessionSchema.parse({
	user: {
		id: '11111111-1111-7111-8111-111111111111',
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
		userId: '11111111-1111-7111-8111-111111111111',
		expiresAt: now,
		createdAt: now,
		updatedAt: now,
		ipAddress: null,
		userAgent: null,
		activeOrganizationId: null,
	},
});
it('parses the hook session directly, keeping signed-out separate from malformed', () => {
	expect(readStoredOrganizationSession(null)).toEqual({ kind: 'signed-out' });
	expect(readStoredOrganizationSession(undefined)).toEqual({ kind: 'unavailable' });
	expect(readStoredOrganizationSession({ session: {} })).toEqual({ kind: 'unavailable' });
	expect(readStoredOrganizationSession(session)).toEqual({ kind: 'session', value: session });
	expect(
		readStoredOrganizationSession({ ...session, user: { ...session.user, emailVerified: false } }),
	).toEqual({ kind: 'signed-out' });
});
it('acquires a signed-out result through native getSession in a real endpoint context', async () => {
	const endpoint = createAuthEndpoint('/unit-acquire-session', { method: 'GET' }, async (context) =>
		context.json(await acquireReadSession(context)),
	);
	const auth = betterAuth({
		baseURL: 'https://sign-in.example.invalid',
		secret: 'test-only-read-session-secret-'.repeat(3),
		plugins: [{ id: 'unit-acquire-session', endpoints: { acquire: endpoint } }],
	});
	const response = await auth.handler(
		new Request('https://sign-in.example.invalid/api/auth/unit-acquire-session'),
	);
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({ kind: 'signed-out' });
	const nativeEndpoint = vi.mocked(getSession).mock.results[0]?.value;
	if (nativeEndpoint === undefined) throw new Error('Native getSession was not acquired');
	expect(vi.mocked(nativeEndpoint).mock.calls[0]?.[0]).toMatchObject({
		method: 'GET',
		query: { disableCookieCache: true, disableRefresh: true },
		returnHeaders: true,
		returnStatus: false,
	});
});
