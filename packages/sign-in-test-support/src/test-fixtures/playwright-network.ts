import type { CDPSession } from 'playwright';
import { z } from 'zod';

export const nativeNetworkResponseSchema = z.object({
	requestId: z.string(),
	response: z.object({ url: z.string(), status: z.number() }),
});
export type BrowserNetworkResponse = z.infer<typeof nativeNetworkResponseSchema>;

interface BrowserEventWait<TEvent> {
	readonly completed: Promise<TEvent>;
	readonly cancel: () => void;
}

export function waitForBrowserEvent<TEvent>(props: {
	readonly signal: AbortSignal;
	readonly subscribe: (receive: (event: TEvent) => void) => () => void;
	readonly matches: (event: TEvent) => boolean;
}): BrowserEventWait<TEvent> {
	const pending = Promise.withResolvers<TEvent>();
	void pending.promise.catch(() => undefined);
	const unsubscribe = props.subscribe((event): void => {
		if (!props.matches(event)) return;
		stop();
		pending.resolve(event);
	});
	function stop(): void {
		unsubscribe();
		props.signal.removeEventListener('abort', abort);
	}
	function abort(): void {
		stop();
		pending.reject(props.signal.reason);
	}
	if (props.signal.aborted) abort();
	else props.signal.addEventListener('abort', abort, { once: true });
	return {
		completed: pending.promise,
		cancel: (): void => {
			stop();
			pending.reject(new Error('Browser event observation ended'));
		},
	};
}

type NetworkTerminal = 'Network.loadingFinished' | 'Network.loadingFailed';

/** Durable body readback survives navigation within the browser library's CDP session. */
export class PlaywrightNetwork {
	private readonly terminalEvents = new Map<string, NetworkTerminal>();

	constructor(
		private readonly protocol: CDPSession,
		private readonly signal: AbortSignal,
		private readonly origin: string | undefined,
	) {
		protocol.on('Network.loadingFinished', ({ requestId }): void => {
			this.terminalEvents.set(requestId, 'Network.loadingFinished');
		});
		protocol.on('Network.loadingFailed', ({ requestId }): void => {
			this.terminalEvents.set(requestId, 'Network.loadingFailed');
		});
	}

	async enable(): Promise<void> {
		await this.protocol.send('Network.enable', {
			enableDurableMessages: true,
			maxTotalBufferSize: 16_777_216,
			maxResourceBufferSize: 8_388_608,
		});
	}

	armResponse(
		matches: (response: BrowserNetworkResponse) => boolean,
	): BrowserEventWait<BrowserNetworkResponse> {
		return waitForBrowserEvent({
			signal: this.signal,
			subscribe: (receive) => {
				this.protocol.on('Network.responseReceived', receive);
				return () => {
					this.protocol.off('Network.responseReceived', receive);
				};
			},
			matches: (response) =>
				(this.origin === undefined || new URL(response.response.url).origin === this.origin) &&
				matches(response),
		});
	}

	waitForNetworkTerminal(requestId: string): BrowserEventWait<NetworkTerminal> {
		const existing = this.terminalEvents.get(requestId);
		if (existing !== undefined)
			return { completed: Promise.resolve(existing), cancel: (): void => {} };
		return waitForBrowserEvent({
			signal: this.signal,
			subscribe: (receive) => {
				const finished = (event: { readonly requestId: string }): void => {
					if (event.requestId === requestId) receive('Network.loadingFinished');
				};
				const failed = (event: { readonly requestId: string }): void => {
					if (event.requestId === requestId) receive('Network.loadingFailed');
				};
				this.protocol.on('Network.loadingFinished', finished);
				this.protocol.on('Network.loadingFailed', failed);
				return () => {
					this.protocol.off('Network.loadingFinished', finished);
					this.protocol.off('Network.loadingFailed', failed);
				};
			},
			matches: () => true,
		});
	}

	async readBody(requestId: string): Promise<string> {
		const terminal = await this.waitForNetworkTerminal(requestId).completed;
		if (terminal !== 'Network.loadingFinished') throw new Error('Browser response did not finish');
		const body = await this.protocol.send('Network.getResponseBody', { requestId });
		return body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body;
	}
}
