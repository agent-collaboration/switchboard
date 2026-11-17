import { expect, it } from 'vitest';

import { isPublicSignInRoute } from '#sign-in-core/response-release/sign-in-request-handler';

it.each(['get-session', 'list-accounts'])('offers %s only as a GET read', (route) => {
	const pathname = '/api/auth/' + route;
	expect(isPublicSignInRoute(pathname, 'GET')).toBe(true);
	for (const wrongMethod of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])
		expect(isPublicSignInRoute(pathname, wrongMethod)).toBe(false);
});

it.each([
	'list-sessions',
	'revoke-session',
	'revoke-sessions',
	'revoke-other-sessions',
	'update-session',
	'get-access-token',
	'refresh-token',
	'account-info',
	'unlink-account',
	'update-user',
	'delete-user',
	'sign-out',
])('keeps the neighbouring native route %s closed', (route) => {
	for (const method of ['GET', 'POST', 'PUT', 'DELETE'])
		expect(isPublicSignInRoute('/api/auth/' + route, method)).toBe(false);
});
