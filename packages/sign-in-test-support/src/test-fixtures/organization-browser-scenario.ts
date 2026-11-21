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
import { withNativeBrowserCleanup } from '#sign-in-test-support/test-fixtures/native-browser-cleanup';
import { exerciseOrganizationChooser } from '#sign-in-test-support/test-fixtures/organization-browser-chooser';
import {
	closeOrganizationBrowserScenario,
	type OrganizationBrowserFailure,
} from '#sign-in-test-support/test-fixtures/organization-browser-cleanup';
import { exerciseOrganizationPeople } from '#sign-in-test-support/test-fixtures/organization-browser-people';
import {
	installOrganizationBrowserCookie,
	OrganizationBrowserResponses,
} from '#sign-in-test-support/test-fixtures/organization-browser-transport';
import {
	launchProofBrowser,
	type PlaywrightBrowserPage,
} from '#sign-in-test-support/test-fixtures/playwright-browser';

export interface OrganizationBrowserScenario {
	readonly harness: Awaited<ReturnType<typeof startLocalAuthHarness>>;
	readonly page: PlaywrightBrowserPage;
	readonly scenarioSignal: AbortSignal;
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
export async function observeOrganizationBrowser(
	kind: 'chooser' | 'people',
	host: 'node' | 'cloudflare',
	scenarioSignal: AbortSignal,
): Promise<void> {
	const root = fileURLToPath(new URL('../../../../', import.meta.url));
	const sourceRevision = (
		await promisify(execFile)('git', ['rev-parse', 'HEAD'], { cwd: root })
	).stdout.trim();
	const evidence = await mkdtemp(
		path.join(tmpdir(), `2026-11-organization-browser-${host}-${kind}-`),
	);
	process.stdout.write(
		`${JSON.stringify({ event: 'organization-browser-evidence', host, kind, sourceRevision, evidence })}\n`,
	);
	const harness = await startLocalAuthHarness({ host, turnstileSecret: 'published-test' });
	let chrome: Awaited<ReturnType<typeof launchProofBrowser>> | undefined;
	let responses: OrganizationBrowserResponses | undefined;
	const screenshots: string[] = [];
	const requestedPaths: string[] = [];
	let status: 'passed' | 'failed' = 'failed';
	let scenarioFailure: OrganizationBrowserFailure = { kind: 'none' };
	try {
		if (harness.signInHost !== host)
			throw new Error(`Requested ${host} browser scenario resolved ${harness.signInHost}`);
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
		chrome = await launchProofBrowser({
			evidence,
			origin: harness.issuer,
			colorScheme: 'dark',
			scenarioSignal,
		});
		const page = chrome;
		const version = await page.protocol.send('Browser.getVersion');
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
		page.page.on('request', (request): void => {
			const url = new URL(request.url());
			if (url.origin === harness.issuer) requestedPaths.push(url.pathname);
		});
		responses = new OrganizationBrowserResponses(page);
		await responses.enable(harness.issuer);
		await installOrganizationBrowserCookie({
			page,
			issuer: harness.issuer,
			cookie: harness.cookie(),
		});
		const context: OrganizationBrowserScenario = {
			harness,
			page,
			scenarioSignal,
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
				await writeFile(path.join(evidence, `${name}.png`), await page.captureFailureFrame(), {
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
	} catch (error) {
		scenarioFailure = { kind: 'failed', error };
	} finally {
		await closeOrganizationBrowserScenario({
			failure: scenarioFailure,
			record: async (): Promise<void> => {
				await writeFile(
					path.join(evidence, 'observation.json'),
					JSON.stringify(
						{
							sourceRevision,
							host,
							kind,
							status,
							actualHarnessHost: harness.signInHost,
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
			},
			close: async (): Promise<void> => {
				await withNativeBrowserCleanup(
					async (): Promise<void> => {
						await responses?.close();
					},
					() =>
						withNativeBrowserCleanup(
							async (): Promise<void> => {
								await chrome?.close();
							},
							() => harness.close(),
						),
				);
				const cleanup = {
					sourceRevision,
					host: harness.signInHost,
					kind,
					browserConnectedAfterClose: chrome?.isBrowserConnected() ?? null,
					harnessTeardown: harness.teardownObservations.map((entry) => entry.kind),
				};
				await writeFile(path.join(evidence, 'cleanup.json'), JSON.stringify(cleanup), {
					mode: 0o600,
				});
			},
		});
	}
}
