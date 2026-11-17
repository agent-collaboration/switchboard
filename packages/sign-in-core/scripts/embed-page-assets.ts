import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const generatedDirectory = new URL('../__generated__/', import.meta.url);

function fingerprintOf(contents: string): string {
	return createHash('sha256').update(contents).digest('hex').slice(0, 16);
}

const stylesheet = await readFile(new URL('sign-in.css', generatedDirectory), 'utf8');
const signInPagesIsland = await readFile(
	new URL('islands/sign-in-pages-island.js', generatedDirectory),
	'utf8',
);
// Bundle the build artifacts as text: neither host reads files to serve them.
await writeFile(
	new URL('sign-in-page-assets.js', generatedDirectory),
	[
		`export const signInStylesheet = ${JSON.stringify(stylesheet)};`,
		`export const signInStylesheetPath = "/assets/sign-in-${fingerprintOf(stylesheet)}.css";`,
		`export const signInPagesIsland = ${JSON.stringify(signInPagesIsland)};`,
		`export const signInPagesIslandPath = "/assets/sign-in-pages-${fingerprintOf(signInPagesIsland)}.js";`,
		'',
	].join('\n'),
);
await writeFile(
	new URL('sign-in-page-assets.d.ts', generatedDirectory),
	[
		'export declare const signInStylesheet: string;',
		'export declare const signInStylesheetPath: string;',
		'export declare const signInPagesIsland: string;',
		'export declare const signInPagesIslandPath: string;',
		'',
	].join('\n'),
);
