import { betterAuth } from 'better-auth';
import { createAuthEndpoint, createAuthMiddleware } from 'better-auth/api';
import { afterEach, expect, it, vi } from 'vitest';

import {
	organizationReadSessionBeforeHook,
	organizationReadResponseHeaders,
	readStoredOrganizationSession,
} from '#sign-in-core/better-auth/organization-read-session';
import { liveOwnerSessionSchema } from '#sign-in-core/storage/models/person-session-records';

const issuer = 'https://sign-in.example.invalid';
const expiry = new Date('2030-01-01T00:00:01.000Z');
afterEach(() => {
	vi.useRealTimers();
});

it('clears an expired native session and cookie before the fixture endpoint sees it', async () => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'));
	let fixtureToken = '';
	let hookReadKind = '';
	let hookContextHasSession = false;
	let hookCookieCount = 0;
	let endpointContextHasSession = false;
	const fixtureCookie = createAuthEndpoint(
		'/unit-session-cookie',
		{ method: 'POST' },
		async (context) => {
			const user = await context.context.internalAdapter.createUser(
				{ name: 'Synthetic', email: 'synthetic@example.com', emailVerified: true, image: null },
				{ method: 'email-password' },
			);
			const session = await context.context.internalAdapter.createSession(user.id, false, {
				activeOrganizationId: null,
			});
			fixtureToken = session.token;
			await context.context.internalAdapter.updateSession(session.token, { expiresAt: expiry });
			await context.setSignedCookie(
				context.context.authCookies.sessionToken.name,
				session.token,
				context.context.secret,
				context.context.authCookies.sessionToken.attributes,
			);
			return context.json({ created: true });
		},
	);
	const self = createAuthEndpoint('/unit-self-context', { method: 'GET' }, async (context) => {
		organizationReadResponseHeaders(context);
		endpointContextHasSession =
			context.context.session !== null && context.context.session !== undefined;
		const read = readStoredOrganizationSession(context.context.session);
		context.setStatus(read.kind === 'signed-out' ? 401 : read.kind === 'unavailable' ? 503 : 200);
		return context.json({ kind: read.kind });
	});
	let nextId = 0;
	const ids = ['11111111-1111-7111-8111-111111111111', '22222222-2222-7222-8222-222222222222'];
	const auth = betterAuth({
		baseURL: issuer,
		secret: 'test-only-native-hook-secret-'.repeat(3),
		advanced: {
			database: {
				generateId: () => {
					const id = ids[nextId++];
					if (id === undefined) throw new Error('Unexpected ID request');
					return id;
				},
			},
		},
		session: {
			cookieCache: { enabled: false },
			additionalFields: {
				activeOrganizationId: { type: 'string', required: false, defaultValue: null },
			},
		},
		hooks: {
			before: createAuthMiddleware(async (context) => {
				if (context.path !== '/unit-self-context') return undefined;
				const result = await organizationReadSessionBeforeHook(context);
				hookReadKind = result.context.context.session === null ? 'signed-out' : 'session';
				hookContextHasSession =
					context.context.session !== null && context.context.session !== undefined;
				hookCookieCount = context.responseHeaders.getSetCookie().length;
				return result;
			}),
		},
		plugins: [{ id: 'unit-native-session-hook', endpoints: { fixtureCookie, self } }],
	});
	const seeded = await auth.handler(
		new Request(`${issuer}/api/auth/unit-session-cookie`, {
			method: 'POST',
			headers: { origin: issuer },
		}),
	);
	expect(seeded.status).toBe(200);
	const setCookie = seeded.headers.getSetCookie()[0];
	if (setCookie === undefined) throw new Error('Fixture did not mint a session cookie');
	const cookie = setCookie.split(';')[0];
	if (cookie === undefined) throw new Error('Fixture cookie was empty');
	const nativeContext = await auth.$context;
	const beforeExpiry = await nativeContext.internalAdapter.findSession(fixtureToken);
	const parsedFixture = liveOwnerSessionSchema.safeParse(beforeExpiry);
	if (!parsedFixture.success)
		throw new Error(
			JSON.stringify(parsedFixture.error.issues.map(({ path, code }) => ({ path, code }))),
		);
	vi.setSystemTime(new Date('2030-01-01T00:00:01.001Z'));
	const response = await auth.handler(
		new Request(`${issuer}/api/auth/unit-self-context`, { headers: { cookie, origin: issuer } }),
	);
	const body: unknown = await response.json();
	const remaining = await nativeContext.internalAdapter.listSessions(
		'11111111-1111-7111-8111-111111111111',
	);
	expect(hookReadKind).toBe('signed-out');
	expect(hookContextHasSession).toBe(false);
	expect(hookCookieCount).toBeGreaterThan(0);
	expect(remaining).toHaveLength(0);
	expect(await nativeContext.internalAdapter.findSession(fixtureToken)).toBeNull();
	expect({
		endpointContextHasSession,
		responseStatus: response.status,
		responseHasClearCookie: response.headers
			.getSetCookie()
			.some((header) => header.includes('session_token=') && /Max-Age=0/iu.test(header)),
		body,
	}).toEqual({
		endpointContextHasSession: false,
		responseStatus: 401,
		responseHasClearCookie: true,
		body: { kind: 'signed-out' },
	});
});
