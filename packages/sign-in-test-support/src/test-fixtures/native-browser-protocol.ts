import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import {
	withNativeBrowserCleanup,
	type NativeBrowserFailure,
} from '#sign-in-test-support/test-fixtures/native-browser-cleanup';
import { nativeBrowserGroups } from '#sign-in-test-support/test-fixtures/native-browser-groups';
import {
	executeNativeAwait,
	observeNativeAcquisition,
	type NativeAwaitObserver,
} from '#sign-in-test-support/test-fixtures/native-browser-progress';
import type { GroupSignalAttempt } from '#sign-in-test-support/test-fixtures/owned-process-group';

const wireSchema = z.object({
	id: z.number().optional(),
	method: z.string().optional(),
	params: z.unknown().optional(),
	result: z.unknown().optional(),
	error: z.object({ code: z.number(), message: z.string() }).optional(),
});
const emptyResult = z.object({}).passthrough();
const targetsSchema = z.object({
	targetInfos: z.array(z.object({ targetId: z.string(), type: z.string() })),
});
const targetEventSchema = z.object({
	targetInfo: z.object({ targetId: z.string(), type: z.string() }),
});
const pageTargetsSchema = z.array(
	z.object({ id: z.string(), webSocketDebuggerUrl: z.string().optional() }),
);

interface RetainedProtocolEvent {
	readonly sequence: number;
	readonly parameters: unknown;
}
const networkTerminalMethods = ['Network.loadingFinished', 'Network.loadingFailed'] as const;
export type NetworkTerminalMethod = (typeof networkTerminalMethods)[number];
const networkRequestIdentitySchema = z.object({ requestId: z.string() });

interface PendingCall {
	readonly method: string;
	readonly resolve: (value: unknown) => void;
	readonly reject: (reason: Error) => void;
}

type ProtocolDispatch =
	| { readonly kind: 'unavailable'; readonly error: Error }
	| { readonly kind: 'sent'; readonly answer: Promise<unknown> };

/**
 * One owned DevTools connection. Every wait ends on a protocol event: a reply, an event, or the
 * socket closing or failing (R33: no real-time bound in tests). A Chrome that hangs without any
 * of these is ended by the test runner's own limit, which is configuration, not test code.
 */
export class ChromeProtocol {
	private nextId = 0;
	private readonly pending = new Map<number, PendingCall>();
	/** Event waiters reject with pending calls when the connection ends. */
	private readonly waiters = new Set<(reason: Error) => void>();
	private readonly listeners = new Map<string, Set<(parameters: unknown) => void>>();
	private readonly history = new Map<string, RetainedProtocolEvent[]>();
	private nextEventSequence = 0;
	/** Set once the socket closed or failed: later calls and waits reject at once. */
	private ended: { readonly kind: 'closed' | 'failed'; readonly error: Error } | null = null;

	private constructor(private readonly socket: WebSocket) {
		socket.addEventListener('message', (event): void => {
			try {
				if (typeof event.data !== 'string') throw new Error('Non-text DevTools reply');
				const message = wireSchema.parse(JSON.parse(event.data));
				if (message.id !== undefined) {
					const pending = this.pending.get(message.id);
					if (pending === undefined) return;
					this.pending.delete(message.id);
					if (message.error !== undefined)
						pending.reject(new Error(pending.method + ': ' + message.error.message));
					else pending.resolve(message.result);
				} else if (message.method !== undefined) {
					if (
						[
							'Page.lifecycleEvent',
							'Page.frameNavigated',
							'Target.targetCreated',
							'Network.loadingFinished',
							'Network.loadingFailed',
						].includes(message.method)
					) {
						const history = this.history.get(message.method) ?? [];
						history.push({ sequence: ++this.nextEventSequence, parameters: message.params });
						if (history.length > 100) history.shift();
						this.history.set(message.method, history);
					}
					for (const listener of this.listeners.get(message.method) ?? []) listener(message.params);
				}
			} catch (error) {
				this.rejectPending(error instanceof Error ? error : new Error('Invalid DevTools reply'));
			}
		});
		socket.addEventListener('close', (): void => this.end('closed'));
		socket.addEventListener('error', (): void => this.end('failed'));
	}

	static async connect(url: string): Promise<ChromeProtocol> {
		const socket = new WebSocket(url);
		await new Promise<void>((resolve, reject): void => {
			socket.addEventListener('open', (): void => resolve(), { once: true });
			socket.addEventListener(
				'error',
				(): void => reject(new Error('DevTools connection failed')),
				{ once: true },
			);
			socket.addEventListener(
				'close',
				(): void => reject(new Error('DevTools connection closed before it opened')),
				{ once: true },
			);
		});
		return new ChromeProtocol(socket);
	}

	private dispatch(
		method: string,
		parameters: Readonly<Record<string, unknown>>,
	): ProtocolDispatch {
		if (this.ended !== null) return { kind: 'unavailable', error: this.ended.error };
		if (this.socket.readyState !== WebSocket.OPEN)
			return { kind: 'unavailable', error: new Error('DevTools connection is not open') };
		const id = ++this.nextId;
		const answer = Promise.withResolvers<unknown>();
		this.pending.set(id, { method, resolve: answer.resolve, reject: answer.reject });
		try {
			this.socket.send(JSON.stringify({ id, method, params: parameters }));
		} catch (error) {
			this.pending.delete(id);
			void answer.promise.catch((): void => {});
			return {
				kind: 'unavailable',
				error: error instanceof Error ? error : new Error('DevTools send failed'),
			};
		}
		return { kind: 'sent', answer: answer.promise };
	}

	async call<TValue>(
		method: string,
		parameters: Readonly<Record<string, unknown>>,
		schema: z.ZodType<TValue>,
	): Promise<TValue> {
		const request = this.dispatch(method, parameters);
		if (request.kind === 'unavailable') throw request.error;
		return schema.parse(await request.answer);
	}

	/** EOF is expected only after an actual close dispatch; a refusal or unusable wire needs fallback. */
	async requestBrowserClose(): Promise<'requested' | 'unavailable'> {
		const request = this.dispatch('Browser.close', {});
		if (request.kind === 'unavailable') return 'unavailable';
		try {
			emptyResult.parse(await request.answer);
			return 'requested';
		} catch (error) {
			return this.ended?.kind === 'closed' && error === this.ended.error
				? 'requested'
				: 'unavailable';
		}
	}

	on(method: string, listener: (parameters: unknown) => void): () => void {
		const listeners = this.listeners.get(method) ?? new Set<(parameters: unknown) => void>();
		listeners.add(listener);
		this.listeners.set(method, listeners);
		return (): void => {
			listeners.delete(listener);
		};
	}

	async waitFor(method: string, predicate: (parameters: unknown) => boolean): Promise<unknown> {
		const recorded = this.history.get(method)?.find((event) => predicate(event.parameters));
		if (recorded !== undefined) return recorded.parameters;
		if (this.ended !== null) throw this.ended.error;
		return new Promise<unknown>((resolve, reject): void => {
			const unsubscribe = this.on(method, (parameters): void => {
				if (!predicate(parameters)) return;
				unsubscribe();
				this.waiters.delete(rejectWaiter);
				resolve(parameters);
			});
			const rejectWaiter = (reason: Error): void => {
				unsubscribe();
				reject(new Error(`${method}: ${reason.message}`));
			};
			this.waiters.add(rejectWaiter);
		});
	}

	/** The first matching terminal owns completion; cancellation or socket close removes both listeners. */
	waitForNetworkTerminal(requestId: string): {
		readonly completed: Promise<NetworkTerminalMethod>;
		readonly cancel: () => void;
	} {
		const matches = (parameters: unknown): boolean =>
			networkRequestIdentitySchema.safeParse(parameters).data?.requestId === requestId;
		const recorded = networkTerminalMethods
			.flatMap((method) =>
				(this.history.get(method) ?? [])
					.filter((event) => matches(event.parameters))
					.map((event) => ({ method, sequence: event.sequence })),
			)
			.toSorted((left, right) => left.sequence - right.sequence)[0];
		if (recorded !== undefined)
			return { completed: Promise.resolve(recorded.method), cancel: (): void => {} };
		if (this.ended !== null)
			return { completed: Promise.reject(this.ended.error), cancel: (): void => {} };
		const result = Promise.withResolvers<NetworkTerminalMethod>();
		const unsubscribe: (() => void)[] = [];
		let pending = true;
		const cleanup = (): void => {
			for (const remove of unsubscribe) remove();
			this.waiters.delete(rejectWaiter);
		};
		const rejectWaiter = (reason: Error): void => {
			if (!pending) return;
			pending = false;
			cleanup();
			result.reject(reason);
		};
		for (const method of networkTerminalMethods) {
			unsubscribe.push(
				this.on(method, (parameters): void => {
					if (!pending || !matches(parameters)) return;
					pending = false;
					cleanup();
					result.resolve(method);
				}),
			);
		}
		this.waiters.add(rejectWaiter);
		return {
			completed: result.promise,
			cancel: (): void => rejectWaiter(new Error('Network terminal wait cancelled')),
		};
	}

	disconnect(): void {
		this.socket.close();
	}

	forgetEvents(methods: readonly string[]): void {
		for (const method of methods) this.history.delete(method);
	}

	private end(kind: 'closed' | 'failed'): void {
		this.ended ??= {
			kind,
			error: new Error(
				kind === 'closed' ? 'DevTools connection closed' : 'DevTools connection failed',
			),
		};
		const error = this.ended.error;
		this.rejectPending(error);
		for (const rejectWaiter of this.waiters) rejectWaiter(error);
		this.waiters.clear();
	}

	private rejectPending(error: Error): void {
		for (const pending of this.pending.values()) pending.reject(error);
		this.pending.clear();
	}
}

async function readDevToolsEndpoint(
	child: ChildProcess,
	evidence: string,
): Promise<{ readonly port: number; readonly browserPath: string }> {
	return new Promise((resolve, reject): void => {
		let finished = false;
		let transcript = '';
		const finish = (
			error: Error | null,
			endpoint?: { readonly port: number; readonly browserPath: string },
		): void => {
			if (finished) return;
			finished = true;
			child.off('exit', exited);
			child.off('error', failed);
			child.stderr?.off('data', received);
			void writeFile(path.join(evidence, 'chrome.stderr.log'), transcript, { mode: 0o600 })
				.then((): void => {
					if (error !== null) reject(error);
					else if (endpoint !== undefined) resolve(endpoint);
				})
				.catch(reject);
		};
		const received = (chunk: Buffer): void => {
			transcript = (transcript + chunk.toString()).slice(-16384);
			const match = /^DevTools listening on (ws:\/\/[^\s]+)$/m.exec(transcript);
			if (match?.[1] === undefined) return;
			const endpoint = new URL(match[1]);
			const port = Number(endpoint.port);
			if (
				endpoint.protocol !== 'ws:' ||
				!['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) ||
				!endpoint.pathname.startsWith('/devtools/browser/') ||
				!Number.isInteger(port) ||
				port < 1
			)
				return finish(new Error('Chrome exposed an unexpected DevTools address'));
			finish(null, { port, browserPath: endpoint.pathname });
		};
		// Ends on the address line, or on Chrome exiting or failing: no real-time bound (R33).
		const exited = (code: number | null, signal: NodeJS.Signals | null): void =>
			finish(new Error('Chrome exited before DevTools: ' + String(code) + '/' + String(signal)));
		const failed = (error: Error): void => finish(error);
		child.once('exit', exited);
		child.once('error', failed);
		child.stderr?.on('data', received);
		if (child.stderr === null) finish(new Error('Chrome stderr is unavailable'));
	});
}

/** A fresh, headless instance with a private profile and dynamic debug port; never touches a user's browser. */
export async function startHeadlessChrome(
	evidence: string,
	observeAwait: NativeAwaitObserver = executeNativeAwait,
	observeCleanup: NativeAwaitObserver = executeNativeAwait,
): Promise<{
	readonly page: ChromeProtocol;
	readonly browser: ChromeProtocol;
	readonly pid: number;
	readonly close: () => Promise<void>;
}> {
	const profile = path.join(evidence, 'chrome-profile');
	await observeAwait('Chrome launch: private profile creation', () =>
		mkdir(profile, { mode: 0o700 }),
	);
	nativeBrowserGroups.assertAccepting();
	const child = spawn(
		z
			.string()
			.min(1)
			.parse(process.env.CHROME_BIN ?? 'google-chrome'),
		[
			'--headless=new',
			'--remote-debugging-address=127.0.0.1',
			'--remote-debugging-port=0',
			`--user-data-dir=${profile}`,
			'--no-first-run',
			'--no-default-browser-check',
			'--disable-background-networking',
			'--disable-sync',
			'--host-resolver-rules=MAP localhost 127.0.0.1',
			'about:blank',
		],
		{ stdio: ['ignore', 'ignore', 'pipe'], detached: true },
	);
	child.stderr?.on('data', (): void => undefined);
	const parentExited = new Promise<void>((resolve, reject): void => {
		child.once('exit', (): void => resolve());
		child.once('error', reject);
	});
	void parentExited.catch((): void => {});
	let browser: ChromeProtocol | undefined;
	let page: ChromeProtocol | undefined;
	const requestParentClose = async (
		requestTermination: () => GroupSignalAttempt,
	): Promise<NativeBrowserFailure> => {
		const failures: unknown[] = [];
		const closingBrowser = browser;
		let closeRequest: 'requested' | 'unavailable' = 'unavailable';
		if (child.exitCode === null && closingBrowser !== undefined) {
			try {
				await observeCleanup('Chrome close: Browser.close reply', async (): Promise<void> => {
					closeRequest = await closingBrowser.requestBrowserClose();
				});
			} catch (error) {
				failures.push(error);
			}
		}
		page?.disconnect();
		browser?.disconnect();
		// An unusable wire or failed launch has no dispatched close capability; its one owned signal still closes the parent.
		if (closeRequest === 'unavailable' && child.exitCode === null && child.signalCode === null)
			requestTermination();
		return failures.length === 0
			? { kind: 'none' }
			: {
					kind: 'failed',
					error:
						failures.length === 1
							? failures[0]
							: new AggregateError(failures, 'Chrome parent close checkpoints failed', {
									cause: failures[0],
								}),
				};
	};
	const acquisition =
		child.pid === undefined
			? undefined
			: nativeBrowserGroups.retain({
					group: child.pid,
					evidence,
					parent: {
						requestClose: requestParentClose,
						waitForExit: () => observeCleanup('Chrome close: child exit', () => parentExited),
					},
				});
	let closePromise: Promise<void> | undefined;
	function close(): Promise<void> {
		closePromise ??=
			acquisition === undefined
				? Promise.reject(new Error('Chrome has no owned process group'))
				: acquisition.close().then((): void => {});
		return closePromise;
	}

	try {
		const starting = Promise.all([
			readDevToolsEndpoint(child, evidence),
			writeFile(
				path.join(evidence, 'chrome-process.json'),
				JSON.stringify({ pid: child.pid ?? null, profile }),
				{ mode: 0o600 },
			),
		]);
		void starting.catch(() => undefined);
		const [endpoint] = await observeAwait(
			'Chrome launch: DevTools endpoint and process record',
			() => starting,
		);
		const browserConnection = await observeNativeAcquisition(
			observeAwait,
			'Chrome launch: browser WebSocket open',
			() => ChromeProtocol.connect(`ws://127.0.0.1:${endpoint.port}${endpoint.browserPath}`),
			(connection): void => {
				browser = connection;
			},
		);
		browser = browserConnection;
		await observeAwait('Chrome launch: target discovery reply', () =>
			browserConnection.call('Target.setDiscoverTargets', { discover: true }, emptyResult),
		);
		const targets = await observeAwait('Chrome launch: target list reply', () =>
			browserConnection.call('Target.getTargets', {}, targetsSchema),
		);
		let target = targets.targetInfos.find((candidate) => candidate.type === 'page');
		if (target === undefined) {
			const event = await observeAwait('Chrome launch: page targetCreated event', () =>
				browserConnection.waitFor('Target.targetCreated', (value): boolean => {
					const parsed = targetEventSchema.safeParse(value);
					return parsed.success && parsed.data.targetInfo.type === 'page';
				}),
			);
			target = targetEventSchema.parse(event).targetInfo;
		}
		const pageList = await observeAwait('Chrome launch: page endpoint HTTP response', () =>
			fetch(`http://127.0.0.1:${endpoint.port}/json/list`),
		);
		const pages = pageTargetsSchema.parse(
			await observeAwait('Chrome launch: page endpoint response body', () => pageList.json()),
		);
		const url = pages.find((candidate) => candidate.id === target.targetId)?.webSocketDebuggerUrl;
		if (url === undefined) throw new Error('Owned Chrome page target missing');
		page = await observeNativeAcquisition(
			observeAwait,
			'Chrome launch: page WebSocket open',
			() => ChromeProtocol.connect(url),
			(connection): void => {
				page = connection;
			},
		);
		if (child.pid === undefined) throw new Error('Owned Chrome PID missing');
		return { page, browser, pid: child.pid, close };
	} catch (error) {
		return withNativeBrowserCleanup(
			async (): Promise<never> => {
				throw error;
			},
			() => observeCleanup('Chrome launch: failed-launch cleanup', () => close()),
		);
	}
}
