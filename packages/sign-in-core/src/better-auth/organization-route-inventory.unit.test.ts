import { organization } from 'better-auth/plugins/organization';
import { expect, it } from 'vitest';

import { isPublicSignInRoute } from '#sign-in-core/response-release/sign-in-request-handler';

it('offers exactly the six adopted POST routes from the installed organization plugin inventory', () => {
	// Arrange: inspect the actual pinned plugin, including routes absent from a handwritten matrix.
	const plugin = organization({
		teams: { enabled: false },
		dynamicAccessControl: { enabled: false },
	});
	const expected = [
		'/api/auth/organization/create',
		'/api/auth/organization/invite-member',
		'/api/auth/organization/cancel-invitation',
		'/api/auth/organization/accept-invitation',
		'/api/auth/organization/remove-member',
		'/api/auth/organization/set-active',
	].toSorted();
	const offered: string[] = [];
	// Act / Assert
	for (const [apiName, endpoint] of Object.entries(plugin.endpoints)) {
		if (endpoint.path === undefined) {
			// The native addMember API has no HTTP path; the public service never exposes it.
			expect(apiName).toBe('addMember');
			continue;
		}
		const path = `/api/auth${endpoint.path}`;
		if (isPublicSignInRoute(path, 'POST')) {
			expect(endpoint.options.method).toBe('POST');
			offered.push(path);
		}
		for (const method of ['GET', 'PUT', 'PATCH', 'DELETE'])
			expect(isPublicSignInRoute(path, method)).toBe(false);
	}
	expect(offered.toSorted()).toEqual(expected);
});
