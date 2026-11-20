import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, it } from 'vitest';
import { z } from 'zod';

import { withNativeBrowserCleanup } from '#sign-in-test-support/test-fixtures/native-browser-cleanup';
import { launchProofBrowser } from '#sign-in-test-support/test-fixtures/playwright-browser';

it('activates the same Continue button after a lower sibling moves it between focus and native Enter', async (): Promise<void> => {
	// Arrange: a real document, layout engine and native input; only their ordering is controlled.
	const manifest = process.env.AUTH_PROOF_MANIFEST_FILE;
	const evidence = await mkdtemp(
		path.join(manifest === undefined ? tmpdir() : path.dirname(manifest), 'native-keyboard-'),
	);
	const page = await launchProofBrowser({ evidence });
	await withNativeBrowserCleanup(
		async (): Promise<void> => {
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

			// Act: the sibling changes layout after the real control receives focus.
			await page.focusButton('#continue', 'Continue');
			await page.evaluate(
				`(()=>{const button=document.querySelector('#continue');const lower=document.querySelector('#lower-content');const before=button.getBoundingClientRect().top;lower.style.height='260px';const after=button.getBoundingClientRect().top;window.observedShift={before,after};return button===document.activeElement;})()`,
				z.literal(true),
			);
			await page.page.keyboard.press('Enter');
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
				JSON.stringify({ ...observed }, null, 2),
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
		},
		() => page.close(),
	);
});
