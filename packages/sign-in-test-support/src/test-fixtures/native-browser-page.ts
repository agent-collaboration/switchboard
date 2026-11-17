import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

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

/** DOM/event actions and private frame retention, independent of the native auth scenario. */
export class NativeBrowserPage {
	constructor(
		private readonly protocol: ChromeProtocol,
		private readonly evidence: string,
	) {}
	async evaluate<TValue>(expression: string, schema: z.ZodType<TValue>): Promise<TValue> {
		const result = await this.protocol.call(
			'Runtime.evaluate',
			{ expression, awaitPromise: true, returnByValue: true },
			evaluated,
		);
		if (result.exceptionDetails !== undefined)
			throw new Error('Browser evaluation failed: ' + result.exceptionDetails.text);
		return schema.parse(result.result.value);
	}
	async readyWhen(predicate: string): Promise<void> {
		await this.evaluate(
			`new Promise(resolve=>{const inspect=()=>{if(${predicate})resolve(true);else requestAnimationFrame(inspect);};inspect();})`,
			z.literal(true),
		);
		await this.evaluate(
			'document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true)))))',
			z.literal(true),
		);
	}
	async navigate(url: string): Promise<void> {
		await this.afterNavigation(undefined, async (): Promise<void> => {
			const result = await this.protocol.call(
				'Page.navigate',
				{ url },
				z.object({ errorText: z.string().optional() }).passthrough(),
			);
			if (result.errorText !== undefined) throw new Error('Native browser navigation failed');
		});
		await this.readyWhen(`document.readyState!=='loading' && !!document.querySelector('h1')`);
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
		await action();
		await pending;
	}
	async click(selector: string, label?: string): Promise<void> {
		const point = await this.evaluate(
			`(()=>{const element=[...document.querySelectorAll(${JSON.stringify(selector)})].find(node=>${label === undefined ? 'true' : `node.textContent.trim()===${JSON.stringify(label)}`});if(!element||element.disabled)throw new Error('Enabled control missing');element.scrollIntoView({block:'center'});const rect=element.getBoundingClientRect();return {x:rect.x+rect.width/2,y:rect.y+rect.height/2};})()`,
			// The DevTools coordinate fields are named x/y.
			// oxlint-disable-next-line id-length
			z.object({ x: z.number(), y: z.number() }),
		);
		await this.protocol.call(
			'Input.dispatchMouseEvent',
			{ type: 'mousePressed', ...point, button: 'left', clickCount: 1 },
			empty,
		);
		await this.protocol.call(
			'Input.dispatchMouseEvent',
			{ type: 'mouseReleased', ...point, button: 'left', clickCount: 1 },
			empty,
		);
	}
	async enter(selector: string, value: string): Promise<void> {
		await this.click(selector);
		await this.evaluate(
			`(()=>{const input=document.querySelector(${JSON.stringify(selector)});if(!(input instanceof HTMLInputElement))throw new Error('Input missing');input.select();return true;})()`,
			z.literal(true),
		);
		await this.protocol.call('Input.insertText', { text: value }, empty);
	}
	async screenshot(name: string): Promise<NativeBrowserScreenshot> {
		await this.evaluate(
			'new Promise(resolve=>{scrollTo(0,0);requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true)));})',
			z.literal(true),
		);
		const metrics = await this.protocol.call(
			'Page.getLayoutMetrics',
			{},
			z.object({ cssContentSize: z.object({ height: z.number() }) }),
		);
		const shot = await this.protocol.call(
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
		);
		const data = Buffer.from(shot.data, 'base64');
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
		await action();
		return nativeNetworkResponseSchema.parse(await pending);
	}
	async readBody(response: z.infer<typeof nativeNetworkResponseSchema>): Promise<unknown> {
		await this.protocol.waitFor(
			'Network.loadingFinished',
			(value): boolean =>
				z.object({ requestId: z.string() }).safeParse(value).data?.requestId === response.requestId,
		);
		const body = await this.protocol.call(
			'Network.getResponseBody',
			{ requestId: response.requestId },
			z.object({ body: z.string(), base64Encoded: z.boolean() }),
		);
		return JSON.parse(
			body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body,
		);
	}
}
