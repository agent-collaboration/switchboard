import { expect, it } from 'vitest';
import { z } from 'zod';

import { NativeBrowserPage } from '#sign-in-test-support/test-fixtures/native-browser-page';
import type { NativeAwaitObserver } from '#sign-in-test-support/test-fixtures/native-browser-progress';
import { createNativeBrowserProgress } from '#sign-in-test-support/test-fixtures/native-browser-progress';

it('sends a cleanup evaluation despite a rejected checkpoint and retains that recording error', async () => {
	const recordingFailure = new Error('Cancellation checkpoint rejected');
	const calls: string[] = [];
	let writes = 0;
	const progress = createNativeBrowserProgress({
		steps: () => [],
		write: async (): Promise<void> => {
			if (++writes === 1) throw recordingFailure;
		},
	});
	const page = new NativeBrowserPage(
		{
			call: async <TValue>(
				method: string,
				_parameters: Readonly<Record<string, unknown>>,
				schema: z.ZodType<TValue>,
			): Promise<TValue> => {
				calls.push(method);
				return schema.parse({ result: { value: true } });
			},
			waitFor: async (): Promise<never> => {
				throw new Error('Unexpected event wait');
			},
			forgetEvents: (): void => {},
		},
		'/unused-native-cleanup-evidence',
		progress.observe,
	);
	await expect(page.evaluate('true', z.literal(true), progress.observeCleanup)).rejects.toBe(
		recordingFailure,
	);
	expect(calls).toEqual(['Runtime.evaluate']);
});

it('captures failure bytes directly without waiting on renderer frames or layout', async () => {
	const calls: {
		readonly method: string;
		readonly parameters: Readonly<Record<string, unknown>>;
	}[] = [];
	const page = new NativeBrowserPage(
		{
			call: async <TValue>(
				method: string,
				parameters: Readonly<Record<string, unknown>>,
				schema: z.ZodType<TValue>,
			): Promise<TValue> => {
				calls.push({ method, parameters });
				if (method !== 'Page.captureScreenshot') throw new Error('Unexpected renderer wait');
				return schema.parse({ data: Buffer.from('captured frame').toString('base64') });
			},
			waitFor: async (): Promise<never> => {
				throw new Error('Failure capture must not await another protocol event');
			},
			forgetEvents: (): never => {
				throw new Error('Failure capture must not change protocol history');
			},
		},
		'/unused-native-failure-evidence',
		(): never => {
			throw new Error('Failure capture must bypass progress storage');
		},
	);

	const captured = await page.captureFailureFrame();

	expect(captured).toEqual(Buffer.from('captured frame'));
	expect(calls).toEqual([{ method: 'Page.captureScreenshot', parameters: { format: 'png' } }]);
});

it.each(['response', 'navigation'] as const)(
	'arms the %s event before a checkpoint can yield and before the action runs',
	async (kind) => {
		const checkpointEntered = Promise.withResolvers<void>();
		const releaseCheckpoint = Promise.withResolvers<void>();
		const received = Promise.withResolvers<unknown>();
		const events: string[] = [];
		let checkpoints = 0;
		const observe: NativeAwaitObserver = async (_operation, perform) => {
			if (++checkpoints === 1) {
				checkpointEntered.resolve();
				await releaseCheckpoint.promise;
			}
			return perform();
		};
		const page = new NativeBrowserPage(
			{
				call: async (): Promise<never> => {
					throw new Error('Unexpected CDP call');
				},
				waitFor: (method): Promise<unknown> => {
					events.push(method);
					return received.promise;
				},
				forgetEvents: (): void => {},
			},
			'/unused-native-progress-evidence',
			observe,
		);
		const response = {
			requestId: 'owned-request',
			response: { url: 'http://localhost/verified', status: 401 },
		};
		const action = async (): Promise<void> => {
			events.push('action');
			received.resolve(response);
		};
		const completion =
			kind === 'response'
				? page.responseTo('/verified', action)
				: page.afterNavigation('/verified', action);
		void completion.catch(() => undefined);
		await Promise.race([checkpointEntered.promise, completion]);
		expect(events).toEqual([
			kind === 'response' ? 'Network.responseReceived' : 'Page.frameNavigated',
		]);
		releaseCheckpoint.resolve();
		await completion;
		expect(events.at(-1)).toBe('action');
	},
);

it('arms body completion before checkpoint storage and retains an event received during that write', async () => {
	const checkpointEntered = Promise.withResolvers<void>();
	const releaseCheckpoint = Promise.withResolvers<void>();
	const finished = Promise.withResolvers<unknown>();
	const events: string[] = [];
	const page = new NativeBrowserPage(
		{
			call: async <TValue>(
				method: string,
				_parameters: Readonly<Record<string, unknown>>,
				schema: z.ZodType<TValue>,
			): Promise<TValue> => {
				events.push(method);
				return schema.parse({ body: '{"code":"refused"}', base64Encoded: false });
			},
			waitFor: (method): Promise<unknown> => {
				events.push(method);
				return finished.promise;
			},
			forgetEvents: (): void => {},
		},
		'/unused-native-progress-evidence',
		async (_operation, perform) => {
			checkpointEntered.resolve();
			await releaseCheckpoint.promise;
			return perform();
		},
	);
	const completion = page.readBody({
		requestId: 'owned-request',
		response: { url: 'http://localhost/verified', status: 401 },
	});
	void completion.catch(() => undefined);
	await Promise.race([checkpointEntered.promise, completion]);
	expect(events).toEqual(['Network.loadingFinished']);
	finished.resolve({ requestId: 'owned-request' });
	releaseCheckpoint.resolve();
	await expect(completion).resolves.toEqual({ code: 'refused' });
	expect(events).toEqual(['Network.loadingFinished', 'Network.getResponseBody']);
});
