import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { member, organization } from '@agent-collaboration/sign-in-core';
import { organizationPersonTokenClaimsSchema } from '@agent-collaboration/sign-in-core/person-identity';
import { decodeJwt } from 'jose';
import { expect } from 'vitest';
import { z } from 'zod';

import {
	controlledSignInClock,
	controlledSignInIds,
} from '#sign-in-test-support/test-fixtures/controlled-sign-in-clock';
import { startLocalAuthHarness } from '#sign-in-test-support/test-fixtures/local-auth-harness';
import { NativeBrowserPage } from '#sign-in-test-support/test-fixtures/native-browser-page';
import {
	startHeadlessChrome,
	type ChromeProtocol,
} from '#sign-in-test-support/test-fixtures/native-browser-protocol';
import { exerciseOrganizationChooser } from '#sign-in-test-support/test-fixtures/organization-browser-chooser';
import { exerciseOrganizationPeople } from '#sign-in-test-support/test-fixtures/organization-browser-people';
import {
	installOrganizationBrowserCookie,
	OrganizationBrowserResponses,
} from '#sign-in-test-support/test-fixtures/organization-browser-transport';

const empty = z.object({}).passthrough();
export interface OrganizationBrowserScenario {
	readonly harness: Awaited<ReturnType<typeof startLocalAuthHarness>>;
	readonly protocol: ChromeProtocol;
	readonly page: NativeBrowserPage;
	readonly responses: OrganizationBrowserResponses;
	readonly root: string;
	readonly firstOrganizationId: string;
	readonly firstOrganizationName: string;
	readonly secondOrganizationId: string;
	readonly secondOrganizationName: string;
	readonly foreignOrganizationId: string;
	readonly initialSessionId: string;
	readonly ownerPersonId: string;
	readonly requestedPaths: string[];
	readonly capture: (name: string) => Promise<void>;
}

/** Lasting V2/V6 product journey. The host lane prepares the native artifacts. */
export async function observeOrganizationBrowser(kind: 'chooser' | 'people'): Promise<void> {
	const root = fileURLToPath(new URL('../../../../', import.meta.url));
	const sourceRevision = (
		await promisify(execFile)('git', ['rev-parse', 'HEAD'], { cwd: root })
	).stdout.trim();
	const host = process.env.SIGN_IN_TEST_HOST ?? 'cloudflare';
	const evidence = await mkdtemp(
		path.join(tmpdir(), `2026-11-organization-browser-${host}-${kind}-`),
	);
	process.stdout.write(
		`${JSON.stringify({ event: 'organization-browser-evidence', host, kind, sourceRevision, evidence })}\n`,
	);
	const harness = await startLocalAuthHarness();
	let chrome: Awaited<ReturnType<typeof startHeadlessChrome>> | undefined;
	let responses: OrganizationBrowserResponses | undefined;
	const screenshots: string[] = [];
	const requestedPaths: string[] = [];
	let status: 'passed' | 'failed' = 'failed';
	try {
		const initial = organizationPersonTokenClaimsSchema.parse(
			decodeJwt(await harness.ownerToken()),
		);
		const firstRows = await harness.database.select().from(organization);
		const first = firstRows.find((row) => row.id === initial.organization_id);
		if (first === undefined) throw new Error('Native owner organization is absent');
		const secondReply = await harness.auth('/api/auth/organization/create', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ name: 'Second membership', slug: 'second-browser-membership' }),
		});
		expect(secondReply.status).toBe(200);
		const second = z.object({ id: z.uuidv7() }).parse(await secondReply.json());
		expect(second.id).not.toBe(initial.organization_id);
		const foreignOrganizationId = controlledSignInIds.nextId();
		await harness.database.insert(organization).values({
			id: foreignOrganizationId,
			name: 'Foreign organization',
			slug: 'foreign-browser-membership',
			fleetState: 'settingUp',
			createdAt: new Date(controlledSignInClock.now()),
		});
		chrome = await startHeadlessChrome(evidence);
		const protocol = chrome.page;
		const page = new NativeBrowserPage(protocol, evidence);
		await Promise.all(
			['Page.enable', 'Runtime.enable', 'Network.enable'].map((method) =>
				protocol.call(method, {}, empty),
			),
		);
		await protocol.call(
			'Emulation.setDeviceMetricsOverride',
			{ width: 400, height: 844, deviceScaleFactor: 1, mobile: true },
			empty,
		);
		await protocol.call(
			'Emulation.setEmulatedMedia',
			{ features: [{ name: 'prefers-color-scheme', value: 'dark' }] },
			empty,
		);
		const version = await chrome.browser.call(
			'Browser.getVersion',
			{},
			z.object({ product: z.string(), revision: z.string() }).passthrough(),
		);
		await writeFile(
			path.join(evidence, 'target.json'),
			JSON.stringify(
				{
					sourceRevision,
					host,
					kind,
					version,
					viewport: { width: 400, height: 844 },
					colorScheme: 'dark',
				},
				null,
				2,
			),
			{ mode: 0o600 },
		);
		protocol.on('Network.requestWillBeSent', (value): void => {
			const request = z.object({ request: z.object({ url: z.string() }) }).parse(value);
			const url = new URL(request.request.url);
			if (url.origin === harness.issuer) requestedPaths.push(url.pathname);
		});
		responses = new OrganizationBrowserResponses(protocol);
		await responses.enable();
		await installOrganizationBrowserCookie({
			protocol,
			issuer: harness.issuer,
			cookie: harness.cookie(),
		});
		const context: OrganizationBrowserScenario = {
			harness,
			protocol,
			page,
			responses,
			root,
			firstOrganizationId: first.id,
			firstOrganizationName: first.name,
			secondOrganizationId: second.id,
			secondOrganizationName: 'Second membership',
			foreignOrganizationId,
			initialSessionId: initial.sid,
			ownerPersonId: initial.sub,
			requestedPaths,
			async capture(name: string): Promise<void> {
				const shot = await protocol.call(
					'Page.captureScreenshot',
					{ format: 'png', captureBeyondViewport: false },
					z.object({ data: z.string() }),
				);
				await writeFile(path.join(evidence, `${name}.png`), Buffer.from(shot.data, 'base64'), {
					mode: 0o600,
				});
				screenshots.push(`${name}.png`);
			},
		};
		if (kind === 'chooser') await exerciseOrganizationChooser(context);
		else await exerciseOrganizationPeople(context);
		const nativeReads = new Set([
			'/api/auth/organization/list',
			'/api/auth/organization/get-full-organization',
			'/api/auth/organization/list-members',
			'/api/auth/organization/list-invitations',
		]);
		expect(requestedPaths.filter((pathname) => nativeReads.has(pathname))).toEqual([]);
		// Preserve the old chooser's adversarial fixture assertion: refusal creates no membership.
		expect(
			(await harness.database.select().from(member)).filter(
				(row) => row.organizationId === foreignOrganizationId,
			),
		).toEqual([]);
		expect(
			(await promisify(execFile)('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim(),
		).toBe(sourceRevision);
		status = 'passed';
	} finally {
		await writeFile(
			path.join(evidence, 'observation.json'),
			JSON.stringify(
				{
					sourceRevision,
					host,
					kind,
					status,
					screenshots,
					requestedPaths,
					standIns: [
						'external identity provider',
						'Turnstile siteverify',
						'Central',
						'software authenticator',
						'controlled clock',
					],
					notCovered: ['hosted deployment', 'real provider sign-in', 'physical authenticator'],
				},
				null,
				2,
			),
			{ mode: 0o600 },
		);
		try {
			await responses?.close();
		} finally {
			try {
				await chrome?.close();
			} finally {
				await harness.close();
			}
		}
	}
}
