import { createRequire } from 'node:module';

import { z } from 'zod';

export interface IsolatedPageDom {
	readonly window: Pick<Window, 'document' | 'close' | 'addEventListener' | 'dispatchEvent'> &
		Pick<
			typeof globalThis,
			| 'MutationObserver'
			| 'Event'
			| 'FormData'
			| 'HTMLFormElement'
			| 'HTMLButtonElement'
			| 'HTMLInputElement'
			| 'HTMLSelectElement'
			| 'Option'
		>;
}

// Keep the host proof on Node. Importing @types/jsdom installs unrelated global
// DOM declarations; the pinned runtime needs only this local constructor port.
const jsdomRuntimeSchema = z.object({
	JSDOM: z.custom<
		new (
			html: string,
			options: { readonly url: string; readonly runScripts: 'outside-only' },
		) => IsolatedPageDom
	>((value) => typeof value === 'function', 'jsdom must export its DOM constructor'),
});

export function createIsolatedPageDom(html: string, url: string): IsolatedPageDom {
	const runtime: unknown = createRequire(import.meta.url)('jsdom');
	const { JSDOM } = jsdomRuntimeSchema.parse(runtime);
	return new JSDOM(html, { url, runScripts: 'outside-only' });
}
