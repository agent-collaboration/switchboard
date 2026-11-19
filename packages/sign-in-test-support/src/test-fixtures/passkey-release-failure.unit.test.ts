import { expect, it } from 'vitest';

import { createPasskeyReleaseFailure } from '#sign-in-test-support/test-fixtures/passkey-release-failure';

it('faults release and first cleanup only after an actual session INSERT, leaving audit and retry writable', async (): Promise<void> => {
	const failure = createPasskeyReleaseFailure();
	const read = {
		query: 'select * from "session" where ("session"."id" = ? and "session"."userId" = ?)',
		parameters: ['session-id', 'person-id'],
	};
	const deletion = { query: 'delete from "session" where "id" = ?', parameters: ['session-id'] };
	failure.control(
		new Request('http://proof.invalid/__auth-proof/passkey-release-failure', { method: 'POST' }),
	);
	expect(() => failure.beforeDriverCall(read)).not.toThrow();
	failure.beforeDriverCall({
		query: 'insert into "session" ("id") values (?)',
		parameters: ['session-id'],
	});
	expect(() => failure.beforeDriverCall(read)).toThrow('release session read');
	expect(() => failure.beforeDriverCall(deletion)).toThrow('first passkey release cleanup');
	expect(() => failure.beforeDriverCall(deletion)).not.toThrow();
	expect(() =>
		failure.beforeDriverCall({
			query: 'insert into "sign_in_audit" ("actor_user_id") values (?)',
			parameters: ['anonymous'],
		}),
	).not.toThrow();
	expect(
		await failure
			.control(new Request('http://proof.invalid/__auth-proof/passkey-release-failure'))
			?.json(),
	).toEqual({ state: 'cleanup-failed' });
});
