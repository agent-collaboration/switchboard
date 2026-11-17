import { expect, it } from 'vitest';

import { nodeProofFailureLabels } from '#sign-in-test-support/test-fixtures/node-proof-invocation-failure';

it('retains only closed API and nested SQLite causes without message or request values', () => {
	const error = {
		name: 'APIError',
		status: 'SERVICE_UNAVAILABLE',
		body: { message: 'sign-in-storage-unavailable', privateValue: 'must-not-escape' },
		cause: {
			name: 'SqliteError',
			code: 'SQLITE_BUSY',
			message: 'must-not-escape',
			cause: { name: 'private-name', code: 'private-code', message: 'must-not-escape' },
		},
	};
	expect(nodeProofFailureLabels(error)).toEqual({
		names: ['APIError', 'SqliteError'],
		codes: ['SQLITE_BUSY'],
		statuses: ['SERVICE_UNAVAILABLE'],
		storageUnavailable: true,
	});
	expect(nodeProofFailureLabels(new Error('must-not-escape'))).toEqual({
		names: ['Error'],
		codes: [],
		statuses: [],
		storageUnavailable: false,
	});
});
