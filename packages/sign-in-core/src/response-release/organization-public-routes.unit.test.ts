import { describe, expect, it } from 'vitest';

import { isPublicSignInRoute } from '#sign-in-core/response-release/sign-in-request-handler';

// The adopted B4a ingress list, independent of Better Auth's installed endpoint inventory.
const offeredPluginRoutes = [
	'/api/auth/organization/create',
	'/api/auth/organization/invite-member',
	'/api/auth/organization/cancel-invitation',
	'/api/auth/organization/accept-invitation',
	'/api/auth/organization/remove-member',
	'/api/auth/organization/set-active',
] as const;

describe('the organization plugin public surface', () => {
	it.each(offeredPluginRoutes)('admits only POST for %s', (pathname) => {
		// Arrange / Act / Assert: the existing deny-by-default route fence owns dispatch.
		expect(isPublicSignInRoute(pathname, 'POST')).toBe(true);
		for (const method of ['GET', 'PUT', 'DELETE', 'PATCH'])
			expect(isPublicSignInRoute(pathname, method)).toBe(false);
	});
	it.each([
		'leave',
		'update-member-role',
		'delete',
		'list',
		'get-full-organization',
		'list-members',
		'get-active-member',
		'add-member',
		'update',
		'list-invitations',
		'get-invitation',
		'list-user-invitations',
		'check-slug',
	])('keeps the unoffered plugin route %s off the public surface', (route) => {
		// Arrange
		const pathname = `/api/auth/organization/${route}`;
		// Act / Assert
		for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'])
			expect(isPublicSignInRoute(pathname, method)).toBe(false);
	});
});
