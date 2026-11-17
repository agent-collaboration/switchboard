import { z } from 'zod';

import type { AtomicRunOutcome } from '#sign-in-core/contracts/sign-in-platform';
import type { SignInStoreResult } from '#sign-in-core/storage/models/sign-in-database';

export function atomicStoreRows<TValue>(
	outcome: AtomicRunOutcome,
	index: number,
	schema: z.ZodType<TValue>,
): SignInStoreResult<readonly TValue[]> {
	if (outcome.kind === 'failed') return { kind: 'store-unavailable', reason: 'database-error' };
	const parsed = z.array(schema).safeParse(outcome.rows[index]);
	return parsed.success
		? { kind: 'available', value: parsed.data }
		: { kind: 'store-unavailable', reason: 'row-unparseable' };
}
