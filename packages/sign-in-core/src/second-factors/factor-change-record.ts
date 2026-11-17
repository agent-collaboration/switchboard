import { z } from 'zod';

import { uuid7Schema } from '#sign-in-core/contracts/sign-in-platform';
import type { SignInStoreResult } from '#sign-in-core/storage/models/sign-in-database';
import { personIdSchema } from '#sign-in-core/storage/models/sign-in-store';

export const factorChangeActionSchema = z.enum([
	'app-enrollment-started',
	'app-confirmed',
	'recovery-code-used',
	'recovery-codes-rotated',
	'passkey-added',
	'passkey-renamed',
	'passkey-removed',
	'app-removed',
	'passkey-confirmed',
]);
export const factorChangeSchema = z.strictObject({
	requestId: uuid7Schema,
	actorPersonId: personIdSchema,
	action: factorChangeActionSchema,
	targetId: uuid7Schema,
});
export type FactorChangeRecord = z.infer<typeof factorChangeSchema>;
export interface FactorChangeRecords {
	readonly record: (
		change: FactorChangeRecord,
		phase: 'intent' | 'outcome',
	) => Promise<SignInStoreResult<void>>;
}
