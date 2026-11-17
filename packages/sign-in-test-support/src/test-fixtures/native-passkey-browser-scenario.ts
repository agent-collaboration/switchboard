import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { invitation } from '@agent-collaboration/sign-in-core';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import { controlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-sign-in-clock';
import { startLocalAuthHarness } from '#sign-in-test-support/test-fixtures/local-auth-harness';
import {
	NativeBrowserPage,
	nativeNetworkResponseSchema,
} from '#sign-in-test-support/test-fixtures/native-browser-page';
import { startHeadlessChrome } from '#sign-in-test-support/test-fixtures/native-browser-protocol';
import type { NativeBrowserStep } from '#sign-in-test-support/test-fixtures/native-browser-scenario';
import { loginThroughNativeOwnerCli } from '#sign-in-test-support/test-fixtures/native-cli-proof';
import { prepareNodeProofArtifacts } from '#sign-in-test-support/test-fixtures/node-proof-artifacts';
import { prepareProofBundles } from '#sign-in-test-support/test-fixtures/proof-bundle-artifacts';
const execute = promisify(execFile);
const empty = z.object({}).passthrough();
const email = 'owner@example.invalid';
type PasskeyBrowserRun = 'journey' | 'no-user-verification' | 'cli-login' | 'script-failure';

/** Each run owns real storage and one browser, so its setup cannot consume another run's flood budget. */
export async function observeNativePasskeyBrowser(
	host: 'node' | 'cloudflare',
	kind: PasskeyBrowserRun,
): Promise<void> {
	const root = fileURLToPath(new URL('../../../../', import.meta.url));
	const sourceRevision = (await execute('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
	const prefix = new Date(controlledSignInClock.now()).toISOString().slice(0, 7);
	const evidence = await mkdtemp(path.join(tmpdir(), `${prefix}-passkey-${kind}-${host}-`));
	process.stdout.write(
		JSON.stringify({ event: 'native-passkey-evidence', host, kind, sourceRevision, evidence }) +
			'\n',
	);
	const previous = {
		host: process.env.SIGN_IN_TEST_HOST,
		manifest: process.env.AUTH_PROOF_MANIFEST_FILE,
		node: process.env.AUTH_PROOF_NODE_MANIFEST_FILE,
	};
	const steps: NativeBrowserStep[] = [];
	const statuses: { readonly pathname: string; readonly status: number }[] = [];
	let activeStep = 'prepare';
	let harness: Awaited<ReturnType<typeof startLocalAuthHarness>> | undefined;
	let chrome: Awaited<ReturnType<typeof startHeadlessChrome>> | undefined;
	let browser: NativeBrowserPage | undefined;
	let cleanupFailure: string | null = null;
	async function phase(name: string): Promise<void> {
		activeStep = name;
		await writeFile(
			path.join(evidence, 'current-phase.json'),
			JSON.stringify({ host, kind, phase: name }),
			{ mode: 0o600 },
		);
		process.stdout.write(
			JSON.stringify({ event: 'native-passkey-phase', host, kind, phase: name }) + '\n',
		);
	}
	async function passed(
		name: string,
		facts: Readonly<Record<string, unknown>>,
		capture = false,
	): Promise<void> {
		steps.push({
			name,
			status: 'passed',
			facts,
			...(capture && browser !== undefined ? { screenshot: await browser.screenshot(name) } : {}),
		});
		await writeFile(path.join(evidence, 'steps.json'), JSON.stringify(steps, null, 2), {
			mode: 0o600,
		});
	}
	try {
		process.env.SIGN_IN_TEST_HOST = host;
		const manifestFile = path.join(evidence, 'bundle-manifest.json');
		await writeFile(manifestFile, JSON.stringify(await prepareProofBundles(root, evidence)), {
			mode: 0o600,
			flag: 'wx',
		});
		process.env.AUTH_PROOF_MANIFEST_FILE = manifestFile;
		if (host === 'node') {
			const file = path.join(evidence, 'node-manifest.json');
			await writeFile(file, JSON.stringify(await prepareNodeProofArtifacts(root, evidence)), {
				mode: 0o600,
				flag: 'wx',
			});
			process.env.AUTH_PROOF_NODE_MANIFEST_FILE = file;
		} else delete process.env.AUTH_PROOF_NODE_MANIFEST_FILE;
		harness = await startLocalAuthHarness({
			turnstileSecret: 'published-test',
			issuerHostname: 'localhost',
		});
		const target = harness;
		chrome = await startHeadlessChrome(evidence);
		const protocol = chrome.page;
		browser = new NativeBrowserPage(protocol, evidence);
		const page = browser;
		const version = await chrome.browser.call(
			'Browser.getVersion',
			{},
			z.object({
				product: z.string(),
				revision: z.string(),
				protocolVersion: z.string(),
				userAgent: z.string(),
				jsVersion: z.string(),
			}),
		);
		await writeFile(path.join(evidence, 'browser-version.json'), JSON.stringify(version), {
			mode: 0o600,
		});
		await Promise.all(
			['Page.enable', 'Runtime.enable', 'Log.enable'].map((method) =>
				protocol.call(method, {}, empty),
			),
		);
		// Preserve the original native response body across success navigation; no response is replaced.
		await protocol.call(
			'Network.enable',
			{
				enableDurableMessages: true,
				maxTotalBufferSize: 16_777_216,
				maxResourceBufferSize: 8_388_608,
			},
			empty,
		);
		await protocol.call('Network.setCacheDisabled', { cacheDisabled: true }, empty);
		await protocol.call(
			'Emulation.setDeviceMetricsOverride',
			{ width: 400, height: 844, deviceScaleFactor: 1, mobile: true },
			empty,
		);
		const responseBodies: string[] = [];
		const responsePaths = new Map<string, string>();
		const captureWork: Promise<void>[] = [];
		protocol.on('Network.responseReceived', (value): void => {
			const parsed = nativeNetworkResponseSchema.safeParse(value);
			if (!parsed.success || new URL(parsed.data.response.url).origin !== target.issuer) return;
			const pathname = new URL(parsed.data.response.url).pathname;
			statuses.push({ pathname, status: parsed.data.response.status });
			if (parsed.data.response.status === 200) responsePaths.set(parsed.data.requestId, pathname);
		});
		protocol.on('Network.loadingFinished', (value): void => {
			const id = z.object({ requestId: z.string() }).parse(value).requestId;
			const pathname = responsePaths.get(id);
			if (pathname === undefined) return;
			responsePaths.delete(id);
			const work = protocol
				.call(
					'Network.getResponseBody',
					{ requestId: id },
					z.object({ body: z.string(), base64Encoded: z.boolean() }),
				)
				.then((body): void => {
					responseBodies.push(
						body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body,
					);
				})
				.catch((error: unknown): never => {
					throw new Error(`Response capture failed for ${pathname} during ${activeStep}`, {
						cause: error,
					});
				});
			void work.catch(() => undefined);
			captureWork.push(work);
		});
		let scriptShouldFail = false;
		let scriptFailure: Error | null = null;
		protocol.on('Fetch.requestPaused', (value): void => {
			const id = z.object({ requestId: z.string() }).parse(value).requestId;
			const tokens = Array.from({ length: 8 }, () =>
				target.turnstile.issueToken({
					action: 'passkey_sign_in',
					hostname: new URL(target.issuer).hostname,
					verdict: 'accepted',
				}),
			);
			const script = `(()=>{const tokens=${JSON.stringify(tokens)};const widgets=new Map();let next=0;window.turnstile={render(container,options){const id=String(++next);widgets.set(id,options);return id;},reset(){},execute(id){const token=tokens.shift();if(!token)throw new Error('Controlled token inventory exhausted');queueMicrotask(()=>widgets.get(id).callback(token));}};window.onSignInTurnstileReady();})();`;
			const work = scriptShouldFail
				? protocol.call('Fetch.failRequest', { requestId: id, errorReason: 'Failed' }, empty)
				: protocol.call(
						'Fetch.fulfillRequest',
						{
							requestId: id,
							responseCode: 200,
							responseHeaders: [{ name: 'content-type', value: 'application/javascript' }],
							body: Buffer.from(script).toString('base64'),
						},
						empty,
					);
			void work.catch((error: unknown): void => {
				scriptFailure =
					error instanceof Error ? error : new Error('Turnstile script interception failed');
			});
		});
		await protocol.call(
			'Fetch.enable',
			{
				patterns: [
					{
						urlPattern: 'https://challenges.cloudflare.com/turnstile/v0/api.js*',
						requestStage: 'Request',
					},
				],
			},
			empty,
		);
		await protocol.call('WebAuthn.enable', {}, empty);
		const authenticator = await protocol.call(
			'WebAuthn.addVirtualAuthenticator',
			{
				options: {
					protocol: 'ctap2',
					transport: 'internal',
					hasResidentKey: true,
					hasUserVerification: true,
					isUserVerified: true,
					automaticPresenceSimulation: true,
				},
			},
			z.object({ authenticatorId: z.string() }),
		);
		let challengeCount = 0;
		protocol.on('Network.requestWillBeSent', (value): void => {
			const parsed = z.object({ request: z.object({ url: z.string() }) }).safeParse(value);
			if (
				parsed.success &&
				new URL(parsed.data.request.url).pathname ===
					'/api/auth/passkey/generate-authenticate-options'
			)
				challengeCount += 1;
		});
		async function challengeAccepted(action: () => Promise<void>): Promise<void> {
			const response = await page.responseTo(
				'/api/auth/passkey/generate-authenticate-options',
				action,
			);
			if (response.response.status !== 200)
				throw new Error(
					`Passkey challenge refused with ${response.response.status} during ${activeStep}`,
				);
		}
		activeStep = 'native-social-session';
		await page.navigate(target.issuer + '/sign-in');
		const captcha = target.turnstile.issueToken({
			action: 'sign_in_social',
			hostname: new URL(target.issuer).hostname,
			verdict: 'accepted',
		});
		const started = await page.evaluate(
			`fetch('/api/auth/sign-in/social',{method:'POST',headers:{'content-type':'application/json','x-captcha-response':${JSON.stringify(captcha)}},body:JSON.stringify({provider:'google',callbackURL:location.origin+'/owner-ready'})}).then(async response=>({status:response.status,body:await response.json()}))`,
			z.object({ status: z.literal(200), body: z.object({ url: z.url() }) }),
		);
		await page.navigate(
			target.providerCallback('google', new URL(started.body.url), email, true).toString(),
		);
		await page.readyWhen(
			"[...document.querySelectorAll('[data-sign-in-island] button')].some(button=>button.textContent.includes('Set up authenticator app'))",
		);
		activeStep = 'native-app-enrollment';
		const enrollmentResponse = await page.responseTo('/api/auth/two-factor/enable', () =>
			page.click('[data-sign-in-island] button', 'Set up authenticator app'),
		);
		if (enrollmentResponse.response.status !== 200) throw new Error('Native enrollment refused');
		const enrollment = z
			.object({
				method: z.literal('totp'),
				totpURI: z.string(),
				backupCodes: z.array(z.string()).min(1),
			})
			.parse(await page.readBody(enrollmentResponse));
		target.totpAuthenticator.observeEnrollment(email, enrollment);
		await page.readyWhen('document.querySelectorAll(\'[data-slot="input-otp-slot"]\').length===6');
		const confirmed = await page.responseTo('/api/auth/two-factor/verify-totp', async () =>
			page.enter(
				'input[autocomplete="one-time-code"]',
				await target.totpAuthenticator.currentCode(email),
			),
		);
		if (confirmed.response.status !== 200) throw new Error('Native app confirmation refused');
		await page.readyWhen(
			"[...document.querySelectorAll('button')].some(button=>button.textContent.includes(\"I've saved my recovery codes\"))",
		);
		await page.afterNavigation('/owner-ready', () =>
			page.click('[data-sign-in-island] button', "I've saved my recovery codes"),
		);
		await page.readyWhen("!!document.querySelector('#create-organization')");
		await page.enter('input[name="organizationName"]', 'Passkey browser organization');
		const organization = await page.responseTo('/api/auth/organization/create', () =>
			page.afterNavigation('/owner-ready', () =>
				page.click('#create-organization button[type="submit"]'),
			),
		);
		if (organization.response.status !== 200)
			throw new Error('Native organization creation refused');
		await page.readyWhen(
			"!!document.querySelector('#security-heading') && [...document.querySelectorAll('[data-sign-in-island] button')].some(button=>button.textContent.trim()==='Add passkey')",
		);
		activeStep = 'native-passkey-registration';

		// A browser-side rejection (for example an IP RP ID) cannot emit a verify response.
		const registrationError = page.evaluate(
			`new Promise((resolve,reject)=>{const root=[...document.querySelectorAll('[data-sign-in-island]')].find(node=>JSON.parse(node.dataset.islandState).kind==='passkey-management');if(!root)throw new Error('Passkey management root missing');const inspect=()=>{const error=root.querySelector('[role="alert"]');if(error?.textContent?.trim())resolve(error.textContent.trim());};const observer=new MutationObserver(inspect);observer.observe(root,{childList:true,subtree:true,characterData:true});window.cancelPasskeyRegistrationObservation=()=>{observer.disconnect();reject(new Error('Registration observation cancelled'));};inspect();})`,
			z.string(),
		);
		void registrationError.catch(() => undefined);
		const registered = await (async (): Promise<z.infer<typeof nativeNetworkResponseSchema>> => {
			try {
				return await Promise.race([
					page.responseTo('/api/auth/passkey/verify-registration', () =>
						page.click('[data-sign-in-island] button', 'Add passkey'),
					),
					registrationError.then((message): never => {
						throw new Error('Browser rejected registration before native verification: ' + message);
					}),
				]);
			} finally {
				await page.evaluate(
					`(()=>{window.cancelPasskeyRegistrationObservation?.();delete window.cancelPasskeyRegistrationObservation;return true;})()`,
					z.literal(true),
				);
			}
		})();
		if (registered.response.status !== 200)
			throw new Error('Native virtual passkey registration refused');
		await page.readBody(registered);
		await passed(activeStep, {
			origin: target.issuer,
			registrationStatus: 200,
			authenticator: 'Chrome virtual CTAP2 internal resident UV',
		});
		if (kind === 'cli-login')
			await page.evaluate(
				"fetch('/api/auth/owner/bootstrap',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(response=>{if(!response.ok)throw new Error('Owner bootstrap refused');return true;})",
				z.literal(true),
			);
		await protocol.call('Network.clearBrowserCookies', {}, empty);
		scriptShouldFail = kind === 'script-failure';
		activeStep = `passkey-${kind}`;
		async function signInPage(url: string): Promise<void> {
			const before = challengeCount;
			await page.navigate(url);
			await page.evaluate(
				"(()=>{const roots=[...document.querySelectorAll('[data-sign-in-island]')];return roots.some(root=>JSON.parse(root.dataset.islandState).kind==='passkey-sign-in')&&!!document.querySelector('#sign-in-passkey-captcha');})()",
				z.literal(true),
			);
			await page.readyWhen(
				"[...document.querySelectorAll('[data-sign-in-island] button')].some(button=>button.textContent.trim()==='Continue with Passkey')",
			);
			await page.evaluate(
				'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))',
				z.literal(true),
			);
			if (challengeCount !== before)
				throw new Error('Click-only page load sent a passkey challenge');
			const edges = await page.evaluate(
				"[...document.querySelectorAll('#owner-sign-in button')].map(button=>button.getBoundingClientRect().left)",
				z.array(z.number()).min(3),
			);
			if (edges.some((edge) => Math.abs(edge - (edges[0] ?? 0)) > 1))
				throw new Error('Passkey/social buttons are not aligned at400px');
		}
		switch (kind) {
			case 'journey': {
				await signInPage(target.issuer + '/sign-in');
				const verified = await page.responseTo('/api/auth/passkey/verify-authentication', () =>
					page.afterNavigation('/owner-ready', () =>
						challengeAccepted(() =>
							page.click('[data-sign-in-island] button', 'Continue with Passkey'),
						),
					),
				);
				if (verified.response.status !== 200) throw new Error('Native passkey sign-in refused');
				const body = await page.readBody(verified).catch((error: unknown): never => {
					throw new Error('Verify body unavailable after success navigation', { cause: error });
				});
				const cookies = await protocol.call(
					'Network.getCookies',
					{ urls: [target.issuer] },
					z.object({
						cookies: z.array(
							z.object({ name: z.string(), value: z.string(), httpOnly: z.boolean() }),
						),
					}),
				);
				const cookie = cookies.cookies.find((item) => item.name.endsWith('.session_token'));
				if (cookie === undefined || !cookie.httpOnly)
					throw new Error('HttpOnly session cookie missing');
				const signed = decodeURIComponent(cookie.value),
					sessionToken = signed.slice(0, signed.lastIndexOf('.'));
				if (sessionToken.length === 0 || JSON.stringify(body).includes(sessionToken))
					throw new Error('Verify body exposes session token');
				const current = await page.evaluate(
					"fetch('/api/auth/get-session').then(async response=>({session:await response.json(),cookie:document.cookie}))",
					z.object({
						session: z.object({ session: z.object({ activeOrganizationId: z.string() }) }),
						cookie: z.string(),
					}),
				);
				await Promise.all(captureWork);
				if (
					current.cookie.includes(sessionToken) ||
					JSON.stringify(current.session).includes(sessionToken) ||
					responseBodies.some((response) => response.includes(sessionToken))
				)
					throw new Error('Page can read a session token');
				const invited = await page.evaluate(
					`fetch('/api/auth/organization/invite-member',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({organizationId:${JSON.stringify(current.session.session.activeOrganizationId)},email:'browser-passkey@example.invalid',role:'member'})}).then(async response=>({status:response.status,body:await response.json()}))`,
					z.object({ status: z.literal(200), body: z.object({ id: z.string() }) }),
				);
				const stored = await target.database
					.select({ id: invitation.id })
					.from(invitation)
					.where(
						and(
							eq(invitation.id, invited.body.id),
							eq(invitation.email, 'browser-passkey@example.invalid'),
						),
					);
				if (stored.length !== 1) throw new Error('API-via-browser invitation not stored');
				await passed(
					activeStep,
					{
						status: 200,
						tokenAbsentFromBodiesAndScript: true,
						invite: 'API-via-browser/native persisted invitation without confirmation',
						viewport: 400,
						autofillChallengeCount: 0,
					},
					true,
				);
				break;
			}
			case 'no-user-verification': {
				await signInPage(target.issuer + '/sign-in');
				await protocol.call(
					'WebAuthn.setResponseOverrideBits',
					{ authenticatorId: authenticator.authenticatorId, isBadUV: true },
					empty,
				);
				const refusal = await page.responseTo('/api/auth/passkey/verify-authentication', () =>
					challengeAccepted(() =>
						page.click('[data-sign-in-island] button', 'Continue with Passkey'),
					),
				);
				if (refusal.response.status !== 401)
					throw new Error(`No-UV verify status ${refusal.response.status}`);
				z.object({ code: z.literal('USER_VERIFICATION_REQUIRED') }).parse(
					await page.readBody(refusal),
				);
				await page.readyWhen(
					"location.pathname==='/sign-in' && !!document.querySelector('[data-sonner-toast]') && [...document.querySelectorAll('button')].some(button=>button.textContent.trim()==='Continue with Passkey'&&!button.disabled)",
				);
				await page.evaluate(
					"fetch('/api/auth/get-session').then(response=>response.json()).then(session=>{if(session!==null)throw new Error('No-UV session exists');return true;})",
					z.literal(true),
				);
				await protocol.call(
					'WebAuthn.setResponseOverrideBits',
					{ authenticatorId: authenticator.authenticatorId, isBadUV: false },
					empty,
				);
				await passed(
					activeStep,
					{ status: 401, code: 'USER_VERIFICATION_REQUIRED', notice: true, signedOut: true },
					true,
				);
				break;
			}
			case 'cli-login': {
				// Safe native event records distinguish a missing click/submit from a later navigation wait.
				const actualTarget = z.object({
					tag: z.string(),
					id: z.string(),
					classes: z.array(z.string()),
				});
				const cliInput = z.discriminatedUnion('kind', [
					z.object({
						kind: z.literal('click'),
						expectedControl: z.boolean(),
						target: actualTarget,
					}),
					z.object({
						kind: z.literal('submit'),
						expectedForm: z.boolean(),
						defaultPrevented: z.boolean(),
					}),
				]);
				const clickObserved = Promise.withResolvers<void>();
				const submitObserved = Promise.withResolvers<void>();
				const missedClick = Promise.withResolvers<never>();
				void submitObserved.promise.catch(() => undefined);
				void missedClick.promise.catch(() => undefined);
				const stopInputRecords = protocol.on('Runtime.bindingCalled', (value): void => {
					const event = z.object({ name: z.string(), payload: z.string() }).safeParse(value);
					if (!event.success || event.data.name !== 'reportPasskeyCliInput') return;
					const input = cliInput.parse(JSON.parse(event.data.payload));
					switch (input.kind) {
						case 'click':
							if (input.expectedControl) clickObserved.resolve();
							else
								missedClick.reject(
									new Error('Native CLI Continue click hit ' + JSON.stringify(input.target)),
								);
							break;
						case 'submit':
							if (input.expectedForm) submitObserved.resolve();
							else submitObserved.reject(new Error('Native CLI submitted an unexpected form'));
							break;
						default:
							input satisfies never;
					}
					process.stdout.write(
						JSON.stringify({ event: 'native-passkey-cli-input', host, kind, input }) + '\n',
					);
				});
				const stopExceptionRecords = protocol.on('Runtime.exceptionThrown', (value): void => {
					const event = z
						.object({
							exceptionDetails: z.object({ lineNumber: z.number(), columnNumber: z.number() }),
						})
						.parse(value);
					process.stdout.write(
						JSON.stringify({
							event: 'native-passkey-cli-exception',
							host,
							kind,
							phase: activeStep,
							...event.exceptionDetails,
						}) + '\n',
					);
				});
				try {
					await protocol.call('Runtime.addBinding', { name: 'reportPasskeyCliInput' }, empty);
					await protocol.call(
						'WebAuthn.setResponseOverrideBits',
						{ authenticatorId: authenticator.authenticatorId, isBadUV: false },
						empty,
					);
					const token = await loginThroughNativeOwnerCli({
						target: target.target,
						repositoryRoot: root,
						profile: {
							kind: 'clock',
							nowMilliseconds: controlledSignInClock.now(),
							authorization: 'force-auth',
						},
						browser: async (url): Promise<readonly string[]> => {
							await phase('passkey-cli-sign-in-page');
							await signInPage(url);
							await phase('passkey-cli-authentication');
							await page.afterNavigation('/owner-ready', () =>
								challengeAccepted(() =>
									page.click('[data-sign-in-island] button', 'Continue with Passkey'),
								),
							);
							await phase('passkey-cli-query');
							const expectedAuthorization = new URL(url).searchParams.get('authorize');
							if (expectedAuthorization === null || expectedAuthorization.length === 0)
								throw new Error('CLI sign-in source lacks its authorization continuation');
							await page.evaluate(
								`location.pathname==='/owner-ready'&&new URL(location.href).searchParams.get('authorize')===${JSON.stringify(expectedAuthorization)}`,
								z.literal(true),
							);
							await phase('passkey-cli-controls');
							await page.readyWhen("!!document.querySelector('#owner-sign-in button')");
							await page.evaluate(
								`(()=>{const form=document.querySelector('#owner-sign-in');const button=form?.querySelector('button');if(!form||!button)throw new Error('CLI control missing before observation');document.addEventListener('click',event=>window.reportPasskeyCliInput(JSON.stringify({kind:'click',expectedControl:event.target instanceof Element&&event.target.closest('#owner-sign-in button')===button,target:event.target instanceof Element?{tag:event.target.tagName.toLowerCase(),id:event.target.id,classes:[...event.target.classList]}:{tag:'non-element',id:'',classes:[]}})),true);document.addEventListener('submit',event=>window.reportPasskeyCliInput(JSON.stringify({kind:'submit',expectedForm:event.target===form,defaultPrevented:event.defaultPrevented})));return true;})()`,
								z.literal(true),
							);
							await phase('passkey-cli-continue');
							const navigation = page.afterNavigation(undefined, async (): Promise<void> => {
								await phase('passkey-cli-click');
								await page.click('#owner-sign-in button', 'Continue to management CLI');
								await Promise.race([clickObserved.promise, missedClick.promise]);
								await phase('passkey-cli-navigation');
							});
							// A valid submit still needs navigation; a navigation may precede its notification.
							await Promise.race([submitObserved.promise, navigation, missedClick.promise]);
							await Promise.race([navigation, missedClick.promise]);
							await phase('passkey-cli-cache');
							return [];
						},
					});
					if (token.length === 0) throw new Error('Real CLI has no cached token');
					await passed('passkey-cli-login', {
						exitCode: 0,
						privateCacheToken: true,
						continuationPreserved: true,
					});
				} finally {
					stopInputRecords();
					stopExceptionRecords();
					// DOM observers/binding live only in this run's owned Chrome, closed by outer finally.
				}
				break;
			}
			case 'script-failure': {
				await signInPage(target.issuer + '/sign-in');
				await page.readyWhen("window.signInTurnstile==='failed'");
				const before = challengeCount;
				const notice = page.evaluate(
					`new Promise((resolve,reject)=>{const inspect=()=>{const toast=document.querySelector('[data-sonner-toast]');if(toast?.textContent?.trim())resolve(toast.textContent.trim());};const observer=new MutationObserver(inspect);observer.observe(document.body,{childList:true,subtree:true,characterData:true});window.cancelPasskeyNoticeObservation=()=>{observer.disconnect();reject(new Error('Notice observation cancelled'));};inspect();})`,
					z.string(),
				);
				void notice.catch(() => undefined);
				let noticeText: string;
				try {
					await page.click('[data-sign-in-island] button', 'Continue with Passkey');
					noticeText = await notice;
				} finally {
					await page.evaluate(
						`(()=>{window.cancelPasskeyNoticeObservation?.();delete window.cancelPasskeyNoticeObservation;return true;})()`,
						z.literal(true),
					);
				}
				if (
					!noticeText.includes('Sign-in verification is unavailable. Reload the page to try again.')
				)
					throw new Error('Passkey verification notice has wrong message: ' + noticeText);
				await page.readyWhen(
					"[...document.querySelectorAll('button')].some(button=>button.textContent.trim()==='Continue with Passkey'&&!button.disabled)",
				);
				if (challengeCount !== before) throw new Error('Failed script allowed a challenge request');
				await page.evaluate(
					"fetch('/api/auth/get-session').then(response=>response.json()).then(session=>{if(session!==null)throw new Error('Script-failure session exists');return true;})",
					z.literal(true),
				);
				await passed(
					activeStep,
					{ notice: true, buttonEnabled: true, challengeRequests: 0, signedOut: true },
					true,
				);
				break;
			}
			default:
				kind satisfies never;
		}
		if (scriptFailure !== null) throw scriptFailure;
		if (
			(await execute('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim() !== sourceRevision
		)
			throw new Error('Passkey source changed during run');
	} catch (error) {
		let screenshot: NativeBrowserStep['screenshot'];
		try {
			if (browser !== undefined) screenshot = await browser.screenshot('failure-state');
		} catch {
			/* Preserve deciding failure. */
		}
		steps.push({
			name: activeStep,
			status: 'failed',
			facts: { message: error instanceof Error ? error.message : 'Unknown passkey failure' },
			...(screenshot === undefined ? {} : { screenshot }),
		});
		throw error;
	} finally {
		try {
			await chrome?.close();
		} catch (error) {
			cleanupFailure = error instanceof Error ? error.message : 'Chrome cleanup failed';
		}
		try {
			await harness?.close();
		} catch (error) {
			cleanupFailure = error instanceof Error ? error.message : 'Harness cleanup failed';
		}
		for (const [name, value] of Object.entries({
			SIGN_IN_TEST_HOST: previous.host,
			AUTH_PROOF_MANIFEST_FILE: previous.manifest,
			AUTH_PROOF_NODE_MANIFEST_FILE: previous.node,
		})) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		await writeFile(path.join(evidence, 'steps.json'), JSON.stringify(steps, null, 2), {
			mode: 0o600,
		});
		await writeFile(
			path.join(evidence, 'observation.json'),
			JSON.stringify(
				{
					target: { sourceRevision, root, executionHost: hostname(), nodeVersion: process.version },
					host,
					kind,
					layer: 'real Chrome/native Better Auth/selected storage',
					steps,
					statuses,
					cleanupFailure,
					chromePid: chrome?.pid ?? null,
					standIns: [
						'controlled provider',
						'Turnstile script and siteverify',
						'software TOTP authenticator',
						'Chrome virtual WebAuthn authenticator',
						'injected clock',
						'central recording peer',
					],
					notCovered: [
						'physical authenticators',
						'real Turnstile',
						'staging',
						'real provider identity',
						'invite UI',
					],
				},
				null,
				2,
			),
			{ mode: 0o600 },
		);
	}
	if (cleanupFailure !== null) throw new Error(cleanupFailure);
}
