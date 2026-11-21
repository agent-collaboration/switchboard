import { z } from 'zod';

import { withNativeBrowserCleanup } from '#sign-in-test-support/test-fixtures/native-browser-cleanup';
import type { PlaywrightBrowserPage } from '#sign-in-test-support/test-fixtures/playwright-browser';

interface HeldOrganizationResponse {
	readonly requestId: string;
	readonly networkId: string;
	readonly responseStatusCode: number;
	readonly request: { readonly url: string; readonly postData?: string };
}

// Use the generated Playwright event type at the CDP boundary.
type PausedResponse = {
	readonly requestId: string;
	readonly networkId?: string;
	readonly responseStatusCode?: number;
	readonly responseErrorReason?: string;
	readonly request: HeldOrganizationResponse['request'];
};

/** Pauses live endpoint replies after the server has executed them. */
export class OrganizationBrowserResponses {
	private readonly pending: {
		readonly matches: (url: URL) => boolean;
		readonly reached: ReturnType<typeof Promise.withResolvers<HeldOrganizationResponse>>;
	}[] = [];
	private readonly continuationWork: Promise<void>[] = [];

	constructor(private readonly page: PlaywrightBrowserPage) {}

	private readonly onPaused = (reply: PausedResponse): void => {
		const index = this.pending.findIndex((hold) => hold.matches(new URL(reply.request.url)));
		const hold = index < 0 ? undefined : this.pending.splice(index, 1)[0];
		if (
			hold !== undefined &&
			reply.responseStatusCode !== undefined &&
			reply.networkId !== undefined &&
			reply.responseErrorReason === undefined
		) {
			hold.reached.resolve({
				requestId: reply.requestId,
				networkId: reply.networkId,
				responseStatusCode: reply.responseStatusCode,
				request: reply.request,
			});
			return;
		}
		hold?.reached.reject(new Error('Held response failed or lacks a Network request identity'));
		const work = this.page.protocol
			.send('Fetch.continueRequest', { requestId: reply.requestId })
			.then((): void => {});
		void work.catch(() => undefined);
		this.continuationWork.push(work);
	};

	async enable(origin: string): Promise<void> {
		this.page.protocol.on('Fetch.requestPaused', this.onPaused);
		this.page.signal.addEventListener('abort', this.cancelPending, { once: true });
		await this.page.protocol.send('Fetch.enable', {
			patterns: [
				'/api/auth/organization/set-active',
				'/api/auth/organization/person-membership',
				'/api/auth/organization/people',
			].map((pathname) => ({
				urlPattern: `${origin}${pathname}*`,
				requestStage: 'Response' as const,
			})),
		});
	}

	private readonly cancelPending = (): void => {
		for (const hold of this.pending.splice(0))
			hold.reached.reject(
				this.page.signal.reason ?? new Error('Organization response observation ended'),
			);
	};

	arm(matches: (url: URL) => boolean): Promise<HeldOrganizationResponse> {
		this.page.signal.throwIfAborted();
		const reached = Promise.withResolvers<HeldOrganizationResponse>();
		void reached.promise.catch(() => undefined);
		this.pending.push({ matches, reached });
		return reached.promise;
	}

	async release(response: HeldOrganizationResponse): Promise<void> {
		const terminal = this.page.network.waitForNetworkTerminal(response.networkId);
		try {
			await this.releaseForNavigation(response);
			const kind = await terminal.completed;
			process.stdout.write(
				`${JSON.stringify({ event: 'organization-browser-response-terminal', kind })}\n`,
			);
			if (kind !== 'Network.loadingFinished')
				throw new Error('Held data response failed before successful delivery');
		} finally {
			terminal.cancel();
		}
	}

	/** A navigation can discard the outgoing document before the reply body completes. */
	async releaseForNavigation(response: HeldOrganizationResponse): Promise<void> {
		await this.page.protocol.send('Fetch.continueRequest', { requestId: response.requestId });
	}

	async lose(response: HeldOrganizationResponse): Promise<void> {
		await this.page.protocol.send('Fetch.failRequest', {
			requestId: response.requestId,
			errorReason: 'ConnectionClosed',
		});
	}

	async close(): Promise<void> {
		this.page.signal.removeEventListener('abort', this.cancelPending);
		this.cancelPending();
		this.page.protocol.off('Fetch.requestPaused', this.onPaused);
		if (!this.page.page.isClosed()) await this.page.protocol.send('Fetch.disable');
		if (!this.page.signal.aborted) await Promise.all(this.continuationWork);
	}
}

export function organizationDomReady(
	page: PlaywrightBrowserPage,
	predicate: string,
): Promise<void> {
	return page.readyWhen(predicate);
}

export async function organizationBrowserCookie(
	page: PlaywrightBrowserPage,
	issuer: string,
): Promise<string> {
	return (await page.context.cookies(issuer))
		.map(({ name, value }) => `${name}=${value}`)
		.join('; ');
}

export async function installOrganizationBrowserCookie(props: {
	readonly page: PlaywrightBrowserPage;
	readonly issuer: string;
	readonly cookie: string;
}): Promise<void> {
	await props.page.context.clearCookies();
	await props.page.context.addCookies(
		props.cookie.split('; ').map((pair) => {
			const separator = pair.indexOf('=');
			if (separator <= 0) throw new Error('Native session cookie is malformed');
			return {
				name: pair.slice(0, separator),
				value: pair.slice(separator + 1),
				url: props.issuer,
			};
		}),
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
			trusted: z.boolean(),
		}),
	),
	activeElement: organizationEnterTargetSchema,
});

/** Observe one real Enter gesture. The keyup event completes the observation, even without submit. */
export async function observeOrganizationEnterGesture(props: {
	readonly page: PlaywrightBrowserPage;
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
events.push({...target,kind:event.type,trusted:event.isTrusted,enterKey:event instanceof KeyboardEvent&&event.key==='Enter'});
if(event.type==='keyup'&&event instanceof KeyboardEvent&&event.key==='Enter')finish({events:events.slice(),activeElement:targetOf(document.activeElement)});
};
const kinds=['keydown','keypress','click','submit','keyup'];for(const kind of kinds)document.addEventListener(kind,record,true);
window.organizationEnterGesture={completed,cleanup:()=>{for(const kind of kinds)document.removeEventListener(kind,record,true);}};
return true;
})()`,
		z.literal(true),
	);
	return withNativeBrowserCleanup(
		async () => {
			await props.pressEnter();
			return props.page.evaluate(
				'window.organizationEnterGesture.completed',
				organizationEnterGestureSchema,
			);
		},
		async (): Promise<void> => {
			if (props.page.page.isClosed()) return;
			await props.page.evaluate(
				'(()=>{window.organizationEnterGesture?.cleanup();delete window.organizationEnterGesture;return true;})()',
				z.literal(true),
			);
		},
	);
}

export async function tabToOrganizationControl(props: {
	readonly page: PlaywrightBrowserPage;
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
		await props.page.page.keyboard.press('Tab');
		return advance(remaining - 1);
	}
	await advance(80);
}
