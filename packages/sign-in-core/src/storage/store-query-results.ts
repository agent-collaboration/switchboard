import type { z } from 'zod';

import type {
	SignInStoreFailure,
	SignInStoreResult,
} from '#sign-in-core/storage/models/sign-in-database';

export function storeFailure(error: unknown): SignInStoreFailure {
	let cause: unknown = error;
	while (cause instanceof Error) {
		if (cause instanceof SyntaxError)
			return { kind: 'store-unavailable', reason: 'row-unparseable' };
		if (/no such table/iu.test(cause.message))
			return { kind: 'store-unavailable', reason: 'migration-incomplete' };
		cause = cause.cause;
	}
	return { kind: 'store-unavailable', reason: 'database-error' };
}

export function availableStoreValue<TValue>(value: TValue): SignInStoreResult<TValue> {
	return { kind: 'available', value };
}

export async function readStoreValue<TValue>(
	read: () => Promise<unknown>,
	schema: z.ZodType<TValue>,
): Promise<SignInStoreResult<TValue>> {
	try {
		const parsed = schema.safeParse(await read());
		return parsed.success
			? { kind: 'available', value: parsed.data }
			: { kind: 'store-unavailable', reason: 'row-unparseable' };
	} catch (error) {
		return storeFailure(error);
	}
}
