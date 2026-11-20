import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { createNativeBrowserProgress } from '#sign-in-test-support/test-fixtures/native-browser-progress';
import { startHeadlessChrome } from '#sign-in-test-support/test-fixtures/native-browser-protocol';

const effects = vi.hoisted(() => ({ spawn: vi.fn(), mkdir: vi.fn(), writeFile: vi.fn() }));
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
	closed = false;
	constructor() {
		super();
		SyntheticDevToolsSocket.opened.push(this);
		queueMicrotask(() => this.dispatchEvent(new Event('open')));
	}
	send(serialized: string): void {
		const request = z.object({ id: z.number(), method: z.string() }).parse(JSON.parse(serialized));
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
		this.dispatchEvent(new Event('close'));
	}
}
beforeEach(() => {
	vi.clearAllMocks();
	effects.mkdir.mockResolvedValue(undefined);
	effects.writeFile.mockResolvedValue(undefined);
	SyntheticDevToolsSocket.opened.length = 0;
	SyntheticDevToolsSocket.refuseDiscovery = false;
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
afterEach(() => {
	vi.unstubAllGlobals();
});

function ownSyntheticChild(): { child: SyntheticChromeChild; spawned: Promise<void> } {
	const child = new SyntheticChromeChild();
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
		expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
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
	expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
});
