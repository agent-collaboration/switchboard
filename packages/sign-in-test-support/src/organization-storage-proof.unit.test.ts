import { expect, it } from 'vitest';

import { requireOrganizationStorageProof } from '#sign-in-test-support/test-fixtures/organization-storage-proof';

const expected = { 'application.mjs': 'a'.repeat(64), 'worker.mjs': 'b'.repeat(64) };
const event = (moduleHashes: Readonly<Record<string, string>>): string =>
	JSON.stringify({ event: 'storage-worker-modules', moduleHashes });

it('requires actual storage owners and accepts the same frozen bytes across restarts', (): void => {
	const reordered = {
		'worker.mjs': expected['worker.mjs'],
		'application.mjs': expected['application.mjs'],
	};
	expect(
		requireOrganizationStorageProof(
			'noise\n' + event(expected) + '\n' + event(reordered),
			expected,
		),
	).toEqual([expected, reordered]);
	for (const stdout of [
		'',
		event({ ...expected, 'application.mjs': 'c'.repeat(64) }),
		event({ ...expected, extra: 'd'.repeat(64) }),
		event({ 'worker.mjs': expected['worker.mjs'] }),
	])
		expect(() => requireOrganizationStorageProof(stdout, expected)).toThrow('differ');
});

it('refuses malformed extra storage-owner receipts even beside a valid one', (): void => {
	expect(() =>
		requireOrganizationStorageProof(
			event(expected) + '\n' + event({ 'application.mjs': 'bad' }),
			expected,
		),
	).toThrow();
});
