import { createContext, Script, type Context } from 'node:vm';

import { expect, it } from 'vitest';
import { z } from 'zod';

import { createIsolatedPageDom } from '#sign-in-test-support/test-fixtures/isolated-page-dom';
import { executeNativeAwait } from '#sign-in-test-support/test-fixtures/native-browser-progress';
import {
	createNativePasskeyRegistrationObservation,
	nativePasskeyRegistrationBinding,
	nativePasskeyRegistrationButton,
	nativePasskeyRegistrationReady,
	nativePasskeyRegistrationScript,
	type NativePasskeyRegistrationRecord,
} from '#sign-in-test-support/test-fixtures/native-passkey-registration-observation';
import type { PlaywrightBrowserPage } from '#sign-in-test-support/test-fixtures/playwright-browser';

// The served fallback contract is factor-page.tsx's Add button inside IslandRoot.
const fallbackMarkup = `<h1 id="security-heading">Security</h1><div id="status"></div><div data-sign-in-island data-island-state='{"kind":"passkey-management"}'><button id="add-passkey" type="button">Add passkey</button></div>`;

it('rejects server fallback and mount-without-controls before accepting the committed enabled control', () => {
	const dom = createIsolatedPageDom(fallbackMarkup, 'http://localhost/owner-ready');
	try {
		const document = dom.window.document;
		const context = createContext({ document });
		const ready = (): boolean =>
			z.boolean().parse(new Script(nativePasskeyRegistrationReady).runInContext(context));
		const root = document.querySelector('[data-sign-in-island]');
		const serverButton = document.getElementById('add-passkey');
		if (root === null || serverButton === null) throw new Error('Fallback fixture missing');
		expect(ready()).toBe(false);

		// mountSignInIslands removes fallback, marks its root, then React commits controls.
		root.replaceChildren();
		root.setAttribute('data-sign-in-island-mounted', '');
		expect(serverButton.isConnected).toBe(false);
		expect(ready()).toBe(false);
		const mountedButton = document.createElement('button');
		mountedButton.textContent = 'Add passkey';
		mountedButton.disabled = true;
		root.appendChild(mountedButton);
		expect(ready()).toBe(false);
		mountedButton.disabled = false;
		expect(ready()).toBe(true);
		expect(document.querySelector(nativePasskeyRegistrationButton)).toBe(mountedButton);
	} finally {
		dom.window.close();
	}
});

type CreateCredential = (this: unknown, ...argumentsList: unknown[]) => Promise<unknown>;
const ignoreObservation = (_event: unknown): void => {};

function browserProbe(create: CreateCredential): {
	readonly document: Document;
	readonly context: Context;
	readonly credentials: { create: CreateCredential };
	readonly events: unknown[];
	readonly observe: (listener: (event: unknown) => void) => void;
	readonly close: () => void;
} {
	const dom = createIsolatedPageDom(fallbackMarkup, 'http://localhost/owner-ready');
	const credentials = { create };
	const events: unknown[] = [];
	let observed: (event: unknown) => void = ignoreObservation;
	const context = createContext({
		document: dom.window.document,
		navigator: { credentials },
		MutationObserver: dom.window.MutationObserver,
		[nativePasskeyRegistrationBinding]: (payload: string): void => {
			const event: unknown = JSON.parse(payload);
			events.push(event);
			observed(event);
		},
	});
	new Script(nativePasskeyRegistrationScript).runInContext(context);
	return {
		document: dom.window.document,
		context,
		credentials,
		events,
		observe: (listener): void => {
			observed = listener;
		},
		close: (): void => dom.window.close(),
	};
}

function commitIslandControl(document: Document): HTMLButtonElement {
	const root = document.querySelector('[data-sign-in-island]');
	if (root === null) throw new Error('Passkey root missing');
	root.replaceChildren();
	root.setAttribute('data-sign-in-island-mounted', '');
	const button = document.createElement('button');
	button.textContent = 'Add passkey';
	root.appendChild(button);
	return button;
}

it('distinguishes legacy and freshly resolved island activation and omits status text', async () => {
	const probe = browserProbe(() => Promise.resolve(null));
	try {
		probe.document.getElementById('add-passkey')?.click();
		const button = commitIslandControl(probe.document);
		button.click();
		expect(probe.events).toContainEqual({
			kind: 'input',
			phase: 'click',
			controller: 'legacy',
			expectedControl: true,
			trusted: false,
			mounted: false,
		});
		expect(probe.events).toContainEqual({
			kind: 'input',
			phase: 'click',
			controller: 'island',
			expectedControl: true,
			trusted: false,
			mounted: true,
		});
		const changed = Promise.withResolvers<void>();
		probe.observe((event): void => {
			if (
				z.object({ kind: z.literal('state'), legacyStatus: z.literal(true) }).safeParse(event)
					.success
			)
				changed.resolve();
		});
		const status = probe.document.getElementById('status');
		if (status === null) throw new Error('Legacy status missing');
		status.textContent = 'private status value must not be emitted';
		await changed.promise;
		expect(JSON.stringify(probe.events)).not.toContain(status.textContent);
	} finally {
		probe.close();
	}
});

it('observes native creation without replacing its receiver, arguments, promise or credential value', async () => {
	const pending = Promise.withResolvers<unknown>();
	let expectedReceiver: unknown;
	let receiverMatches = false;
	let argumentsObserved: unknown[] = [];
	const probe = browserProbe(function (this: unknown, ...argumentsList): Promise<unknown> {
		receiverMatches = this === expectedReceiver;
		argumentsObserved = argumentsList;
		return pending.promise;
	});
	try {
		expectedReceiver = probe.credentials;
		commitIslandControl(probe.document).click();
		const options = { challenge: 'private options must not be emitted' };
		const returned = probe.credentials.create(options);
		expect(receiverMatches).toBe(true);
		expect(argumentsObserved).toEqual([options]);
		expect(returned).toBe(pending.promise);
		expect(probe.events).toContainEqual({
			kind: 'create',
			phase: 'entered',
			controller: 'island',
			mounted: true,
		});
		const settled = Promise.withResolvers<void>();
		probe.observe((event): void => {
			if (
				z.object({ kind: z.literal('create'), phase: z.literal('fulfilled') }).safeParse(event)
					.success
			)
				settled.resolve();
		});
		const credential = { privateKey: 'private credential must not be emitted' };
		pending.resolve(credential);
		await settled.promise;
		await expect(returned).resolves.toBe(credential);
		expect(probe.events).toContainEqual({
			kind: 'create',
			phase: 'fulfilled',
			controller: 'island',
			mounted: true,
			credentialPresent: true,
		});
		expect(JSON.stringify(probe.events)).not.toContain(options.challenge);
		expect(JSON.stringify(probe.events)).not.toContain(credential.privateKey);
	} finally {
		probe.close();
	}
});

it('keeps native rejected and synchronously thrown errors unchanged and out of emitted data', async () => {
	const failure = new Error('private native rejection');
	const pending = Promise.withResolvers<unknown>();
	const probe = browserProbe(() => pending.promise);
	try {
		const returned = probe.credentials.create();
		expect(returned).toBe(pending.promise);
		const rejected = expect(returned).rejects.toBe(failure);
		pending.reject(failure);
		await rejected;
		expect(probe.events).toContainEqual({
			kind: 'create',
			phase: 'rejected',
			controller: 'other',
			mounted: false,
		});
		expect(JSON.stringify(probe.events)).not.toContain(failure.message);
	} finally {
		probe.close();
	}
	const throwing = browserProbe((): Promise<never> => {
		throw failure;
	});
	try {
		let thrown: unknown;
		try {
			void throwing.credentials.create();
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBe(failure);
		expect(throwing.events).toContainEqual({
			kind: 'create',
			phase: 'threw',
			controller: 'other',
			mounted: false,
		});
		expect(JSON.stringify(throwing.events)).not.toContain(failure.message);
	} finally {
		throwing.close();
	}
});

function protocolEvents(): {
	readonly transport: import('./native-passkey-registration-observation').NativePasskeyRegistrationTransport;
	readonly page: Pick<PlaywrightBrowserPage, 'evaluate'>;
	readonly emit: (method: string, value: unknown) => void;
	readonly calls: string[];
	readonly listeners: Map<string, Set<(value: unknown) => void>>;
} {
	const listeners = new Map<string, Set<(value: unknown) => void>>();
	const calls: string[] = [];
	function emit(method: string, value: unknown): void {
		for (const listener of listeners.get(method) ?? []) listener(value);
	}
	return {
		listeners,
		calls,
		emit,
		transport: {
			subscribe: (method, listener): (() => void) => {
				const entries = listeners.get(method) ?? new Set();
				entries.add(listener);
				listeners.set(method, entries);
				return (): void => {
					entries.delete(listener);
				};
			},
			addBinding: (): Promise<void> => {
				calls.push('Runtime.addBinding');
				return Promise.resolve();
			},
		},
		page: {
			evaluate: <TValue>(_expression: string, schema: z.ZodType<TValue>): Promise<TValue> => {
				emit('Runtime.bindingCalled', {
					name: nativePasskeyRegistrationBinding,
					payload: JSON.stringify({ kind: 'installed' }),
				});
				return Promise.resolve(schema.parse(true));
			},
		},
	};
}

it('records only the expected options origin/path and closes without accepting late events', async () => {
	const transport = protocolEvents();
	const records: NativePasskeyRegistrationRecord[] = [];
	const observation = createNativePasskeyRegistrationObservation({
		transport: transport.transport,
		issuer: 'http://localhost',
		write: async (record): Promise<void> => {
			records.push(record);
		},
	});
	await observation.install(transport.page, executeNativeAwait);
	transport.emit('Network.requestWillBeSent', {
		request: { url: 'http://foreign.invalid/api/auth/passkey/generate-register-options' },
	});
	transport.emit('Network.requestWillBeSent', {
		request: {
			url: 'http://localhost/api/auth/passkey/generate-register-options?private=do-not-record',
		},
	});
	transport.emit('Network.responseReceived', {
		response: { url: 'http://localhost/api/auth/passkey/generate-register-options', status: 200 },
	});
	await observation.finish();
	expect(records.map((record) => record.event)).toEqual([
		{ kind: 'created' },
		{ kind: 'installed' },
		{ kind: 'options-requested' },
		{ kind: 'options-response', status: 200 },
	]);
	expect(records.map((record) => record.sequence)).toEqual([1, 2, 3, 4]);
	expect(JSON.stringify(records)).not.toContain('do-not-record');
	transport.emit('Network.requestWillBeSent', {
		request: { url: 'http://localhost/api/auth/passkey/generate-register-options' },
	});
	expect(records).toHaveLength(4);
	expect([...transport.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
});

it('accepts the actual browser program through the strict binding schema without credential values', async () => {
	const transport = protocolEvents();
	const dom = createIsolatedPageDom(fallbackMarkup, 'http://localhost/owner-ready');
	const pending = Promise.withResolvers<unknown>();
	const records: NativePasskeyRegistrationRecord[] = [];
	const credentials = { create: (): Promise<unknown> => pending.promise };
	const context = createContext({
		document: dom.window.document,
		navigator: { credentials },
		MutationObserver: dom.window.MutationObserver,
		[nativePasskeyRegistrationBinding]: (payload: string): void => {
			transport.emit('Runtime.bindingCalled', { name: nativePasskeyRegistrationBinding, payload });
		},
	});
	const observation = createNativePasskeyRegistrationObservation({
		transport: transport.transport,
		issuer: 'http://localhost',
		write: async (record): Promise<void> => {
			records.push(record);
		},
	});
	try {
		await observation.install(
			{
				evaluate: <TValue>(expression: string, schema: z.ZodType<TValue>): Promise<TValue> =>
					Promise.resolve(schema.parse(new Script(expression).runInContext(context))),
			},
			executeNativeAwait,
		);
		commitIslandControl(dom.window.document).click();
		const returned = credentials.create();
		expect(returned).toBe(pending.promise);
		pending.resolve({ privateKey: 'not a diagnostic value' });
		await returned;
		await observation.finish();
		expect(records).toContainEqual(
			expect.objectContaining({
				event: { kind: 'create', phase: 'entered', controller: 'island', mounted: true },
			}),
		);
		expect(records).toContainEqual(
			expect.objectContaining({
				event: {
					kind: 'create',
					phase: 'fulfilled',
					controller: 'island',
					mounted: true,
					credentialPresent: true,
				},
			}),
		);
		expect(JSON.stringify(records)).not.toContain('not a diagnostic value');
	} finally {
		await observation.finish();
		dom.window.close();
	}
});

it('serializes diagnostic writes before installation and retains write failure while removing listeners', async () => {
	const transport = protocolEvents();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let writes = 0;
	let activeWrites = 0;
	const overlaps: number[] = [];
	const observation = createNativePasskeyRegistrationObservation({
		transport: transport.transport,
		issuer: 'http://localhost',
		write: async (): Promise<void> => {
			activeWrites += 1;
			overlaps.push(activeWrites);
			if (++writes === 1) {
				entered.resolve();
				await release.promise;
			}
			activeWrites -= 1;
		},
	});
	const installation = observation.install(transport.page, executeNativeAwait);
	await entered.promise;
	expect(transport.calls).toEqual([]);
	release.resolve();
	await installation;
	await observation.finish();
	expect(overlaps.every((active) => active === 1)).toBe(true);

	const failure = new Error('Private diagnostic write refused');
	const failed = createNativePasskeyRegistrationObservation({
		transport: transport.transport,
		issuer: 'http://localhost',
		write: async (): Promise<never> => {
			throw failure;
		},
	});
	await expect(failed.install(transport.page, executeNativeAwait)).rejects.toBe(failure);
	await expect(failed.finish()).rejects.toBe(failure);
	expect([...transport.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
});
