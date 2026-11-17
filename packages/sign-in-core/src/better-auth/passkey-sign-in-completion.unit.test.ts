import { expect, it, vi } from 'vitest';

import { completePasskeySignIn } from '#sign-in-core/better-auth/passkey-sign-in-completion';

const session = {
	personId: '11111111-1111-7111-8111-111111111111',
	sessionId: '22222222-2222-7222-8222-222222222222',
};

it('records a successful sign-in for the one issued person', async () => {
	const recordSignIn = vi.fn(async (): Promise<void> => undefined);
	await completePasskeySignIn({
		response: new Response(null, { status: 200 }),
		issuedSessions: [session],
		recordSignIn,
	});
	expect(recordSignIn.mock.calls).toEqual([
		[{ actor: session.personId, outcome: 'succeeded', method: 'passkey' }],
	]);
});
it('records an ordinary refusal without throwing', async () => {
	const recordSignIn = vi.fn(async (): Promise<void> => undefined);
	await completePasskeySignIn({
		response: new Response(null, { status: 401 }),
		issuedSessions: [],
		recordSignIn,
	});
	expect(recordSignIn.mock.calls).toEqual([
		[{ actor: 'anonymous', outcome: 'failed', method: 'passkey' }],
	]);
});
it.each([
	{ status: 500, sessions: [session] },
	{ status: 200, sessions: [] },
	{ status: 200, sessions: [session, session] },
])('fails closed for $status with mismatched issued sessions', async ({ status, sessions }) => {
	const recordSignIn = vi.fn(async (): Promise<void> => undefined);
	await expect(
		completePasskeySignIn({
			response: new Response(null, { status }),
			issuedSessions: sessions,
			recordSignIn,
		}),
	).rejects.toThrow('disagree');
	expect(recordSignIn.mock.calls).toEqual([
		[{ actor: 'anonymous', outcome: 'failed', method: 'passkey' }],
	]);
});
it('propagates an unavailable audit write', async () => {
	await expect(
		completePasskeySignIn({
			response: new Response(),
			issuedSessions: [session],
			recordSignIn: async () => {
				throw new Error('audit unavailable');
			},
		}),
	).rejects.toThrow('audit unavailable');
});
