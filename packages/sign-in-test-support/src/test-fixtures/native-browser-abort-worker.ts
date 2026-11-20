import path from 'node:path';

import { z } from 'zod';

import { startHeadlessChrome } from '#sign-in-test-support/test-fixtures/native-browser-protocol';

const evidence = z.string().min(1).parse(process.env.NATIVE_ABORT_EVIDENCE);
const browsers: Awaited<ReturnType<typeof startHeadlessChrome>>[] = [];
async function retainBrowser(name: string): Promise<void> {
	const chrome = await startHeadlessChrome(path.join(evidence, name));
	browsers.push(chrome);
	process.send?.({ kind: 'retained', group: chrome.pid });
}
try {
	await retainBrowser('first');
	await retainBrowser('second');
	process.on('message', (): void => {});
	process.send?.({ kind: 'ready', groups: browsers.map((browser) => browser.pid) });
	// The host test aborts this worker mid-run. The fixture lifecycle owns browser cancellation.
} catch {
	await Promise.allSettled(browsers.map((browser) => browser.close()));
	process.exitCode = 1;
}
