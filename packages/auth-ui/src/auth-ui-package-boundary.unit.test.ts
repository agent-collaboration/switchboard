import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const sourceRoot = fileURLToPath(new URL('.', import.meta.url));

async function productionSources(directory: string): Promise<readonly string[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	return (
		await Promise.all(
			entries.map(async (entry): Promise<readonly string[]> => {
				const target = `${directory}/${entry.name}`;
				if (entry.isDirectory()) return await productionSources(target);
				return /\.(ts|tsx)$/u.test(entry.name) && !entry.name.includes('.test.') ? [target] : [];
			}),
		)
	).flat();
}

/** Better Auth UI's components compose tool-access-ui's primitives and reach
 * Better Auth only through the injected auth client. The date picker and its
 * date library stay out (the additional-field edge was cut), and Radix never
 * enters (owner, 12 Nov). */
export function forbiddenAuthUiImport(specifier: string): boolean {
	return !/^(?:@auth-ui\/|@agent-collaboration\/tool-access-ui\/ui\/[a-z-]+$|@better-auth-ui\/(?:core|react)(?:\/plugins\/[a-z-]+)?$|@tanstack\/react-(?:form|query)$|input-otp$|sonner$|lucide-react$|cn$|react(?:-dom)?(?:\/|$)|\.{1,2}\/)/u.test(
		specifier,
	);
}

describe('auth-ui package boundary', (): void => {
	it('keeps production imports within the allowed component system', async (): Promise<void> => {
		const sources = await productionSources(sourceRoot);
		expect(sources.length).toBeGreaterThan(10);
		const specifiers = (
			await Promise.all(
				sources.map(async (sourcePath): Promise<readonly [string, string]> => [
					sourcePath,
					await readFile(sourcePath, 'utf8'),
				]),
			)
		).flatMap(([sourcePath, source]): string[] => {
			expect(source).not.toMatch(
				/\b(?:fetch\s*\(|XMLHttpRequest|process\.env|localStorage\.|document\.cookie\s*=)/u,
			);
			// Upstream keeps the offered second-factor methods (not a secret) for the
			// challenge view in sessionStorage; no other module may use storage.
			if (!sourcePath.endsWith('/lib/auth/two-factor-methods.ts'))
				expect(source).not.toMatch(/\bsessionStorage\s*[.[]/u);
			return [...source.matchAll(/(?:from\s+|import\s*\()\s*['"]([^'"]+)['"]/gu)].map(
				(match): string => match[1] ?? '',
			);
		});
		expect(specifiers.filter(forbiddenAuthUiImport)).toEqual([]);
	});

	it('rejects Radix, the cut date picker, hosts and Node, including subpaths', (): void => {
		for (const specifier of [
			'@radix-ui/react-dialog',
			'radix-ui',
			'react-day-picker',
			'date-fns',
			'node:fs',
			'@agent-collaboration/sign-in-core',
			'@agent-collaboration/tool-access-ui',
			'@agent-collaboration/tool-access-ui/server',
		])
			expect(forbiddenAuthUiImport(specifier)).toBe(true);
		for (const specifier of [
			'@agent-collaboration/tool-access-ui/ui/dialog',
			'@better-auth-ui/core/plugins/two-factor',
			'@auth-ui/components/auth/auth-form',
			'./backup-codes',
		])
			expect(forbiddenAuthUiImport(specifier)).toBe(false);
	});
});
