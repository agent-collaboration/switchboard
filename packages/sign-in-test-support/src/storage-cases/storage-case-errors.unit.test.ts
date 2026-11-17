import { expect, it } from 'vitest';

import {
	captureStorageCase,
	storageCaseErrorMessage,
} from '#sign-in-test-support/storage-cases/storage-case-errors';

it('retains a constraint diagnosis without exporting bound credential material', () => {
	const failure = new Error(
		'Failed query: insert into session values (?)\nparams: captured-private-session',
		{ cause: new Error('NOT NULL constraint failed: session.updatedAt') },
	);
	expect(storageCaseErrorMessage(failure)).toBe('NOT NULL constraint failed: session.updatedAt');
	expect(storageCaseErrorMessage(failure)).not.toContain('captured-private-session');
});
it('keeps only the query description when a driver provides no safe constraint cause', async () => {
	const result = await captureStorageCase(async () => {
		throw new Error(
			'Failed query: insert into session values (?)\nparams: captured-private-session',
		);
	});
	expect(result).toEqual({
		kind: 'case-error',
		message: 'Failed query: insert into session values (?)',
	});
});
