import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { nativeBrowserGroups } from '#sign-in-test-support/test-fixtures/native-browser-groups';
import {
	createNativeBrowserProgress,
	executeNativeAwait,
	type NativeAwaitObserver,
} from '#sign-in-test-support/test-fixtures/native-browser-progress';
import { startHeadlessChrome } from '#sign-in-test-support/test-fixtures/native-browser-protocol';
import type { OwnedGroupCleanup } from '#sign-in-test-support/test-fixtures/owned-process-group';

const effects = vi.hoisted(() => ({
	spawn: vi.fn(),
	mkdir: vi.fn(),
	writeFile: vi.fn(),
	groupCleanup: vi.fn(),
	terminate: vi.fn(),
	finishChild: (): void => {},
}));
vi.mock('#sign-in-test-support/test-fixtures/owned-process-group', () => ({
	settleOwnedProcessGroup: effects.groupCleanup,
	terminateOwnedProcessGroup: effects.terminate,
}));
vi.mock('node:child_process', async (importOriginal) => ({
	...(await importOriginal<typeof import('node:child_process')>()),
	spawn: effects.spawn,
}));
vi.mock('node:fs/promises', async (importOriginal) => ({
	...(await importOriginal<typeof import('node:fs/promises')>()),
	mkdir: effects.mkdir,
	writeFile: effects.writeFile,
}));

class SyntheticChromeChild extends EventEmitter {
	readonly stderr = new PassThrough();
	readonly pid = 101;
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;
	readonly kill = vi.fn((signal: NodeJS.Signals): boolean => {
		queueMicrotask(() => {
			this.signalCode = signal;
			this.emit('exit', null, signal);
		});
		return true;
	});
}
class SyntheticDevToolsSocket extends EventTarget {
	static readonly opened: SyntheticDevToolsSocket[] = [];
	static refuseDiscovery = false;
	static closeOnBrowserRequest = false;
	static failBrowserSend = false;
	static refuseBrowserClose = false;
	static readonly OPEN = 1;
	readyState = 1;
	readonly requests: string[] = [];
	closed = false;
	constructor() {
		super();
		SyntheticDevToolsSocket.opened.push(this);
		queueMicrotask(() => this.dispatchEvent(new Event('open')));
	}
	send(serialized: string): void {
		const request = z.object({ id: z.number(), method: z.string() }).parse(JSON.parse(serialized));
		this.requests.push(request.method);
		if (request.method === 'Browser.close') {
			if (SyntheticDevToolsSocket.failBrowserSend) throw new Error('Synthetic send failure');
			if (SyntheticDevToolsSocket.refuseBrowserClose) {
				queueMicrotask(() =>
					this.dispatchEvent(
						new MessageEvent('message', {
							data: JSON.stringify({
								id: request.id,
								error: { code: -32000, message: 'Synthetic close refusal' },
							}),
						}),
					),
				);
				return;
			}
			effects.finishChild();
			if (SyntheticDevToolsSocket.closeOnBrowserRequest) {
				this.close();
				return;
			}
		}
		const result =
			request.method === 'Target.getTargets'
				? { targetInfos: [{ targetId: 'owned-page', type: 'page' }] }
				: {};
		const reply =
			SyntheticDevToolsSocket.refuseDiscovery && request.method === 'Target.setDiscoverTargets'
				? { id: request.id, error: { code: -32000, message: 'Synthetic discovery refusal' } }
				: { id: request.id, result };
		queueMicrotask(() =>
			this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(reply) })),
		);
	}
	close(): void {
		this.closed = true;
		this.readyState = 3;
		this.dispatchEvent(new Event('close'));
	}
}
beforeEach(() => {
	vi.clearAllMocks();
	effects.mkdir.mockResolvedValue(undefined);
	effects.writeFile.mockResolvedValue(undefined);
	effects.terminate.mockImplementation((): { kind: 'sent'; signal: 'SIGTERM' } => {
		effects.finishChild();
		return { kind: 'sent', signal: 'SIGTERM' };
	});
	effects.groupCleanup.mockImplementation(
		async (props: { readonly group: number }): Promise<OwnedGroupCleanup> => {
			return {
				kind: 'natural',
				group: props.group,
				reads: [[]],
				termination: { kind: 'not-requested' },
				remaining: [],
			};
		},
	);
	SyntheticDevToolsSocket.opened.length = 0;
	SyntheticDevToolsSocket.refuseDiscovery = false;
	SyntheticDevToolsSocket.closeOnBrowserRequest = false;
	SyntheticDevToolsSocket.failBrowserSend = false;
	SyntheticDevToolsSocket.refuseBrowserClose = false;
	vi.stubGlobal('WebSocket', SyntheticDevToolsSocket);
	vi.stubGlobal(
		'fetch',
		vi.fn(async () =>
			Response.json([
				{ id: 'owned-page', webSocketDebuggerUrl: 'ws://127.0.0.1:41001/devtools/page/owned' },
			]),
		),
	);
});
afterEach(async (): Promise<void> => {
	await nativeBrowserGroups.closeAll('teardown');
	vi.unstubAllGlobals();
});

function ownSyntheticChild(): { child: SyntheticChromeChild; spawned: Promise<void> } {
	const child = new SyntheticChromeChild();
	effects.finishChild = (): void => {
		child.exitCode = 0;
		child.emit('exit', 0, null);
	};
	const spawned = Promise.withResolvers<void>();
	effects.spawn.mockImplementation(() => {
		spawned.resolve();
		return child;
	});
	return { child, spawned: spawned.promise };
}

it.each(['browser', 'page'] as const)(
	'closes the acquired %s socket when its completion checkpoint rejects',
	async (connection) => {
		// Arrange
		const { child, spawned } = ownSyntheticChild();
		const recordingFailure = new Error('Completion checkpoint rejected');
		const operation = `Chrome launch: ${connection} WebSocket open`;
		let acquisitionStarted = false;
		let rejected = false;
		const progress = createNativeBrowserProgress({
			steps: () => [],
			write: async (snapshot): Promise<void> => {
				if (
					snapshot.some((row) => row.status === 'awaiting' && row.facts.operation === operation)
				) {
					acquisitionStarted = true;
				} else if (acquisitionStarted && !rejected) {
					rejected = true;
					throw recordingFailure;
				}
			},
		});
		const launching = startHeadlessChrome(
			'/unused-native-progress-evidence',
			progress.observe,
			progress.observeCleanup,
		);
		const failure = expect(launching).rejects.toBe(recordingFailure);
		await spawned;
		// Act
		child.stderr.write('DevTools listening on ws://127.0.0.1:41001/devtools/browser/owned\n');
		await failure;
		// Assert
		expect(rejected).toBe(true);
		expect(SyntheticDevToolsSocket.opened).toHaveLength(connection === 'browser' ? 1 : 2);
		expect(SyntheticDevToolsSocket.opened.every((socket) => socket.closed)).toBe(true);
		expect(effects.groupCleanup).toHaveBeenCalledTimes(1);
		expect(child.kill).not.toHaveBeenCalled();
	},
);

it('preserves launch failure and closes owned resources when the failed-launch checkpoint rejects', async () => {
	// Arrange
	const { child, spawned } = ownSyntheticChild();
	const recordingFailure = new Error('Failed-launch checkpoint rejected');
	SyntheticDevToolsSocket.refuseDiscovery = true;
	const progress = createNativeBrowserProgress({
		steps: () => [],
		write: async (snapshot): Promise<void> => {
			if (
				snapshot.some(
					(row) =>
						row.status === 'awaiting' &&
						row.facts.operation === 'Chrome launch: failed-launch cleanup',
				)
			)
				throw recordingFailure;
		},
	});
	const launching = startHeadlessChrome(
		'/unused-native-progress-evidence',
		progress.observe,
		progress.observeCleanup,
	);
	const failure = expect(launching).rejects.toMatchObject({
		cause: { message: 'Target.setDiscoverTargets: Synthetic discovery refusal' },
	});
	await spawned;
	// Act
	child.stderr.write('DevTools listening on ws://127.0.0.1:41001/devtools/browser/owned\n');
	await failure;
	// Assert
	expect(SyntheticDevToolsSocket.opened.every((socket) => socket.closed)).toBe(true);
	expect(effects.groupCleanup).toHaveBeenCalledTimes(1);
	expect(child.kill).not.toHaveBeenCalled();
});

it('keeps Chrome teardown pending until its owned renderer group is empty after parent exit', async (): Promise<void> => {
	const { child, spawned } = ownSyntheticChild();
	const launching = startHeadlessChrome('/unused-native-group-evidence');
	await spawned;
	child.stderr.write('DevTools listening on ws://127.0.0.1:41001/devtools/browser/owned\n');
	const chrome = await launching;
	child.exitCode = 0;
	child.emit('exit', 0, null);
	const reaped = Promise.withResolvers<OwnedGroupCleanup>();
	const sampling = Promise.withResolvers<void>();
	effects.groupCleanup.mockImplementation((): Promise<OwnedGroupCleanup> => {
		sampling.resolve();
		return reaped.promise;
	});
	let finished = false;
	const closing = chrome.close().then((): void => {
		finished = true;
	});
	try {
		await Promise.resolve();
		expect(finished).toBe(false);
		await sampling.promise;
		expect(finished).toBe(false);
		expect(effects.groupCleanup).toHaveBeenCalledTimes(1);
	} finally {
		reaped.resolve({
			kind: 'natural',
			group: 101,
			reads: [[], []],
			termination: { kind: 'not-requested' },
			remaining: [],
		});
		await closing;
	}
	expect(finished).toBe(true);
});

it('lets a later first helper finally join teardown that already closed the acquisition', async (): Promise<void> => {
	const { child, spawned } = ownSyntheticChild();
	const launching = startHeadlessChrome('/unused-late-finally-evidence');
	await spawned;
	child.stderr.write('DevTools listening on ws://127.0.0.1:41001/devtools/browser/owned\n');
	const chrome = await launching;
	await nativeBrowserGroups.closeAll('teardown');
	await expect(chrome.close()).resolves.toBeUndefined();
	expect(effects.groupCleanup).toHaveBeenCalledTimes(1);
});

it('falls back once when an existing browser wire ended before it could send close', async (): Promise<void> => {
	const waiting = Promise.withResolvers<void>();
	const observeCleanup: NativeAwaitObserver = (operation, perform) => {
		if (operation === 'Chrome close: child exit') waiting.resolve();
		return perform();
	};
	const { child, spawned } = ownSyntheticChild();
	const launching = startHeadlessChrome(
		'/unused-ended-wire-evidence',
		executeNativeAwait,
		observeCleanup,
	);
	await spawned;
	child.stderr.write('DevTools listening on ws://127.0.0.1:41001/devtools/browser/owned\n');
	const chrome = await launching;
	chrome.browser.disconnect();
	const closing = chrome.close();
	try {
		await waiting.promise;
		expect(effects.terminate).toHaveBeenCalledExactlyOnceWith(101);
		expect(
			SyntheticDevToolsSocket.opened
				.flatMap((socket) => socket.requests)
				.filter((method) => method === 'Browser.close'),
		).toEqual([]);
	} finally {
		if (child.exitCode === null && child.signalCode === null) effects.finishChild();
		await closing;
	}
});

it('preserves unsignalled graceful close when EOF follows the dispatched Browser.close request', async (): Promise<void> => {
	SyntheticDevToolsSocket.closeOnBrowserRequest = true;
	const { child, spawned } = ownSyntheticChild();
	const launching = startHeadlessChrome('/unused-graceful-eof-evidence');
	await spawned;
	child.stderr.write('DevTools listening on ws://127.0.0.1:41001/devtools/browser/owned\n');
	const chrome = await launching;
	await chrome.close();
	expect(effects.terminate).not.toHaveBeenCalled();
	expect(
		SyntheticDevToolsSocket.opened
			.flatMap((socket) => socket.requests)
			.filter((method) => method === 'Browser.close'),
	).toEqual(['Browser.close']);
});

it.each(['closing', 'send-failed', 'refused'] as const)(
	'uses the one acquisition fallback for a %s close capability',
	async (kind): Promise<void> => {
		const { child, spawned } = ownSyntheticChild();
		const launching = startHeadlessChrome('/unused-unusable-wire-evidence');
		await spawned;
		child.stderr.write('DevTools listening on ws://127.0.0.1:41001/devtools/browser/owned\n');
		const chrome = await launching;
		const browserWire = SyntheticDevToolsSocket.opened[0];
		if (browserWire === undefined) throw new Error('Browser wire missing');
		if (kind === 'closing') browserWire.readyState = 2;
		if (kind === 'send-failed') SyntheticDevToolsSocket.failBrowserSend = true;
		if (kind === 'refused') SyntheticDevToolsSocket.refuseBrowserClose = true;
		await chrome.close();
		expect(effects.terminate).toHaveBeenCalledExactlyOnceWith(101);
		expect(effects.groupCleanup).toHaveBeenCalledTimes(1);
	},
);
