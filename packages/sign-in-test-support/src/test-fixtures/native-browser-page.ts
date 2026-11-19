import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import {
	executeNativeAwait,
	type NativeAwaitObserver,
} from '#sign-in-test-support/test-fixtures/native-browser-progress';
import type { ChromeProtocol } from '#sign-in-test-support/test-fixtures/native-browser-protocol';

const empty = z.object({}).passthrough();
const evaluated = z.object({
	result: z.object({ value: z.unknown().optional() }),
	exceptionDetails: z.object({ text: z.string() }).optional(),
});
export const nativeNetworkResponseSchema = z.object({
	requestId: z.string(),
	response: z.object({ url: z.string(), status: z.number() }),
});

export interface NativeBrowserScreenshot {
	readonly file: string;
	readonly bytes: number;
	readonly sha256: string;
}
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
type NativePageProtocol = Pick<ChromeProtocol, 'call' | 'waitFor' | 'forgetEvents'>;

/** DOM/event actions and private frame retention, independent of the native auth scenario. */
export class NativeBrowserPage {
	constructor(
		private readonly protocol: NativePageProtocol,
		private readonly evidence: string,
		private readonly observeAwait: NativeAwaitObserver = executeNativeAwait,
	) {}
	async evaluate<TValue>(
		expression: string,
		schema: z.ZodType<TValue>,
		observeAwait: NativeAwaitObserver = this.observeAwait,
	): Promise<TValue> {
		const result = await observeAwait('page evaluate: Runtime.evaluate reply', () =>
			this.protocol.call(
				'Runtime.evaluate',
				{ expression, awaitPromise: true, returnByValue: true },
				evaluated,
			),
		);
		if (result.exceptionDetails !== undefined)
			throw new Error('Browser evaluation failed: ' + result.exceptionDetails.text);
		return schema.parse(result.result.value);
	}
	async readyWhen(predicate: string): Promise<void> {
		await this.observeAwait('page readiness: DOM predicate', () =>
			this.evaluate(
				`new Promise(resolve=>{const inspect=()=>{if(${predicate})resolve(true);else requestAnimationFrame(inspect);};inspect();})`,
				z.literal(true),
			),
		);
		await this.observeAwait('page readiness: fonts and two animation frames', () =>
			this.evaluate(
				'document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true)))))',
				z.literal(true),
			),
		);
	}
	async navigate(url: string): Promise<void> {
		await this.observeAwait('page navigate: action and main-frame navigation', () =>
			this.afterNavigation(undefined, async (): Promise<void> => {
				const result = await this.observeAwait('page navigate: Page.navigate reply', () =>
					this.protocol.call(
						'Page.navigate',
						{ url },
						z.object({ errorText: z.string().optional() }).passthrough(),
					),
				);
				if (result.errorText !== undefined) throw new Error('Native browser navigation failed');
			}),
		);
		await this.observeAwait('page navigate: new-document readiness', () =>
			this.readyWhen(`document.readyState!=='loading' && !!document.querySelector('h1')`),
		);
	}
	/** Arm before the action: DOM readiness belongs to the new document after its navigation. */
	async afterNavigation(pathname: string | undefined, action: () => Promise<void>): Promise<void> {
		this.protocol.forgetEvents(['Page.frameNavigated']);
		const pending = this.protocol.waitFor('Page.frameNavigated', (value): boolean => {
			const parsed = z
				.object({ frame: z.object({ url: z.string(), parentId: z.string().optional() }) })
				.safeParse(value);
			return (
				parsed.success &&
				parsed.data.frame.parentId === undefined &&
				(pathname === undefined || new URL(parsed.data.frame.url).pathname === pathname)
			);
		});
		void pending.catch(() => undefined);
		await this.observeAwait('page navigation: action', () => action());
		await this.observeAwait('page navigation: main-frame event', () => pending);
	}
	async click(selector: string, label?: string): Promise<void> {
		await this.observeAwait('page click: fonts and animation frame', () =>
			this.evaluate(
				'document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>resolve(true))))',
				z.literal(true),
			),
		);
		const measured = await this.observeAwait('page click: control measurement and hit test', () =>
			this.evaluate(
				`(()=>{const element=[...document.querySelectorAll(${JSON.stringify(selector)})].find(node=>${label === undefined ? 'true' : `node.textContent.trim()===${JSON.stringify(label)}`});if(!element||element.disabled)throw new Error('Enabled control missing');element.scrollIntoView({block:'center'});const rect=element.getBoundingClientRect();const x=rect.x+rect.width/2;const y=rect.y+rect.height/2;const hit=document.elementFromPoint(x,y);if(hit?.closest(${JSON.stringify(selector)})!==element)return {kind:'miss',target:hit===null?{tag:'none',id:'',classes:[]}:{tag:hit.tagName.toLowerCase(),id:hit.id,classes:[...hit.classList]}};return {kind:'hit',point:{x,y}};})()`,
				z.discriminatedUnion('kind', [
					z.object({
						kind: z.literal('hit'),
						// DevTools requires these coordinate field names.
						// oxlint-disable-next-line id-length
						point: z.object({ x: z.number(), y: z.number() }),
					}),
					z.object({
						kind: z.literal('miss'),
						target: z.object({ tag: z.string(), id: z.string(), classes: z.array(z.string()) }),
					}),
				]),
			),
		);
		if (measured.kind === 'miss')
			throw new Error(
				'Native click hit ' +
					JSON.stringify(measured.target) +
					' instead of the expected control ' +
					selector,
			);
		const point = measured.point;
		await this.observeAwait('page click: mousePressed reply', () =>
			this.protocol.call(
				'Input.dispatchMouseEvent',
				{ type: 'mousePressed', ...point, button: 'left', clickCount: 1 },
				empty,
			),
		);
		await this.observeAwait('page click: mouseReleased reply', () =>
			this.protocol.call(
				'Input.dispatchMouseEvent',
				{ type: 'mouseReleased', ...point, button: 'left', clickCount: 1 },
				empty,
			),
		);
	}
	/** Keyboard activation follows the focused button even when a sibling changes the layout. */
	async activateButton(selector: string, label: string): Promise<void> {
		await this.evaluate(
			`(()=>{const button=[...document.querySelectorAll(${JSON.stringify(selector)})].find(node=>node.textContent.trim()===${JSON.stringify(label)});if(!(button instanceof HTMLButtonElement)||!button.isConnected||button.disabled)throw new Error('Enabled keyboard control missing');button.focus({preventScroll:true});const rect=button.getBoundingClientRect();return button===document.activeElement&&rect.width>0&&rect.height>0;})()`,
			z.literal(true),
		);
		await this.evaluate(
			`(()=>{const button=document.activeElement;return button instanceof HTMLButtonElement&&button.isConnected&&!button.disabled&&button.matches(${JSON.stringify(selector)})&&button.textContent.trim()===${JSON.stringify(label)};})()`,
			z.literal(true),
		);
		await this.protocol.call(
			'Input.dispatchKeyEvent',
			{
				type: 'rawKeyDown',
				key: ' ',
				code: 'Space',
				windowsVirtualKeyCode: 32,
				nativeVirtualKeyCode: 32,
			},
			empty,
		);
		await this.protocol.call(
			'Input.dispatchKeyEvent',
			{
				type: 'keyUp',
				key: ' ',
				code: 'Space',
				windowsVirtualKeyCode: 32,
				nativeVirtualKeyCode: 32,
			},
			empty,
		);
	}
	async enter(selector: string, value: string): Promise<void> {
		await this.observeAwait('page input: focus by click', () => this.click(selector));
		await this.observeAwait('page input: select text', () =>
			this.evaluate(
				`(()=>{const input=document.querySelector(${JSON.stringify(selector)});if(!(input instanceof HTMLInputElement))throw new Error('Input missing');input.select();return true;})()`,
				z.literal(true),
			),
		);
		await this.observeAwait('page input: insertText reply', () =>
			this.protocol.call('Input.insertText', { text: value }, empty),
		);
	}
	async screenshot(name: string): Promise<NativeBrowserScreenshot> {
		await this.observeAwait('page screenshot: scroll and two animation frames', () =>
			this.evaluate(
				'new Promise(resolve=>{scrollTo(0,0);requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true)));})',
				z.literal(true),
			),
		);
		const metrics = await this.observeAwait('page screenshot: layout metrics reply', () =>
			this.protocol.call(
				'Page.getLayoutMetrics',
				{},
				z.object({ cssContentSize: z.object({ height: z.number() }) }),
			),
		);
		const shot = await this.observeAwait('page screenshot: capture reply', () =>
			this.protocol.call(
				'Page.captureScreenshot',
				{
					format: 'png',
					captureBeyondViewport: true,
					clip: {
						// DevTools names the clip origin x/y.
						// oxlint-disable-next-line id-length
						x: 0,
						// oxlint-disable-next-line id-length
						y: 0,
						width: 390,
						height: Math.max(844, Math.ceil(metrics.cssContentSize.height)),
						scale: 1,
					},
				},
				z.object({ data: z.string() }),
			),
		);
		return this.observeAwait('page screenshot: retain frame', () =>
			this.recordScreenshot(name, Buffer.from(shot.data, 'base64')),
		);
	}
	/** Failure evidence uses only CDP capture; renderer frames and layout are not prerequisites. */
	async captureFailureFrame(): Promise<Uint8Array> {
		const shot = await this.protocol.call(
			'Page.captureScreenshot',
			{ format: 'png' },
			z.object({ data: z.string() }),
		);
		return Buffer.from(shot.data, 'base64');
	}
	async recordScreenshot(name: string, data: Uint8Array): Promise<NativeBrowserScreenshot> {
		const file = name + '.png';
		await writeFile(path.join(this.evidence, file), data, { mode: 0o600, flag: 'wx' });
		return { file, bytes: data.length, sha256: digest(data) };
	}
	async responseTo(
		pathname: string,
		action: () => Promise<void>,
	): Promise<z.infer<typeof nativeNetworkResponseSchema>> {
		const pending = this.protocol.waitFor('Network.responseReceived', (value): boolean => {
			const parsed = nativeNetworkResponseSchema.safeParse(value);
			return parsed.success && new URL(parsed.data.response.url).pathname === pathname;
		});
		void pending.catch(() => undefined);
		await this.observeAwait('page response: action', () => action());
		return nativeNetworkResponseSchema.parse(
			await this.observeAwait('page response: responseReceived event', () => pending),
		);
	}
	async readBody(response: z.infer<typeof nativeNetworkResponseSchema>): Promise<unknown> {
		const finished = this.protocol.waitFor(
			'Network.loadingFinished',
			(value): boolean =>
				z.object({ requestId: z.string() }).safeParse(value).data?.requestId === response.requestId,
		);
		void finished.catch(() => undefined);
		await this.observeAwait('page body: loadingFinished event', () => finished);
		const body = await this.observeAwait('page body: getResponseBody reply', () =>
			this.protocol.call(
				'Network.getResponseBody',
				{ requestId: response.requestId },
				z.object({ body: z.string(), base64Encoded: z.boolean() }),
			),
		);
		return JSON.parse(
			body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body,
		);
	}
}
