import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, it } from 'vitest';
import { z } from 'zod';

import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import { NativeBrowserPage } from '#sign-in-test-support/test-fixtures/native-browser-page';
import { startHeadlessChrome } from '#sign-in-test-support/test-fixtures/native-browser-protocol';
import { observeOrganizationBrowser } from '#sign-in-test-support/test-fixtures/organization-browser-scenario';
import {
	observeOrganizationEnterGesture,
	pressOrganizationBrowserKey,
	tabToOrganizationControl,
} from '#sign-in-test-support/test-fixtures/organization-browser-transport';

useControlledSignInClock();

it('people: real Chrome Enter submits the keyboard-focused native form without waiting for navigation', async (): Promise<void> => {
	const evidence = await mkdtemp(path.join(tmpdir(), '2026-11-native-enter-gesture-'));
	const chrome = await startHeadlessChrome(evidence);
	try {
		const protocol = chrome.page;
		await Promise.all(
			['Page.enable', 'Runtime.enable'].map((method) =>
				protocol.call(method, {}, z.object({}).passthrough()),
			),
		);
		const page = new NativeBrowserPage(protocol, evidence);
		const html =
			'<!doctype html><html><meta charset="utf-8"><title>Native Enter gesture</title><h1>Native Enter gesture</h1><form id="native-enter-form"><button id="native-enter-submit" type="submit">Submit native form</button></form><script>document.querySelector("form").addEventListener("submit",event=>event.preventDefault());</script></html>';
		await page.navigate(`data:text/html,${encodeURIComponent(html)}`);
		await tabToOrganizationControl({ page, protocol, selector: '#native-enter-submit' });
		const version = await chrome.browser.call(
			'Browser.getVersion',
			{},
			z.object({ product: z.string(), revision: z.string() }).passthrough(),
		);
		const observation = await observeOrganizationEnterGesture({
			page,
			buttonSelector: '#native-enter-submit',
			formSelector: '#native-enter-form',
			pressEnter: (): Promise<void> => pressOrganizationBrowserKey(protocol, 'Enter'),
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
			expect(observation.events.every((event) => event.expectedButton && event.expectedForm)).toBe(
				true,
			);
			expect(
				observation.events
					.filter(
						(event) =>
							event.kind === 'keydown' || event.kind === 'keypress' || event.kind === 'keyup',
					)
					.every((event) => event.enterKey),
			).toBe(true);
			expect(observation.activeElement.expectedButton).toBe(true);
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
	} finally {
		await chrome.close();
	}
});

// The host lane runs this file with default workerd/D1 and SIGN_IN_TEST_HOST=node.
it('people: real Chrome switches twice, completes the original native CLI, and reads back lost and refused switch replies', async (): Promise<void> => {
	await observeOrganizationBrowser('chooser');
});

it('people: real Chrome keeps the latest checked lookup and list page in a read-only accessible people page', async (): Promise<void> => {
	await observeOrganizationBrowser('people');
});
