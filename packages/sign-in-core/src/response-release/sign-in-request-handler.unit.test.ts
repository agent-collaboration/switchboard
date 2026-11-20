import { describe, expect, it } from 'vitest';

import { handleSignInRequest } from '#sign-in-core/response-release/sign-in-request-handler';
import type { SignInResponseReleasePorts } from '#sign-in-core/response-release/sign-in-response-release';

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
		throw new Error('No token inspection expected for lookup validation');
	},
	readAgent: async () => null,
	readWorkspaceResource: async () => null,
	isPersonSessionActive: async () => false,
	isPersonOrganizationSessionActive: async () => false,
	deleteSession: async () => {},
	cleanupUnboundPerson: async () => {},
};

describe('public organization lookup validation response', () => {
	it('keeps provider cookie clearing while replacing validation details with a generic no-store 400', async () => {
		// Arrange: the provider supplies an error; the real public wrapper owns header preservation.
		const clearingCookies = [
			'better-auth.session_token=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax',
			'better-auth.session_data=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax',
		];
		const headers = new Headers({ 'cache-control': 'public', 'content-length': '999' });
		for (const cookie of clearingCookies) headers.append('set-cookie', cookie);
		const providerResponse = Response.json(
			{ message: 'private provider validation details' },
			{ status: 400, headers },
		);
		const request = new Request('https://sign-in.invalid/api/auth/organization/person-membership', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ organizationId: 'invalid', email: 'not an email' }),
		});

		// Act
		const response = await handleSignInRequest({
			request,
			providerHandler: async () => providerResponse,
			issuedSessions: [],
			createdUserIds: [],
			ports,
		});

		// Assert
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: 'invalid-request' });
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(response.headers.getSetCookie()).toEqual(clearingCookies);
		expect(response.headers.has('content-length')).toBe(false);
	});
});
