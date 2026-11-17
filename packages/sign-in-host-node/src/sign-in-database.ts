import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	signInSchema,
	type AtomicRunner,
	type SignInDatabaseFactory,
} from '@agent-collaboration/sign-in-core';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { Logger } from 'drizzle-orm/logger';
import { z } from 'zod';

export interface NodeSignInDatabase {
	readonly openDatabase: SignInDatabaseFactory;
	readonly runAtomically: AtomicRunner;
	readonly close: () => void;
}

export type OpenNodeSignInDatabaseResult =
	| { readonly kind: 'available'; readonly database: NodeSignInDatabase }
	| { readonly kind: 'unavailable'; readonly reason: 'database-error' };

/** Migration succeeds before any store or provider can use the database. */
export async function openNodeSignInDatabase(props: {
	readonly stateDirectory: string;
	readonly migrationsFolder?: string;
	readonly logger?: Logger;
}): Promise<OpenNodeSignInDatabaseResult> {
	let nativeDatabase: Database.Database | undefined;
	try {
		await mkdir(props.stateDirectory, { recursive: true, mode: 0o700 });
		nativeDatabase = new Database(path.join(props.stateDirectory, 'sign-in.sqlite'));
		const connection = nativeDatabase;
		const openDatabase: SignInDatabaseFactory = () =>
			drizzle(connection, {
				schema: signInSchema,
				...(props.logger === undefined ? {} : { logger: props.logger }),
			});
		migrate(drizzle(connection), {
			migrationsFolder:
				props.migrationsFolder ??
				fileURLToPath(
					new URL('../drizzle/', import.meta.resolve('@agent-collaboration/sign-in-core')),
				),
		});
		const runAtomically: AtomicRunner = async (statements) => {
			try {
				const execute = connection.transaction(() =>
					statements.map((statement) => z.array(z.unknown()).parse(statement.all())),
				);
				return { kind: 'committed', rows: execute.immediate() };
			} catch {
				return { kind: 'failed', reason: 'database-error' };
			}
		};
		return {
			kind: 'available',
			database: { openDatabase, runAtomically, close: () => connection.close() },
		};
	} catch {
		nativeDatabase?.close();
		return { kind: 'unavailable', reason: 'database-error' };
	}
}
