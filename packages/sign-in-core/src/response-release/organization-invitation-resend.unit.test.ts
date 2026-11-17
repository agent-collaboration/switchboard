import { describe, expect, it, vi } from 'vitest';

import { handleSignInRequest } from '#sign-in-core/response-release/sign-in-request-handler';
import type { SignInResponseReleasePorts } from '#sign-in-core/response-release/sign-in-response-release';

const invitePath = '/api/auth/organization/invite-member';
const invitation = {
	email: 'member@example.invalid',
	role: 'member',
	organizationId: '11111111-1111-7111-8111-111111111111',
};
const ports: SignInResponseReleasePorts = {
	issuer: 'https://sign-in.example.invalid',
	toolPortalOrigin: 'https://portal.example.invalid',
	requestedResource: null,
	managementAudience: 'https://central.example.invalid/admin',
	accessTokenSeconds: 300,
	now: () => 1_800_000_000_000,
	inspectSignedToken: () => {
		throw new Error('No token inspection expected');
	},
	readAgent: async () => null,
	readWorkspaceResource: async () => null,
	isPersonSessionActive: async () => true,
	isPersonOrganizationSessionActive: async () => true,
	deleteSession: async () => {},
	cleanupUnboundPerson: async () => {},
};

async function dispatch(request: Request): Promise<{
	readonly response: Response;
	readonly calls: readonly string[];
}> {
	const calls: string[] = [];
	const providerHandler = vi.fn(async (input: Request): Promise<Response> => {
		calls.push(await input.text());
		return Response.json({ reachedProvider: true });
	});
	const response = await handleSignInRequest({
		request,
		providerHandler,
		issuedSessions: [],
		createdUserIds: [],
		ports,
	});
	return { response, calls };
}

describe('invitation resend is refused before provider dispatch', () => {
	it.each(['json', 'form'] as const)(
		'refuses resend:true in a %s body before Better Auth',
		async (format) => {
			// Arrange: the provider edge records any invocation; real plugin expiry proof is a higher-layer case.
			const request = new Request(`https://sign-in.example.invalid${invitePath}`, {
				method: 'POST',
				...(format === 'json'
					? {
							headers: { 'content-type': 'application/json' },
							body: JSON.stringify({ ...invitation, resend: true }),
						}
					: { body: new URLSearchParams({ ...invitation, resend: 'true' }) }),
			});
			// Act
			const result = await dispatch(request);
			// Assert
			expect(result.response.status).toBe(400);
			expect(result.calls).toEqual([]);
		},
	);
	it.each([undefined, false])(
		'preserves the JSON body with resend %j for native validation',
		async (resend) => {
			// Arrange
			const body = ` ${JSON.stringify({ ...invitation, ...(resend === undefined ? {} : { resend }) })} `;
			const request = new Request(`https://sign-in.example.invalid${invitePath}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body,
			});
			// Act
			const result = await dispatch(request);
			// Assert
			expect(result.response.status).toBe(200);
			expect(result.calls).toEqual([body]);
		},
	);
	it('preserves an ordinary form invitation for native validation', async () => {
		// Arrange
		const body = new URLSearchParams(invitation);
		const request = new Request(`https://sign-in.example.invalid${invitePath}`, {
			method: 'POST',
			body,
		});
		// Act
		const result = await dispatch(request);
		// Assert
		expect(result.response.status).toBe(200);
		expect(result.calls).toEqual([body.toString()]);
	});
	it('keeps the resend restriction specific to the invite route', async () => {
		// Arrange
		const body = JSON.stringify({
			invitationId: '22222222-2222-7222-8222-222222222222',
			resend: true,
		});
		const request = new Request(
			'https://sign-in.example.invalid/api/auth/organization/cancel-invitation',
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body,
			},
		);
		// Act
		const result = await dispatch(request);
		// Assert
		expect(result.response.status).toBe(200);
		expect(result.calls).toEqual([body]);
	});
	it('refuses malformed invite JSON before the provider', async () => {
		// Arrange
		const request = new Request(`https://sign-in.example.invalid${invitePath}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{',
		});
		// Act
		const result = await dispatch(request);
		// Assert
		expect(result.response.status).toBe(400);
		expect(result.calls).toEqual([]);
	});
});
