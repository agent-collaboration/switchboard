import { expect, it } from 'vitest';

import { sessionReadWithoutToken } from '#sign-in-core/better-auth/session-read-without-token';

const sessionRead = {
	session: { id: 'session-id', userId: 'person-id', token: 'secret-session-token', expiresAt: 1 },
	user: { id: 'person-id', email: 'owner@example.invalid' },
};

it.each([
	{ shape: 'plain body', returned: sessionRead },
	{ shape: 'better-call json wrapper', returned: { body: sessionRead, _flag: 'json' } },
])('withholds the session token from a $shape', ({ returned }) => {
	const read = sessionReadWithoutToken(returned);
	expect(read).toEqual({
		kind: 'stripped',
		body: {
			session: { id: 'session-id', userId: 'person-id', expiresAt: 1 },
			user: { id: 'person-id', email: 'owner@example.invalid' },
		},
	});
	expect(JSON.stringify(read)).not.toContain('secret-session-token');
});

it.each([
	{ case: 'signed out', returned: null },
	{ case: 'signed out, wrapped', returned: { body: null, _flag: 'json' } },
	{ case: 'no session object', returned: { user: { id: 'person-id' } } },
])('leaves a read with nothing to withhold unchanged ($case)', ({ returned }) => {
	expect(sessionReadWithoutToken(returned)).toEqual({ kind: 'unchanged' });
});
