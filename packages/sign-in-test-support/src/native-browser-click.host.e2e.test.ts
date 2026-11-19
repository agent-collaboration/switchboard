import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, it } from 'vitest';
import { z } from 'zod';

import { NativeBrowserPage } from '#sign-in-test-support/test-fixtures/native-browser-page';
import { startHeadlessChrome } from '#sign-in-test-support/test-fixtures/native-browser-protocol';

const targetSchema = z.object({
	expectedControl: z.boolean(),
	tag: z.string(),
	id: z.string(),
	classes: z.array(z.string()),
});

/** The fixture moves after its old rect is read, without a timer or synthetic click. */
async function observeNativeClick(shiftAfterMeasurement: boolean): Promise<{
	readonly error: string | null;
	readonly clicks: readonly z.infer<typeof targetSchema>[];
}> {
	const manifest = process.env.AUTH_PROOF_MANIFEST_FILE;
	const evidence = await mkdtemp(
		path.join(manifest === undefined ? tmpdir() : path.dirname(manifest), 'native-click-'),
	);
	const chrome = await startHeadlessChrome(evidence);
	const page = new NativeBrowserPage(chrome.page, evidence);
	let error: string | null = null;
	try {
		await chrome.page.call('Page.enable', {}, z.object({}).passthrough());
		await chrome.page.call('Runtime.enable', {}, z.object({}).passthrough());
		await page.navigate(
			'data:text/html,' +
				encodeURIComponent(
					'<h1>Native click fixture</h1><style>#continue,#late-overlay{position:fixed;left:30px;top:100px;width:200px;height:40px}#continue{z-index:2}#late-overlay{z-index:1}</style><div id="late-overlay" class="late-render"></div><button type="button" id="continue">Continue</button>',
				),
		);
		await page.evaluate(
			`(()=>{const button=document.querySelector('#continue');window.nativeClickInputs=[];document.addEventListener('click',event=>window.nativeClickInputs.push({expectedControl:event.target===button,tag:event.target.tagName.toLowerCase(),id:event.target.id,classes:[...event.target.classList]}),true);if(${JSON.stringify(shiftAfterMeasurement)}){const measure=button.getBoundingClientRect.bind(button);button.getBoundingClientRect=()=>{const rect=measure();button.style.transform='translateY(200px)';return rect;};}return true;})()`,
			z.literal(true),
		);
		try {
			await page.click('#continue', 'Continue');
		} catch (error_) {
			error = error_ instanceof Error ? error_.message : 'Unknown native click failure';
		}
		const clicks = await page.evaluate('window.nativeClickInputs', z.array(targetSchema));
		await writeFile(
			path.join(evidence, 'click-observation.json'),
			JSON.stringify({ shiftAfterMeasurement, error, clicks, chromePid: chrome.pid }, null, 2),
			{ mode: 0o600 },
		);
		process.stdout.write(
			JSON.stringify({
				event: 'native-click-regression',
				evidence,
				shiftAfterMeasurement,
				error,
				clicks,
			}) + '\n',
		);
		return { error, clicks };
	} finally {
		await chrome.close();
	}
}

it('rejects a stale click point when a late layout shift moves the selected control', async (): Promise<void> => {
	// Arrange / Act
	const observed = await observeNativeClick(true);

	// Assert
	expect(observed.error).toContain('Native click hit');
	expect(observed.error).toContain('late-overlay');
	expect(observed.clicks).toEqual([]);
});

it('dispatches real native input to a stable selected control', async (): Promise<void> => {
	// Arrange / Act
	const observed = await observeNativeClick(false);

	// Assert
	expect(observed.error).toBeNull();
	expect(observed.clicks).toEqual([
		{ expectedControl: true, tag: 'button', id: 'continue', classes: [] },
	]);
});
