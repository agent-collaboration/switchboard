import { expect, it } from 'vitest';

import { inspectUuidCells } from '#sign-in-test-support/test-fixtures/stored-uuid-inventory';

it('finds mixed-case non-v7 UUIDs inside arbitrary text and JSON cells without returning their values', () => {
	expect(
		inspectUuidCells('independent_control', [
			{
				arbitrary: '{"id":"AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"}',
				nested: 'prefix:bbbbbbbb-bbbb-5bbb-8bbb-bbbbbbbbbbbb:suffix',
				admitted: 'cccccccc-cccc-7ccc-8ccc-cccccccccccc',
				variant: 'dddddddd-dddd-7ddd-0ddd-dddddddddddd',
				secret: 'random-secret-bytes',
			},
		]),
	).toEqual({
		uuidValues: 4,
		nonV7Locations: [
			{ table: 'independent_control', column: 'arbitrary', version: '4', reason: 'wrong-version' },
			{ table: 'independent_control', column: 'nested', version: '5', reason: 'wrong-version' },
			{ table: 'independent_control', column: 'variant', version: '7', reason: 'invalid-variant' },
		],
	});
});
