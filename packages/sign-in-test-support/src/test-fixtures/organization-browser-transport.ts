import { z } from 'zod';

import type { NativeBrowserPage } from '#sign-in-test-support/test-fixtures/native-browser-page';
import type {
	ChromeProtocol,
	NetworkTerminalMethod,
} from '#sign-in-test-support/test-fixtures/native-browser-protocol';

const empty = z.object({}).passthrough();
const pausedRequestSchema = z.object({
	requestId: z.string(),
	networkId: z.string().optional(),
	request: z.object({ url: z.url(), postData: z.string().optional() }),
});
const failedPauseSchema = pausedRequestSchema.extend({
	responseErrorReason: z.enum([
		'Failed',
		'Aborted',
		'TimedOut',
		'AccessDenied',
		'ConnectionClosed',
		'ConnectionReset',
		'ConnectionRefused',
		'ConnectionAborted',
		'ConnectionFailed',
		'NameNotResolved',
		'InternetDisconnected',
		'AddressUnreachable',
		'BlockedByClient',
		'BlockedByResponse',
	]),
	responseStatusCode: z.number().optional(),
});
const responsePauseSchema = pausedRequestSchema.extend({
	responseStatusCode: z.number(),
	responseErrorReason: z.never().optional(),
});
const responseStagePauseSchema = z.union([failedPauseSchema, responsePauseSchema]);
// A held successful response still needs the real Network identity for delivery proof.
const pausedSchema = responsePauseSchema.extend({ networkId: z.string() });

/** Holds only completed server responses; no fake reply stands in for the application. */
export class OrganizationBrowserResponses {
	private readonly holds: {
		readonly matches: (url: URL) => boolean;
		readonly reached: ReturnType<typeof Promise.withResolvers<z.infer<typeof pausedSchema>>>;
	}[] = [];
	private readonly navigationObservers = new Set<() => void>();
	private failure: unknown;
	private readonly unsubscribe: () => void;
	constructor(private readonly protocol: ChromeProtocol) {
		this.unsubscribe = protocol.on('Fetch.requestPaused', (value): void => {
			const parsed = responseStagePauseSchema.safeParse(value);
			if (!parsed.success) {
				this.failure = parsed.error;
				throw parsed.error;
			}
			const paused = parsed.data;
			const url = new URL(paused.request.url);
			const index = this.holds.findIndex((hold) => hold.matches(url));
			const hold = index < 0 ? undefined : this.holds.splice(index, 1)[0];
			if (paused.responseErrorReason !== undefined) {
				const http = url.protocol === 'http:' || url.protocol === 'https:';
				process.stdout.write(
					`${JSON.stringify({ event: 'organization-browser-paused-failure', origin: http ? url.origin : 'non-http', pathname: http ? url.pathname : '<omitted>', reason: paused.responseErrorReason, matchedHold: hold !== undefined })}\n`,
				);
				hold?.reached.reject(new Error('Held response failed: ' + paused.responseErrorReason));
				this.continuePausedRequest(paused.requestId);
				return;
			}
			if (hold === undefined) {
				this.continuePausedRequest(paused.requestId);
				return;
			}
			const correlated = pausedSchema.safeParse(paused);
			if (!correlated.success) {
				hold.reached.reject(new Error('Held response is missing its Network request identity'));
				this.continuePausedRequest(paused.requestId);
				return;
			}
			hold.reached.resolve(correlated.data);
		});
	}
	private continuePausedRequest(requestId: string): void {
		void this.protocol
			.call('Fetch.continueRequest', { requestId }, empty)
			.catch((error: unknown): void => {
				this.failure = error;
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
		void reached.promise.catch(() => undefined);
		this.holds.push({ matches, reached });
		return reached.promise;
	}
	async release(response: z.infer<typeof pausedSchema>): Promise<void> {
		const terminal = await this.continueResponse(response);
		if (terminal !== 'Network.loadingFinished')
			throw new Error('Held data response failed before successful delivery');
	}
	/** Native status and navigation are asserted by the caller; body completion is diagnostic only. */
	async releaseForNavigation(response: z.infer<typeof pausedSchema>): Promise<void> {
		const terminal = this.protocol.waitForNetworkTerminal(response.networkId);
		let observing = true;
		const stop = (): void => {
			if (!observing) return;
			observing = false;
			unsubscribeNavigation();
			terminal.cancel();
			this.navigationObservers.delete(stop);
		};
		const unsubscribeNavigation = this.protocol.on('Page.frameNavigated', (value): void => {
			const parsed = z
				.object({ frame: z.object({ parentId: z.string().optional() }) })
				.safeParse(value);
			if (!parsed.success || parsed.data.frame.parentId !== undefined) return;
			process.stdout.write(
				`${JSON.stringify({ event: 'organization-browser-navigation-response', kind: 'none-before-navigation' })}\n`,
			);
			unsubscribeNavigation();
		});
		this.navigationObservers.add(stop);
		void terminal.completed.then(
			(kind): void => {
				if (observing)
					process.stdout.write(
						`${JSON.stringify({ event: 'organization-browser-navigation-response', kind: kind === 'Network.loadingFinished' ? 'finished' : 'failed' })}\n`,
					);
				stop();
			},
			(): void => stop(),
		);
		try {
			await this.protocol.call('Fetch.continueRequest', { requestId: response.requestId }, empty);
		} catch (error) {
			stop();
			throw error;
		}
	}
	private async continueResponse(
		response: z.infer<typeof pausedSchema>,
	): Promise<NetworkTerminalMethod> {
		const terminal = this.protocol.waitForNetworkTerminal(response.networkId);
		void terminal.completed.catch(() => undefined);
		try {
			await this.protocol.call('Fetch.continueRequest', { requestId: response.requestId }, empty);
			const kind = await terminal.completed;
			process.stdout.write(
				`${JSON.stringify({ event: 'organization-browser-response-terminal', kind })}\n`,
			);
			return kind;
		} finally {
			terminal.cancel();
		}
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
		for (const stop of this.navigationObservers) stop();
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
		{
			type: 'keyDown',
			key,
			code: key,
			windowsVirtualKeyCode: key === 'Tab' ? 9 : 13,
			...(key === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {}),
		},
		empty,
	);
	await protocol.call(
		'Input.dispatchKeyEvent',
		{ type: 'keyUp', key, code: key, windowsVirtualKeyCode: key === 'Tab' ? 9 : 13 },
		empty,
	);
}

const organizationEnterTargetSchema = z.strictObject({
	tag: z.string(),
	id: z.string(),
	classes: z.array(z.string()),
	expectedButton: z.boolean(),
	expectedForm: z.boolean(),
});
export const organizationEnterGestureSchema = z.strictObject({
	events: z.array(
		organizationEnterTargetSchema.extend({
			kind: z.enum(['keydown', 'keypress', 'click', 'submit', 'keyup']),
			enterKey: z.boolean(),
		}),
	),
	activeElement: organizationEnterTargetSchema,
});

/** Observe one real Enter gesture. The keyup event completes the observation, even without submit. */
export async function observeOrganizationEnterGesture(props: {
	readonly page: NativeBrowserPage;
	readonly buttonSelector: string;
	readonly formSelector: string;
	readonly pressEnter: () => Promise<void>;
}): Promise<z.infer<typeof organizationEnterGestureSchema>> {
	await props.page.evaluate(
		`(()=>{
const button=document.querySelector(${JSON.stringify(props.buttonSelector)});
const form=document.querySelector(${JSON.stringify(props.formSelector)});
if(!(button instanceof HTMLButtonElement)||!(form instanceof HTMLFormElement))throw new Error('Expected native Enter controls are missing');
const targetOf=(target)=>({tag:target instanceof Element?target.tagName:'',id:target instanceof Element?target.id:'',classes:target instanceof Element?Array.from(target.classList):[],expectedButton:target===button,expectedForm:target===form||(target instanceof Element&&target.closest('form')===form)});
const events=[];let finish;const completed=new Promise(resolve=>{finish=resolve;});
const record=(event)=>{
if(event instanceof KeyboardEvent&&event.key!=='Enter')return;
const target=targetOf(event.target);
if(event instanceof SubmitEvent)target.expectedButton=event.submitter===button;
events.push({...target,kind:event.type,enterKey:event instanceof KeyboardEvent&&event.key==='Enter'});
if(event.type==='keyup'&&event instanceof KeyboardEvent&&event.key==='Enter')finish({events:events.slice(),activeElement:targetOf(document.activeElement)});
};
const kinds=['keydown','keypress','click','submit','keyup'];for(const kind of kinds)document.addEventListener(kind,record,true);
window.organizationEnterGesture={completed,cleanup:()=>{for(const kind of kinds)document.removeEventListener(kind,record,true);}};
return true;
})()`,
		z.literal(true),
	);
	try {
		await props.pressEnter();
		return await props.page.evaluate(
			'window.organizationEnterGesture.completed',
			organizationEnterGestureSchema,
		);
	} finally {
		await props.page.evaluate(
			'(()=>{window.organizationEnterGesture?.cleanup();delete window.organizationEnterGesture;return true;})()',
			z.literal(true),
		);
	}
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
