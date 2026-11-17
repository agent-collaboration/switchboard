import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
	createStorageTestHost,
	type StorageTestHost,
} from '#sign-in-test-support/storage-cases/dual-storage-test-host';
import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import { requireManagementRefusalReadback } from '#sign-in-test-support/test-fixtures/management-refusal-readback';

useControlledSignInClock();
const readbackInputSchema = z.strictObject({
	beforeProtected: z.unknown(),
	afterProtected: z.unknown(),
	beforeAudit: z.unknown(),
	afterAudit: z.unknown(),
	attributableActors: z.array(z.string()),
	forbiddenValues: z.array(z.string()),
});
describe.each(['d1-workerd', 'better-sqlite3'] as const)(
	'management refusal readback on %s',
	(leg) => {
		let host: StorageTestHost;
		beforeAll(async () => {
			host = await createStorageTestHost(leg);
		});
		afterAll(async () => {
			await host?.close();
		});
		it('detects a real stored-secret-only update through the production proof projection', async () => {
			const input = readbackInputSchema.parse(
				await host.runCommand({ kind: 'management-readback', scenario: 'stored-secret-only' }),
			);
			expect(() => requireManagementRefusalReadback(input)).toThrow('Protected');
		});
		it('accepts a real appended attributable refusal while keeping the stored credential intact', async () => {
			const input = readbackInputSchema.parse(
				await host.runCommand({ kind: 'management-readback', scenario: 'appended-refusal' }),
			);
			expect(() => requireManagementRefusalReadback(input)).not.toThrow();
		});
	},
);
