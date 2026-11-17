import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';

import type { signInSchema } from '#sign-in-core/storage/sign-in-schema';

export type SignInDatabase = BaseSQLiteDatabase<'sync' | 'async', unknown, typeof signInSchema>;
export type SignInDatabaseFactory = () => SignInDatabase;

export type SignInStoreFailure = {
	readonly kind: 'store-unavailable';
	readonly reason: 'database-error' | 'migration-incomplete' | 'row-unparseable';
};

export type SignInStoreResult<TValue> =
	| { readonly kind: 'available'; readonly value: TValue }
	| SignInStoreFailure;
