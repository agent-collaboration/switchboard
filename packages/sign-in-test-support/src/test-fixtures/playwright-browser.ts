import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { chromium, type BrowserContext, type CDPSession, type Page } from 'playwright';
import { onTestFinished } from 'vitest';
import type { z } from 'zod';

import { withNativeBrowserCleanup } from '#sign-in-test-support/test-fixtures/native-browser-cleanup';
import {
	executeNativeAwait,
	type NativeAwaitObserver,
} from '#sign-in-test-support/test-fixtures/native-browser-progress';
import {
	PlaywrightNetwork,
	waitForBrowserEvent,
	type BrowserNetworkResponse,
} from '#sign-in-test-support/test-fixtures/playwright-network';

interface BrowserScreenshot {
	readonly file: string;
	readonly bytes: number;
	readonly sha256: string;
}

/** Playwright owns Chromium and its context. The scenario supplies the local host's origin. */
export async function runProofBrowserScenario<TValue>(
	perform: (signal: AbortSignal) => Promise<TValue>,
): Promise<TValue> {
	const cancellation = new AbortController();
	const scenario = perform(cancellation.signal);
	const settled = scenario.then(
		() => undefined,
		() => undefined,
	);
	onTestFinished(async (): Promise<void> => {
		cancellation.abort();
		await settled;
	});
	return scenario;
}

export async function launchProofBrowser(props: {
	readonly evidence: string;
	readonly origin?: string;
	readonly width?: number;
	readonly colorScheme?: 'dark';
	readonly observeAwait?: NativeAwaitObserver;
	readonly scenarioSignal?: AbortSignal;
}): Promise<PlaywrightBrowserPage> {
	props.scenarioSignal?.throwIfAborted();
	const browser = await chromium.launch({ timeout: 0 });
	try {
		const context = await browser.newContext({
			viewport: { width: props.width ?? 400, height: 844 },
			isMobile: true,
			deviceScaleFactor: 1,
			colorScheme: props.colorScheme ?? 'light',
		});
		context.setDefaultTimeout(0);
		context.setDefaultNavigationTimeout(0);
		const page = await context.newPage();
		const protocol = await context.newCDPSession(page);
		const proofPage = new PlaywrightBrowserPage({
			page,
			context,
			protocol,
			origin: props.origin,
			evidence: props.evidence,
			observeAwait: props.observeAwait ?? executeNativeAwait,
			closeBrowser: () => browser.close(),
			browserConnected: () => browser.isConnected(),
			scenarioSignal: props.scenarioSignal,
		});
		if (props.scenarioSignal === undefined)
			onTestFinished(() => proofPage.close('Browser scenario finished'));
		await proofPage.network.enable();
		proofPage.signal.throwIfAborted();
		process.stdout.write(
			`${JSON.stringify({ event: 'proof-browser-version', chromium: browser.version() })}\n`,
		);
		return proofPage;
	} catch (error) {
		return withNativeBrowserCleanup(
			() => Promise.reject(error),
			() => browser.close(),
		);
	}
}

interface BrowserPageOptions {
	readonly page: Page;
	readonly context: BrowserContext;
	readonly protocol: CDPSession;
	readonly origin: string | undefined;
	readonly evidence: string;
	readonly observeAwait: NativeAwaitObserver;
	readonly closeBrowser: () => Promise<void>;
	readonly browserConnected: () => boolean;
	readonly scenarioSignal: AbortSignal | undefined;
}

/** Shared page interactions and evidence. The only special transport is Playwright's page CDP session. */
export class PlaywrightBrowserPage {
	readonly network: PlaywrightNetwork;
	private readonly cancellation = new AbortController();
	private closing?: Promise<void>;
	private cancelling?: Promise<void>;

	constructor(private readonly options: BrowserPageOptions) {
		this.page.once('close', (): void => {
			this.cancellation.abort(new Error('Proof page closed'));
		});
		if (options.scenarioSignal?.aborted === true) this.cancelScenario();
		else options.scenarioSignal?.addEventListener('abort', this.cancelScenario, { once: true });
		this.network = new PlaywrightNetwork(
			options.protocol,
			this.cancellation.signal,
			options.origin,
		);
	}

	get page(): Page {
		return this.options.page;
	}

	get context(): BrowserContext {
		return this.options.context;
	}

	get protocol(): CDPSession {
		return this.options.protocol;
	}

	get signal(): AbortSignal {
		return this.cancellation.signal;
	}

	isBrowserConnected(): boolean {
		return this.options.browserConnected();
	}

	private readonly cancelScenario = (): void => {
		void this.cancel('Vitest ended the browser scenario').catch(() => undefined);
	};

	cancel(reason: string): Promise<void> {
		this.cancellation.abort(new Error(reason));
		this.cancelling ??= this.page.close({ reason });
		return this.cancelling;
	}

	close(reason = 'Proof browser closing'): Promise<void> {
		this.options.scenarioSignal?.removeEventListener('abort', this.cancelScenario);
		this.closing ??= withNativeBrowserCleanup(
			async (): Promise<void> => {
				await this.cancel(reason);
			},
			() =>
				withNativeBrowserCleanup(() => this.context.close({ reason }), this.options.closeBrowser),
		);
		return this.closing;
	}

	async addVirtualAuthenticator(): Promise<string> {
		await this.protocol.send('WebAuthn.enable');
		const { authenticatorId } = await this.protocol.send('WebAuthn.addVirtualAuthenticator', {
			options: {
				protocol: 'ctap2',
				transport: 'internal',
				hasResidentKey: true,
				hasUserVerification: true,
				isUserVerified: true,
				automaticPresenceSimulation: true,
			},
		});
		return authenticatorId;
	}

	async evaluate<TValue>(
		expression: string,
		schema: z.ZodType<TValue>,
		observeAwait = this.options.observeAwait,
	): Promise<TValue> {
		return schema.parse(
			await observeAwait('Playwright page evaluation', () => this.page.evaluate(expression)),
		);
	}

	async readyWhen(predicate: string): Promise<void> {
		await this.options.observeAwait('Playwright DOM readiness', async (): Promise<void> => {
			await this.page.evaluate(`new Promise(resolve=>{
const listeners=['load','error','DOMContentLoaded'];
const observer=new MutationObserver(inspect);
function inspect(){if(!(${predicate}))return;observer.disconnect();for(const name of listeners)document.removeEventListener(name,inspect,true);resolve();}
observer.observe(document,{subtree:true,childList:true,attributes:true,characterData:true});
for(const name of listeners)document.addEventListener(name,inspect,true);
inspect();
})`);
			await this.page.evaluate(() => document.fonts.ready.then(() => undefined));
			await this.page.evaluate(
				() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
			);
		});
	}

	async navigate(url: string): Promise<void> {
		await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 0 });
	}

	async afterNavigation(pathname: string | undefined, action: () => Promise<void>): Promise<void> {
		const navigation = waitForBrowserEvent({
			signal: this.signal,
			subscribe: (receive) => {
				this.page.on('framenavigated', receive);
				return () => {
					this.page.off('framenavigated', receive);
				};
			},
			matches: (frame: ReturnType<Page['mainFrame']>) =>
				frame === this.page.mainFrame() &&
				(pathname === undefined || new URL(frame.url()).pathname === pathname),
		});
		try {
			await action();
			await navigation.completed;
			await this.page.waitForLoadState('domcontentloaded', { timeout: 0 });
		} finally {
			navigation.cancel();
		}
	}

	async click(selector: string, label?: string): Promise<void> {
		const point = await this.page.evaluate(
			({ selector: targetSelector, label: targetLabel }) => {
				const control = [...document.querySelectorAll<HTMLElement>(targetSelector)].find(
					(element) => targetLabel === undefined || element.textContent?.trim() === targetLabel,
				);
				if (control === undefined || control.matches(':disabled'))
					throw new Error('Enabled proof control missing');
				control.scrollIntoView({ block: 'center' });
				const bounds = control.getBoundingClientRect();
				const clickX = bounds.left + bounds.width / 2;
				const clickY = bounds.top + bounds.height / 2;
				if (!control.contains(document.elementFromPoint(clickX, clickY)))
					throw new Error(`Proof control does not receive pointer input: ${targetSelector}`);
				return { clickX, clickY };
			},
			{ selector, label },
		);
		await this.page.mouse.click(point.clickX, point.clickY);
	}

	async focusButton(selector: string, label: string): Promise<void> {
		await this.page.evaluate(
			({ selector: targetSelector, label: targetLabel }) => {
				const button = [...document.querySelectorAll<HTMLButtonElement>(targetSelector)].find(
					(element) => element.textContent?.trim() === targetLabel,
				);
				if (button === undefined || button.disabled || !button.checkVisibility())
					throw new Error('Enabled proof button missing');
				button.focus({ preventScroll: true });
				if (button !== document.activeElement)
					throw new Error('Proof button did not receive focus');
			},
			{ selector, label },
		);
	}

	async activateButton(selector: string, label: string): Promise<void> {
		await this.focusButton(selector, label);
		await this.page.keyboard.press('Space');
	}

	async enter(selector: string, value: string): Promise<void> {
		await this.click(selector);
		await this.page.evaluate((target) => {
			const input = document.querySelector(target);
			if (!(input instanceof HTMLInputElement)) throw new Error('Proof input missing');
			input.select();
		}, selector);
		await this.page.keyboard.insertText(value);
	}

	async screenshot(name: string): Promise<BrowserScreenshot> {
		await this.page.evaluate(() => {
			scrollTo(0, 0);
		});
		return this.recordScreenshot(name, await this.page.screenshot({ fullPage: true, timeout: 0 }));
	}

	captureFailureFrame(): Promise<Uint8Array> {
		return this.page.screenshot({ timeout: 0 });
	}

	async recordScreenshot(name: string, data: Uint8Array): Promise<BrowserScreenshot> {
		const file = `${name}.png`;
		await writeFile(path.join(this.options.evidence, file), data, { mode: 0o600, flag: 'wx' });
		return { file, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
	}

	async responseTo(pathname: string, action: () => Promise<void>): Promise<BrowserNetworkResponse> {
		const pending = this.network.armResponse(
			(response) => new URL(response.response.url).pathname === pathname,
		);
		try {
			await action();
			return await pending.completed;
		} finally {
			pending.cancel();
		}
	}

	readBody(response: BrowserNetworkResponse): Promise<unknown> {
		return this.network.readBody(response.requestId).then((body): unknown => JSON.parse(body));
	}
}
