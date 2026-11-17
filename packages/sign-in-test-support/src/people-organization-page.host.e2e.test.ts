import { createContext, Script } from 'node:vm';

import { organization } from '@agent-collaboration/sign-in-core';
import { expect, it } from 'vitest';
import { z } from 'zod';

import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import { controlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-sign-in-clock';
import { createIsolatedPageDom } from '#sign-in-test-support/test-fixtures/isolated-page-dom';
import { startLocalAuthHarness } from '#sign-in-test-support/test-fixtures/local-auth-harness';
import {
	signInPeopleBrowser,
	signInConfirmedPeopleBrowser,
} from '#sign-in-test-support/test-fixtures/people-browser-login';

useControlledSignInClock();
const ownerEmail = 'owner@example.invalid';
type Harness = Awaited<ReturnType<typeof startLocalAuthHarness>>;

async function ownerPage(harness: Harness): Promise<string> {
	const response = await harness.auth('/owner-ready');
	expect(response.status).toBe(200);
	return response.text();
}

async function expectOrganizationSetupFirst(harness: Harness): Promise<void> {
	const dom = createIsolatedPageDom(await ownerPage(harness), harness.issuer);
	try {
		expect(dom.window.document.getElementById('create-organization')).toBeNull();
		expect(dom.window.document.body.textContent).toContain('Set up your authenticator app first');
		const headings = [...dom.window.document.querySelectorAll('h2')].map(
			(heading) => heading.textContent,
		);
		expect(headings[0]).toBe('Your second factor');
		expect(headings.indexOf('Your second factor')).toBeLessThan(
			headings.indexOf('Create your organization'),
		);
	} finally {
		dom.window.close();
	}
}

/** Runs the delivered controller and native HTTP endpoint; only browser I/O is controlled. */
async function submitOrganizationPage(props: {
	readonly harness: Harness;
	readonly html: string;
	readonly slug: string;
}): Promise<{
	readonly message: string;
	readonly status: number;
	readonly code: string | undefined;
	readonly reloaded: boolean;
	/** Whether the page offered its confirm-again action, and whether that action reloaded. */
	readonly confirmAgain: 'not-offered' | 'offered-and-reloads' | 'offered-without-reload';
}> {
	const dom = createIsolatedPageDom(
		props.html,
		new URL('/owner-ready', props.harness.issuer).toString(),
	);
	const document = dom.window.document;
	const completed = Promise.withResolvers<boolean>();
	let reloads = 0;
	const responses: { status: number; code: string | undefined }[] = [];
	const status = document.getElementById('status');
	if (status === null) throw new Error('Served status is missing');
	const observer = new dom.window.MutationObserver(() => {
		if (status.textContent) completed.resolve(false);
	});
	observer.observe(status, { childList: true, subtree: true, characterData: true });
	try {
		const controller = [...document.scripts].find(
			(script) => !script.src && script.textContent.includes('const organizationForm='),
		);
		if (controller === undefined) throw new Error('Served organization controller is missing');
		const context = createContext({
			document,
			FormData: dom.window.FormData,
			Error,
			location: {
				reload: (): void => {
					reloads += 1;
					completed.resolve(true);
				},
			},
			fetch: async (path: string, init: RequestInit): Promise<Response> => {
				const response = await props.harness.auth(path, init);
				const body = z
					.looseObject({ code: z.string().optional() })
					.parse(await response.clone().json());
				responses.push({ status: response.status, code: body.code });
				return response;
			},
		});
		// The first delivered controller owns the status binding shared by the organization controller.
		const sessionController = document.scripts[0];
		if (sessionController === undefined || sessionController.src)
			throw new Error('Served session controller is missing');
		new Script(sessionController.textContent).runInContext(context);
		new Script(controller.textContent).runInContext(context);
		const form = document.getElementById('create-organization');
		if (!(form instanceof dom.window.HTMLFormElement))
			throw new Error('Confirmed owner form is missing');
		for (const [name, value] of [
			['organizationName', 'Page organization'],
			['organizationSlug', props.slug],
		] as const) {
			const input = form.querySelector(`[name=${name}]`);
			if (!(input instanceof dom.window.HTMLInputElement))
				throw new Error('Organization field is missing');
			input.value = value;
		}
		const button = form.querySelector('button');
		if (!(button instanceof dom.window.HTMLButtonElement))
			throw new Error('Organization action is missing');
		form.requestSubmit(button);
		const reloaded = await completed.promise;
		const response = responses[0];
		if (response === undefined) throw new Error('Organization request was not observed');
		const message = status.textContent;
		const action = document.getElementById('confirm-second-factor-again');
		if (!(action instanceof dom.window.HTMLButtonElement))
			throw new Error('Served confirm-again action is missing');
		let confirmAgain: 'not-offered' | 'offered-and-reloads' | 'offered-without-reload' =
			'not-offered';
		if (!action.hidden) {
			const reloadsBefore = reloads;
			action.click();
			confirmAgain = reloads > reloadsBefore ? 'offered-and-reloads' : 'offered-without-reload';
		}
		return { message, ...response, reloaded, confirmAgain };
	} finally {
		observer.disconnect();
		dom.window.close();
	}
}

it('offers organization creation only after native app confirmation and explains the page slug rule', async () => {
	const harness = await startLocalAuthHarness();
	try {
		await signInPeopleBrowser({ harness, email: ownerEmail });
		await expectOrganizationSetupFirst(harness);
		expect((await harness.totpAuthenticator.enrollApp(ownerEmail, harness.auth)).status).toBe(200);
		await expectOrganizationSetupFirst(harness);
		expect((await harness.totpAuthenticator.confirmApp(ownerEmail, harness.auth)).status).toBe(200);
		const html = await ownerPage(harness);
		const dom = createIsolatedPageDom(html, harness.issuer);
		try {
			expect(dom.window.document.getElementById('create-organization')).not.toBeNull();
			const slug = dom.window.document.querySelector('input[name="organizationSlug"]');
			const pattern = slug?.getAttribute('pattern') ?? '';
			expect(pattern).toBe('[a-z0-9\\-]+');
			// Browsers compile pattern with the v flag; an invalid one is silently ignored.
			expect(() => new RegExp(`^(?:${pattern})$`, 'v')).not.toThrow();
			const hint = dom.window.document.getElementById(slug?.getAttribute('aria-describedby') ?? '');
			expect(hint?.textContent).toBe('Used in links: lowercase letters, numbers, hyphens.');
		} finally {
			dom.window.close();
		}
		expect(
			await submitOrganizationPage({ harness, html, slug: 'page-organization' }),
		).toMatchObject({ status: 200, reloaded: true, confirmAgain: 'not-offered' });
		expect(await harness.database.select({ slug: organization.slug }).from(organization)).toEqual([
			{ slug: 'page-organization' },
		]);
	} finally {
		await harness.close();
	}
});

it('explains a real expired step-up refusal from a previously offered form and changes no organization state', async () => {
	const harness = await startLocalAuthHarness();
	try {
		await signInConfirmedPeopleBrowser({ harness, email: ownerEmail });
		const html = await ownerPage(harness);
		expect(
			(
				await harness.auth('/__auth-proof/set-clock', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ milliseconds: controlledSignInClock.now() + 15 * 60 * 1000 + 1 }),
				})
			).status,
		).toBe(200);
		const result = await submitOrganizationPage({ harness, html, slug: 'expired-step-up' });
		// One message that fits the done step, and the one action that returns to the confirm step.
		expect(result).toMatchObject({
			status: 403,
			code: 'SECOND_FACTOR_REQUIRED',
			reloaded: false,
			confirmAgain: 'offered-and-reloads',
		});
		expect(result.message).toBe(
			'Your confirmation has expired. Confirm with your app again to create the organization.',
		);
		expect(await harness.database.select({ id: organization.id }).from(organization)).toEqual([]);
		const dom = createIsolatedPageDom(await ownerPage(harness), harness.issuer);
		try {
			expect(dom.window.document.getElementById('create-organization')).toBeNull();
			expect(dom.window.document.body.textContent).toContain('Confirm your second factor first');
		} finally {
			dom.window.close();
		}
	} finally {
		await harness.close();
	}
});

it('keeps another native organization refusal distinct from the step-up message', async () => {
	const harness = await startLocalAuthHarness();
	try {
		await signInConfirmedPeopleBrowser({ harness, email: ownerEmail });
		const html = await ownerPage(harness);
		expect((await submitOrganizationPage({ harness, html, slug: 'already-created' })).status).toBe(
			200,
		);
		const result = await submitOrganizationPage({ harness, html, slug: 'already-created' });
		expect(result).toMatchObject({
			status: 400,
			code: 'ORGANIZATION_ALREADY_EXISTS',
			reloaded: false,
			confirmAgain: 'not-offered',
		});
		expect(result.message).toBe('Organization creation was refused');
		expect(await harness.database.select({ slug: organization.slug }).from(organization)).toEqual([
			{ slug: 'already-created' },
		]);
	} finally {
		await harness.close();
	}
});
