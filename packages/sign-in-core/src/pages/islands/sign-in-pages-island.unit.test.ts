// @vitest-environment jsdom
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { signInIslandAttribute } from '#sign-in-core/pages/islands/sign-in-island-state';
import { mountSignInIslands } from '#sign-in-core/pages/islands/sign-in-pages-island';

/** A served recovery-codes page: one island root over its no-script list. */
function recoveryCodesPage(codes: readonly string[]): string {
	const state = JSON.stringify({
		kind: 'recovery-codes',
		codes,
		ownerReadyLocation: '/owner-ready',
	});
	return `<!doctype html><html><head></head><body><main><h1>New recovery codes</h1><div ${signInIslandAttribute}="" data-island-state='${state}'><ul>${codes.map((code) => `<li><code>${code}</code></li>`).join('')}</ul></div></main></body></html>`;
}

const savedCodesButtons = (): HTMLButtonElement[] =>
	[...document.querySelectorAll('button')].filter((button) =>
		/saved my recovery codes/iu.test(button.textContent ?? ''),
	);

beforeEach(() => {
	vi.stubGlobal('matchMedia', (query: string): MediaQueryList => ({
		matches: false,
		media: query,
		onchange: null,
		addListener: (): void => {},
		removeListener: (): void => {},
		addEventListener: (): void => {},
		removeEventListener: (): void => {},
		dispatchEvent: (): boolean => true,
	}));
});

it('mounts the islands of a page a factor form writes into the same window, once per root', async () => {
	// A first page mounts as it loads.
	document.open();
	document.write(recoveryCodesPage(['first-one', 'first-two']));
	document.close();
	mountSignInIslands(document);
	await vi.waitFor(() => expect(savedCodesButtons()).toHaveLength(1));
	expect(document.querySelector(`[${signInIslandAttribute}] ul code`)).toBeNull();

	// Its bootstrap may run again; a mounted root is left as it is, not mounted twice.
	const [mountedFinish] = savedCodesButtons();
	mountSignInIslands(document);
	await new Promise<void>((resolve) => queueMicrotask(resolve));
	expect(savedCodesButtons()).toEqual([mountedFinish]);
	expect(mountedFinish?.isConnected).toBe(true);

	// A factor form replaces the page in the same window (the module stays
	// evaluated), and the written page's bootstrap mounts its new root.
	document.open();
	document.write(recoveryCodesPage(['second-one', 'second-two']));
	document.close();
	expect(document.querySelector(`[${signInIslandAttribute}] ul code`)?.textContent).toBe(
		'second-one',
	);
	mountSignInIslands(document);
	await vi.waitFor(() => expect(savedCodesButtons()).toHaveLength(1));
	expect(document.body.textContent).toContain('second-one');
	expect(document.body.textContent).not.toContain('first-one');
	// The page's one tree, and so its toaster, lives in the written document.
	expect(document.querySelectorAll('section[aria-label^="Notifications"]')).toHaveLength(1);
});

it('switches zod JIT off before the island constructs any schema', async () => {
	// zod probes Function('') when it constructs an object schema, a script-src
	// violation on every island page. ESM evaluates imports in order, so the
	// switch must be the entry's first import; setting it later is too late.
	// Vitest runs from the repository root; jsdom's import.meta.url is not a file URL.
	const entry = await readFile(
		path.resolve('packages/sign-in-core/src/pages/islands/sign-in-pages-island.tsx'),
		'utf8',
	);
	const firstImport = /^import\s[^;]*;/mu.exec(entry)?.[0];
	expect(firstImport).toBe("import '#sign-in-core/pages/islands/zod-without-jit';");
	expect(z.config().jitless).toBe(true);
});
