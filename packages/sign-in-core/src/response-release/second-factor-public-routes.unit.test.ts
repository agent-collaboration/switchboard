import { expect, it } from 'vitest';

import { isPublicSignInRoute } from '#sign-in-core/response-release/sign-in-request-handler';

it.each([
	{ route: 'passkey/generate-register-options', method: 'GET' },
	{ route: 'passkey/list-user-passkeys', method: 'GET' },
	{ route: 'passkey/generate-authenticate-options', method: 'GET' },
	...[
		'two-factor/enable',
		'two-factor/verify-totp',
		'two-factor/verify-backup-code',
		'two-factor/generate-backup-codes',
		'two-factor/remove-app',
		'passkey/verify-registration',
		'passkey/verify-authentication',
		'passkey/update-passkey',
		'passkey/remove',
		'passkey/confirm-options',
		'passkey/confirm',
	].map((route) => ({ route, method: 'POST' })),
])('offers $route only as its declared $method', ({ route, method }) => {
	const pathname = '/api/auth/' + route;
	expect(isPublicSignInRoute(pathname, method)).toBe(true);
	for (const wrongMethod of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].filter(
		(candidate) => candidate !== method,
	))
		expect(isPublicSignInRoute(pathname, wrongMethod)).toBe(false);
});
it.each(['two-factor/disable', 'two-factor/get-totp-uri', 'passkey/delete-passkey'])(
	'keeps the unoffered native route %s closed',
	(route) => {
		for (const method of ['GET', 'POST', 'PUT', 'DELETE'])
			expect(isPublicSignInRoute('/api/auth/' + route, method)).toBe(false);
	},
);
