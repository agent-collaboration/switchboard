import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, it } from 'vitest';

import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import { withNativeBrowserCleanup } from '#sign-in-test-support/test-fixtures/native-browser-cleanup';
import { observeOrganizationBrowser } from '#sign-in-test-support/test-fixtures/organization-browser-scenario';
import {
	observeOrganizationEnterGesture,
	tabToOrganizationControl,
} from '#sign-in-test-support/test-fixtures/organization-browser-transport';
import {
	launchProofBrowser,
	runProofBrowserScenario,
} from '#sign-in-test-support/test-fixtures/playwright-browser';

useControlledSignInClock();

it('people: real Chrome Enter submits the keyboard-focused native form without waiting for navigation', async (): Promise<void> => {
	const evidence = await mkdtemp(path.join(tmpdir(), '2026-11-native-enter-gesture-'));
	const page = await launchProofBrowser({ evidence });
	await withNativeBrowserCleanup(
		async (): Promise<void> => {
			const html =
				'<!doctype html><html><meta charset="utf-8"><title>Native Enter gesture</title><h1>Native Enter gesture</h1><form id="native-enter-form"><button id="native-enter-submit" type="submit">Submit native form</button></form><script>document.querySelector("form").addEventListener("submit",event=>event.preventDefault());</script></html>';
			await page.navigate(`data:text/html,${encodeURIComponent(html)}`);
			await tabToOrganizationControl({ page, selector: '#native-enter-submit' });
			const version = await page.protocol.send('Browser.getVersion');
			const observation = await observeOrganizationEnterGesture({
				page,
				buttonSelector: '#native-enter-submit',
				formSelector: '#native-enter-form',
				pressEnter: (): Promise<void> => page.page.keyboard.press('Enter'),
			});
			process.stdout.write(
				`${JSON.stringify({ event: 'native-enter-gesture', evidence, observation })}\n`,
			);
			try {
				// keyup already occurred: a missing native submit is an immediate assertion failure.
				expect(
					observation.events.some(
						(event) => event.kind === 'submit' && event.expectedButton && event.expectedForm,
					),
				).toBe(true);
				expect(observation.events.map((event) => event.kind)).toEqual([
					'keydown',
					'keypress',
					'click',
					'submit',
					'keyup',
				]);
				expect(
					observation.events.every((event) => event.expectedButton && event.expectedForm),
				).toBe(true);
				expect(
					observation.events
						.filter(
							(event) =>
								event.kind === 'keydown' || event.kind === 'keypress' || event.kind === 'keyup',
						)
						.every((event) => event.enterKey),
				).toBe(true);
				expect(observation.activeElement.expectedButton).toBe(true);
				expect(observation.events.every((event) => event.trusted)).toBe(true);
			} finally {
				await writeFile(
					path.join(evidence, 'observation.json'),
					JSON.stringify(
						{ version, observation, completion: 'Actual Enter keyup', diagnosticFormOnly: true },
						null,
						2,
					),
					{ mode: 0o600 },
				);
			}
		},
		() => page.close(),
	);
});

it.each(['node', 'cloudflare'] as const)(
	'people: real Chrome switches twice, completes the original native CLI, and reads back lost and refused switch replies on %s',
	async (host): Promise<void> => {
		await runProofBrowserScenario((signal) => observeOrganizationBrowser('chooser', host, signal));
	},
);

it.each(['node', 'cloudflare'] as const)(
	'people: real Chrome keeps the latest checked lookup and list page in a read-only accessible people page on %s',
	async (host): Promise<void> => {
		await runProofBrowserScenario((signal) => observeOrganizationBrowser('people', host, signal));
	},
);
