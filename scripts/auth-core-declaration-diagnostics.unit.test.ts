import { expect, it } from 'vitest';

import {
	compareVendorDeclarationDiagnostics,
	forbiddenLoadedDeclarationFiles,
	type VendorDeclarationDiagnostic,
} from './auth-core-declaration-diagnostics.ts';

const first: VendorDeclarationDiagnostic = {
	file: 'drizzle-orm/first.d.ts',
	code: 2307,
	message: 'Missing optional module',
};
const second: VendorDeclarationDiagnostic = {
	file: 'drizzle-orm/second.d.ts',
	code: 2420,
	message: 'Missing declared member',
};

it('matches exact diagnostics independently of discovery order and keeps duplicate occurrences', () => {
	expect(
		compareVendorDeclarationDiagnostics([second, first, first], [first, second, first]),
	).toEqual({ kind: 'matched', knownDiagnostics: 3 });
});
it('rejects an added vendor diagnostic', () => {
	expect(compareVendorDeclarationDiagnostics([first, second], [first])).toEqual({
		kind: 'mismatched',
		added: [second],
		removed: [],
	});
});
it('rejects a removed vendor diagnostic including a missing duplicate occurrence', () => {
	expect(compareVendorDeclarationDiagnostics([first], [first, first])).toEqual({
		kind: 'mismatched',
		added: [],
		removed: [first],
	});
});
it('rejects a changed file, code or full message even when the count is unchanged', () => {
	for (const changed of [
		{ ...first, file: 'drizzle-orm/changed.d.ts' },
		{ ...first, code: 2591 },
		{ ...first, message: first.message + ' changed' },
	])
		expect(compareVendorDeclarationDiagnostics([changed], [first]).kind).toBe('mismatched');
});
it('rejects actual runtime declarations while ignoring unused pnpm peer-path metadata', () => {
	const portable =
		'/node_modules/.pnpm/drizzle-orm@0.45.2_@cloudflare+workers-types@5/node_modules/drizzle-orm/sqlite-core/table.d.ts';
	const node = '/node_modules/.pnpm/@types+node@25/node_modules/@types/node/index.d.ts';
	const driver = '/node_modules/.pnpm/drizzle-orm@0.45.2/node_modules/drizzle-orm/d1/session.d.ts';
	expect(forbiddenLoadedDeclarationFiles([portable, node, driver])).toEqual([node, driver]);
});
