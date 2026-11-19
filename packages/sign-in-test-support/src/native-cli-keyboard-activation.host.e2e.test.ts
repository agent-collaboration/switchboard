import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, it } from 'vitest';
import { z } from 'zod';

import { NativeBrowserPage } from '#sign-in-test-support/test-fixtures/native-browser-page';
import { startHeadlessChrome } from '#sign-in-test-support/test-fixtures/native-browser-protocol';

/** Hold the actual protocol reply until a lower sibling has changed the live document. */
class LayoutInterleavedPage extends NativeBrowserPage {
	private pendingShift = true;

	override async evaluate<TValue>(expression: string, schema: z.ZodType<TValue>): Promise<TValue> {
		const result = await super.evaluate(expression, schema);
		if (this.pendingShift && expression.includes('getBoundingClientRect()')) {
			this.pendingShift = false;
			await super.evaluate(
				`(()=>{const button=document.querySelector('#continue');const lower=document.querySelector('#lower-content');const before=button.getBoundingClientRect().top;lower.style.height='260px';const after=button.getBoundingClientRect().top;window.observedShift={before,after};return before-after>100;})()`,
				z.literal(true),
			);
		}
		return result;
	}
}

it('activates the same Continue button after a lower sibling moves it between measurement and native input', async (): Promise<void> => {
	// Arrange: a real document, layout engine and native input; only their ordering is controlled.
	const manifest = process.env.AUTH_PROOF_MANIFEST_FILE;
	const evidence = await mkdtemp(
		path.join(manifest === undefined ? tmpdir() : path.dirname(manifest), 'native-keyboard-'),
	);
	const chrome = await startHeadlessChrome(evidence);
	const page = new LayoutInterleavedPage(chrome.page, evidence);
	try {
		await chrome.page.call('Page.enable', {}, z.object({}).passthrough());
		await chrome.page.call('Runtime.enable', {}, z.object({}).passthrough());
		await page.navigate(
			'data:text/html,' +
				encodeURIComponent(
					'<style>html{overflow-anchor:none}body{margin:0}main{min-height:800px;display:flex;flex-direction:column;justify-content:center}button{width:250px;height:40px}#lower-content{height:0}</style><main><h1>Continue fixture</h1><form id="owner-sign-in"><button id="continue" type="submit">Continue</button></form><div id="lower-content"></div></main>',
				),
		);
		await page.evaluate(
			`(()=>{window.activationInputs=[];const form=document.querySelector('#owner-sign-in');const button=document.querySelector('#continue');document.addEventListener('click',event=>window.activationInputs.push({kind:'click',expectedTarget:event.target===button,trusted:event.isTrusted,tag:event.target.tagName.toLowerCase()}),true);form.addEventListener('submit',event=>{event.preventDefault();window.activationInputs.push({kind:'submit',expectedTarget:event.target===form,trusted:event.isTrusted,tag:event.target.tagName.toLowerCase()});});return true;})()`,
			z.literal(true),
		);

		// Act: the override commits the sibling shift after measurement, before the Space press.
		await page.activateButton('#continue', 'Continue');
		const observed = await page.evaluate(
			'({shift:window.observedShift,inputs:window.activationInputs})',
			z.object({
				shift: z.object({ before: z.number(), after: z.number() }),
				inputs: z.array(
					z.object({
						kind: z.enum(['click', 'submit']),
						expectedTarget: z.boolean(),
						trusted: z.boolean(),
						tag: z.string(),
					}),
				),
			}),
		);
		await writeFile(
			path.join(evidence, 'keyboard-activation.json'),
			JSON.stringify({ ...observed, chromePid: chrome.pid }, null, 2),
			{ mode: 0o600 },
		);
		process.stdout.write(
			JSON.stringify({ event: 'native-keyboard-regression', evidence, ...observed }) + '\n',
		);

		// Assert: the original focused control, trusted browser click and real form submission survive.
		expect(observed.shift.before - observed.shift.after).toBeGreaterThan(100);
		expect(observed.inputs).toEqual([
			{ kind: 'click', expectedTarget: true, trusted: true, tag: 'button' },
			{ kind: 'submit', expectedTarget: true, trusted: true, tag: 'form' },
		]);
	} finally {
		await chrome.close();
	}
});
