import {
	handleSignInRequest,
	type SignInResponseReleasePorts,
} from '@agent-collaboration/sign-in-core';
import { describe, expect, it } from 'vitest';

const ports: SignInResponseReleasePorts = {
	issuer: 'https://sign-in.invalid',
	toolPortalOrigin: 'https://portal.invalid',
	managementAudience: 'https://portal.invalid/management',
	centralAdminAudience: 'https://central.invalid/admin',
	ownerFleetCliClientId: 'owner-fleet-cli',
	requestedResource: null,
	accessTokenSeconds: 300,
	now: () => 1_800_000_000_000,
	inspectSignedToken: () => {
		throw new Error('No token is issued by a route policy check');
	},
	readAgent: async () => null,
	readWorkspaceResource: async () => null,
	isPersonSessionActive: async () => false,
	isPersonOrganizationSessionActive: async () => false,
	deleteSession: async () => {},
	cleanupUnboundPerson: async () => {},
};

describe('audited explicit login-link route', () => {
	it.each([
		{ pathname: '/api/auth/link-social', method: 'POST', status: 204 },
		{ pathname: '/api/auth/link-social', method: 'GET', status: 404 },
		{ pathname: '/api/auth/unlink-account', method: 'POST', status: 404 },
		// Owner ruling B (12 Nov) opens GET list-accounts as a read; writes stay closed.
		{ pathname: '/api/auth/list-accounts', method: 'POST', status: 404 },
	])('routes $method $pathname with status $status', async ({ pathname, method, status }) => {
		const response = await handleSignInRequest({
			request: new Request(`https://sign-in.invalid${pathname}`, { method }),
			providerHandler: async () => new Response(null, { status: 204 }),
			issuedSessions: [],
			createdUserIds: [],
			ports,
		});
		expect(response.status).toBe(status);
	});
});
