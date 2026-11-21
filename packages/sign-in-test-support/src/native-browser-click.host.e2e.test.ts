import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, it } from 'vitest';
import { z } from 'zod';

import { withNativeBrowserCleanup } from '#sign-in-test-support/test-fixtures/native-browser-cleanup';
import { launchProofBrowser } from '#sign-in-test-support/test-fixtures/playwright-browser';

const targetSchema = z.object({
	expectedControl: z.boolean(),
	trusted: z.boolean(),
	tag: z.string(),
	id: z.string(),
	classes: z.array(z.string()),
});

type ClickLayout = 'stable' | 'measure-then-shift' | 'hit-test-then-shift';

/** Forces the layout changes at separate browser actions, with native input. */
async function observeNativeClick(layout: ClickLayout): Promise<{
	readonly error: string | null;
	readonly clicks: readonly z.infer<typeof targetSchema>[];
}> {
	const manifest = process.env.AUTH_PROOF_MANIFEST_FILE;
	const evidence = await mkdtemp(
		path.join(manifest === undefined ? tmpdir() : path.dirname(manifest), 'native-click-'),
	);
	const page = await launchProofBrowser({ evidence });
	return withNativeBrowserCleanup(
		async () => {
			await page.navigate(
				'data:text/html,' +
					encodeURIComponent(
						'<h1>Native click fixture</h1><style>#continue,#late-overlay{position:fixed;left:30px;top:100px;width:200px;height:40px}#continue{z-index:2}#late-overlay{z-index:1}</style><div id="late-overlay" class="late-render"></div><button type="button" id="continue">Continue</button>',
					),
			);
			await page.evaluate(
				`(()=>{const button=document.querySelector('#continue');window.nativeClickInputs=[];document.addEventListener('click',event=>window.nativeClickInputs.push({expectedControl:event.target===button,trusted:event.isTrusted,tag:event.target.tagName.toLowerCase(),id:event.target.id,classes:[...event.target.classList]}),true);const layout=${JSON.stringify(layout)};if(layout==='measure-then-shift'){const measure=button.getBoundingClientRect.bind(button);button.getBoundingClientRect=()=>{const rect=measure();button.style.transform='translateY(200px)';return rect;};}if(layout==='hit-test-then-shift'){const inspect=document.elementFromPoint.bind(document);document.elementFromPoint=(...coordinates)=>{const hit=inspect(...coordinates);button.style.transform='translateY(200px)';return hit;};}return true;})()`,
				z.literal(true),
			);
			let error: string | null = null;
			try {
				await page.click('#continue', 'Continue');
			} catch (error_) {
				error = error_ instanceof Error ? error_.message : 'Unknown browser click failure';
			}
			const clicks = await page.evaluate('window.nativeClickInputs', z.array(targetSchema));
			await writeFile(
				path.join(evidence, 'click-observation.json'),
				JSON.stringify({ layout, error, clicks }, null, 2),
				{ mode: 0o600 },
			);
			process.stdout.write(
				JSON.stringify({
					event: 'native-click-regression',
					evidence,
					layout,
					error,
					clicks,
				}) + '\n',
			);
			return { error, clicks };
		},
		() => page.close(),
	);
}

it('rejects a stale click point when a late layout shift moves the selected control', async (): Promise<void> => {
	// Arrange / Act
	const observed = await observeNativeClick('measure-then-shift');

	// Assert
	expect(observed.error).toContain('Proof control does not receive pointer input');
	expect(observed.clicks).toEqual([]);
});

it('dispatches real native input to a stable selected control', async (): Promise<void> => {
	// Arrange / Act
	const observed = await observeNativeClick('stable');

	// Assert
	expect(observed.error).toBeNull();
	expect(observed.clicks).toEqual([
		{ expectedControl: true, trusted: true, tag: 'button', id: 'continue', classes: [] },
	]);
});

it('fails immediately when a trusted click lands elsewhere after the hit test', async (): Promise<void> => {
	const observed = await observeNativeClick('hit-test-then-shift');

	expect(observed.error).toContain('Trusted click missed the intended control');
	expect(observed.clicks).toEqual([
		{
			expectedControl: false,
			trusted: true,
			tag: 'div',
			id: 'late-overlay',
			classes: ['late-render'],
		},
	]);
});
