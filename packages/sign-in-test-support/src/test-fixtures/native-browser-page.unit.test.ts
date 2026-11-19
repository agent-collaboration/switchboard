import { expect, it } from 'vitest';
import type { z } from 'zod';

import { NativeBrowserPage } from '#sign-in-test-support/test-fixtures/native-browser-page';

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
	);

	const captured = await page.captureFailureFrame();

	expect(captured).toEqual(Buffer.from('captured frame'));
	expect(calls).toEqual([{ method: 'Page.captureScreenshot', parameters: { format: 'png' } }]);
});
