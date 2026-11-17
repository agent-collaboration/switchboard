import { z } from 'zod';

export const vendorDeclarationDiagnosticSchema = z.strictObject({
	file: z.string().startsWith('drizzle-orm/'),
	code: z.number().int().positive(),
	message: z.string().min(1),
});
export type VendorDeclarationDiagnostic = z.infer<typeof vendorDeclarationDiagnosticSchema>;
export const drizzleDeclarationInventorySchema = z.strictObject({
	vendor: z.literal('drizzle-orm'),
	version: z.literal('0.45.2'),
	typescript: z.literal('6.0.3'),
	diagnostics: z.array(vendorDeclarationDiagnosticSchema).length(86).readonly(),
});

export type VendorDiagnosticComparison =
	| { readonly kind: 'matched'; readonly knownDiagnostics: number }
	| {
			readonly kind: 'mismatched';
			readonly added: readonly VendorDeclarationDiagnostic[];
			readonly removed: readonly VendorDeclarationDiagnostic[];
	  };

function diagnosticKey(entry: VendorDeclarationDiagnostic): string {
	return JSON.stringify([entry.file, entry.code, entry.message]);
}
function unmatchedDiagnostics(
	actual: readonly VendorDeclarationDiagnostic[],
	expected: readonly VendorDeclarationDiagnostic[],
): readonly VendorDeclarationDiagnostic[] {
	const remaining = expected.map(diagnosticKey);
	return actual.filter((entry) => {
		const index = remaining.indexOf(diagnosticKey(entry));
		if (index === -1) return true;
		remaining.splice(index, 1);
		return false;
	});
}

/** Exact multiset comparison: duplicate occurrences count, discovery order does not. */
export function compareVendorDeclarationDiagnostics(
	actual: readonly VendorDeclarationDiagnostic[],
	expected: readonly VendorDeclarationDiagnostic[],
): VendorDiagnosticComparison {
	const added = unmatchedDiagnostics(actual, expected);
	const removed = unmatchedDiagnostics(expected, actual);
	return added.length === 0 && removed.length === 0
		? { kind: 'matched', knownDiagnostics: actual.length }
		: { kind: 'mismatched', added, removed };
}

const forbiddenDeclarationPackages = [
	'@types/node/',
	'@cloudflare/workers-types/',
	'@types/better-sqlite3/',
	'better-sqlite3/',
	'drizzle-orm/d1/',
	'drizzle-orm/better-sqlite3/',
	'kysely/',
	'gel/',
	'mysql2/',
] as const;

/** pnpm peer suffixes are metadata; only the final resolved package segment is loaded. */
export function forbiddenLoadedDeclarationFiles(files: readonly string[]): readonly string[] {
	return files.filter((file) => {
		const packageFile = file.replaceAll('\\', '/').split('/node_modules/').at(-1) ?? '';
		return forbiddenDeclarationPackages.some((prefix) => packageFile.startsWith(prefix));
	});
}
