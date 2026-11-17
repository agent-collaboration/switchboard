import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

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
	private ended: Error | null = null;

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
		socket.addEventListener('close', (): void => this.end(new Error('DevTools connection closed')));
		socket.addEventListener('error', (): void => this.end(new Error('DevTools connection failed')));
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

	async call<TValue>(
		method: string,
		parameters: Readonly<Record<string, unknown>>,
		schema: z.ZodType<TValue>,
	): Promise<TValue> {
		if (this.ended !== null) throw this.ended;
		const id = ++this.nextId;
		const answer = new Promise<unknown>((resolve, reject): void => {
			this.pending.set(id, { method, resolve, reject });
		});
		try {
			this.socket.send(JSON.stringify({ id, method, params: parameters }));
		} catch (error) {
			const pending = this.pending.get(id);
			if (pending !== undefined) {
				this.pending.delete(id);
				pending.reject(error instanceof Error ? error : new Error('DevTools send failed'));
			}
		}
		return schema.parse(await answer);
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
		if (this.ended !== null) throw this.ended;
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
			return { completed: Promise.reject(this.ended), cancel: (): void => {} };
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

	private end(error: Error): void {
		this.ended ??= error;
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
export async function startHeadlessChrome(evidence: string): Promise<{
	readonly page: ChromeProtocol;
	readonly browser: ChromeProtocol;
	readonly pid: number;
	readonly close: () => Promise<void>;
}> {
	const profile = path.join(evidence, 'chrome-profile');
	await mkdir(profile, { mode: 0o700 });
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
			'about:blank',
		],
		{ stdio: ['ignore', 'ignore', 'pipe'] },
	);
	child.stderr?.on('data', (): void => undefined);
	let browser: ChromeProtocol | undefined;
	let page: ChromeProtocol | undefined;
	async function close(): Promise<void> {
		if (child.exitCode === null && browser !== undefined) {
			try {
				await browser.call('Browser.close', {}, emptyResult);
			} catch {
				/* Browser closes its socket before acknowledging. */
			}
		}
		page?.disconnect();
		browser?.disconnect();
		if (child.exitCode !== null || child.signalCode !== null) return;
		// Ends on Chrome's exit, or at once when the signal can't be sent: no real-time bound (R33).
		await new Promise<void>((resolve, reject): void => {
			child.once('exit', (): void => resolve());
			if (!child.kill('SIGTERM')) reject(new Error('Cannot stop owned Chrome'));
		});
	}
	try {
		const [endpoint] = await Promise.all([
			readDevToolsEndpoint(child, evidence),
			writeFile(
				path.join(evidence, 'chrome-process.json'),
				JSON.stringify({ pid: child.pid ?? null, profile }),
				{ mode: 0o600 },
			),
		]);
		browser = await ChromeProtocol.connect(
			`ws://127.0.0.1:${endpoint.port}${endpoint.browserPath}`,
		);
		await browser.call('Target.setDiscoverTargets', { discover: true }, emptyResult);
		const targets = await browser.call('Target.getTargets', {}, targetsSchema);
		let target = targets.targetInfos.find((candidate) => candidate.type === 'page');
		if (target === undefined) {
			const event = await browser.waitFor('Target.targetCreated', (value): boolean => {
				const parsed = targetEventSchema.safeParse(value);
				return parsed.success && parsed.data.targetInfo.type === 'page';
			});
			target = targetEventSchema.parse(event).targetInfo;
		}
		const pages = pageTargetsSchema.parse(
			await (await fetch(`http://127.0.0.1:${endpoint.port}/json/list`)).json(),
		);
		const url = pages.find((candidate) => candidate.id === target.targetId)?.webSocketDebuggerUrl;
		if (url === undefined) throw new Error('Owned Chrome page target missing');
		page = await ChromeProtocol.connect(url);
		if (child.pid === undefined) throw new Error('Owned Chrome PID missing');
		return { page, browser, pid: child.pid, close };
	} catch (error) {
		await close();
		throw error;
	}
}
