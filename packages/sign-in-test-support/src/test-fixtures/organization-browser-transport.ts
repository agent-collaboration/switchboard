import { z } from 'zod';

import type { NativeBrowserPage } from '#sign-in-test-support/test-fixtures/native-browser-page';
import type { ChromeProtocol } from '#sign-in-test-support/test-fixtures/native-browser-protocol';

const empty = z.object({}).passthrough();
const pausedSchema = z.object({
	requestId: z.string(),
	networkId: z.string(),
	request: z.object({ url: z.string(), postData: z.string().optional() }),
	responseStatusCode: z.number(),
});

/** Holds only completed server responses; no fake reply stands in for the application. */
export class OrganizationBrowserResponses {
	private readonly holds: {
		readonly matches: (url: URL) => boolean;
		readonly reached: ReturnType<typeof Promise.withResolvers<z.infer<typeof pausedSchema>>>;
	}[] = [];
	private failure: unknown;
	private readonly unsubscribe: () => void;
	constructor(private readonly protocol: ChromeProtocol) {
		this.unsubscribe = protocol.on('Fetch.requestPaused', (value): void => {
			const paused = pausedSchema.parse(value);
			const index = this.holds.findIndex((hold) => hold.matches(new URL(paused.request.url)));
			if (index >= 0) {
				const [hold] = this.holds.splice(index, 1);
				hold?.reached.resolve(paused);
			} else {
				void protocol
					.call('Fetch.continueRequest', { requestId: paused.requestId }, empty)
					.catch((error: unknown): void => {
						this.failure = error;
					});
			}
		});
	}
	async enable(): Promise<void> {
		await this.protocol.call(
			'Fetch.enable',
			{
				patterns: [{ urlPattern: '*/*', requestStage: 'Response' }],
			},
			empty,
		);
	}
	arm(matches: (url: URL) => boolean): Promise<z.infer<typeof pausedSchema>> {
		const reached = Promise.withResolvers<z.infer<typeof pausedSchema>>();
		this.holds.push({ matches, reached });
		return reached.promise;
	}
	async release(response: z.infer<typeof pausedSchema>): Promise<void> {
		const finished = this.protocol.waitFor(
			'Network.loadingFinished',
			(value): boolean =>
				z.object({ requestId: z.string() }).safeParse(value).data?.requestId === response.networkId,
		);
		void finished.catch(() => undefined);
		await this.protocol.call('Fetch.continueRequest', { requestId: response.requestId }, empty);
		await finished;
	}
	async lose(response: z.infer<typeof pausedSchema>): Promise<void> {
		await this.protocol.call(
			'Fetch.failRequest',
			{
				requestId: response.requestId,
				errorReason: 'ConnectionClosed',
			},
			empty,
		);
	}
	async close(): Promise<void> {
		await this.protocol.call('Fetch.disable', {}, empty);
		this.unsubscribe();
		if (this.failure !== undefined) throw this.failure;
	}
}

/** A DOM change is the completion signal; there is no clock or retry interval. */
export async function organizationDomReady(
	page: NativeBrowserPage,
	predicate: string,
): Promise<void> {
	await page.evaluate(
		`new Promise(resolve=>{const inspect=()=>{if(${predicate}){observer.disconnect();resolve(true);}};const observer=new MutationObserver(inspect);observer.observe(document,{subtree:true,childList:true,attributes:true,characterData:true});inspect();})`,
		z.literal(true),
	);
}

export async function organizationBrowserCookie(
	protocol: ChromeProtocol,
	issuer: string,
): Promise<string> {
	const result = await protocol.call(
		'Network.getCookies',
		{ urls: [issuer] },
		z.object({
			cookies: z.array(z.object({ name: z.string(), value: z.string() })),
		}),
	);
	return result.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}

export async function installOrganizationBrowserCookie(props: {
	readonly protocol: ChromeProtocol;
	readonly issuer: string;
	readonly cookie: string;
}): Promise<void> {
	await props.protocol.call('Network.clearBrowserCookies', {}, empty);
	await Promise.all(
		props.cookie.split('; ').map(async (pair: string): Promise<void> => {
			const separator = pair.indexOf('=');
			if (separator <= 0) throw new Error('Native session cookie is malformed');
			// The cookie is produced by Better Auth; Chrome owns it from this point onward.
			await props.protocol.call(
				'Network.setCookie',
				{
					name: pair.slice(0, separator),
					value: pair.slice(separator + 1),
					url: props.issuer,
				},
				z.object({ success: z.literal(true) }),
			);
		}),
	);
}

export async function pressOrganizationBrowserKey(
	protocol: ChromeProtocol,
	key: string,
): Promise<void> {
	await protocol.call(
		'Input.dispatchKeyEvent',
		{ type: 'keyDown', key, code: key, windowsVirtualKeyCode: key === 'Tab' ? 9 : 13 },
		empty,
	);
	await protocol.call(
		'Input.dispatchKeyEvent',
		{ type: 'keyUp', key, code: key, windowsVirtualKeyCode: key === 'Tab' ? 9 : 13 },
		empty,
	);
}

export async function tabToOrganizationControl(props: {
	readonly page: NativeBrowserPage;
	readonly protocol: ChromeProtocol;
	readonly selector: string;
	readonly label?: string;
}): Promise<void> {
	async function advance(remaining: number): Promise<void> {
		if (remaining === 0)
			throw new Error('Labelled organization control is unreachable by keyboard');
		// This is a bounded sequence of real key events, not a temporal wait.
		if (
			await props.page.evaluate(
				`(document.activeElement?.matches(${JSON.stringify(props.selector)})??false) && ${props.label === undefined ? 'true' : `document.activeElement.textContent.trim()===${JSON.stringify(props.label)}`}`,
				z.boolean(),
			)
		)
			return;
		await pressOrganizationBrowserKey(props.protocol, 'Tab');
		return advance(remaining - 1);
	}
	await advance(80);
}
