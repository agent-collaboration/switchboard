// Third-party notices: THIRD_PARTY_NOTICES.md#bridgeweb-theme (repository root).
import { readFile } from 'node:fs/promises';

import { bridgeDesignPalette } from '@tool-access-ui/design-tokens/bridge-design-palette';
import { bridgeDesignRowMetrics } from '@tool-access-ui/design-tokens/bridge-design-row-metrics';
import { expect, it } from 'vitest';

/** The theme CSS is canonical; the TS mirrors copied from BridgeWeb must equal it
 * (BridgeWeb's design-token check, pointed at this package's theme). */
async function themeDeclarations(): Promise<ReadonlyMap<string, string>> {
	const css = await readFile(new URL('../panel-theme.css', import.meta.url), 'utf8');
	return new Map(
		[...css.matchAll(/^\s*(--[a-z0-9-]+):\s*([^;]+);/gmu)].map((match): [string, string] => [
			match[1] ?? '',
			(match[2] ?? '').trim(),
		]),
	);
}

it('keeps the TS palette mirror equal to the theme palette, entry for entry', async () => {
	const declarations = await themeDeclarations();
	const themePalette = Object.fromEntries(
		[...declarations].filter(([name]) => name.startsWith('--palette-')),
	);
	expect(themePalette).toEqual(bridgeDesignPalette);
});

it('keeps the row metrics equal to the theme row heights', async () => {
	const declarations = await themeDeclarations();
	expect(declarations.get('--row-height-default')).toBe(`${bridgeDesignRowMetrics.default}px`);
	expect(declarations.get('--row-height-descriptive')).toBe(
		`${bridgeDesignRowMetrics.descriptive}px`,
	);
});
