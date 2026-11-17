import path from 'node:path';

import {
	signInSchema,
	type AtomicRunner,
	type SignInDatabase,
} from '@agent-collaboration/sign-in-core';
import { openNodeSignInDatabase } from '@agent-collaboration/sign-in-host-node';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { z } from 'zod';

import {
	createStorageCaseContext,
	type StorageCaseContext,
} from '#sign-in-test-support/storage-cases/storage-case-context';
import { matchesDatabaseFault } from '#sign-in-test-support/test-fixtures/database-fault-identity';

const noInjectedFault: StorageCaseContext['readFault'] = () => null;

export async function openSqliteStorageTestHost(props: {
	readonly databaseFile: string;
	readonly migrationsFolder: string;
	readonly migrateBeforeServing: boolean;
}): Promise<{
	readonly context: StorageCaseContext;
	readonly database: SignInDatabase;
	readonly close: () => void;
}> {
	let readFault: StorageCaseContext['readFault'] = noInjectedFault;
	let startReadInterleaving: StorageCaseContext['startReadInterleaving'] = () => null;
	const logger = {
		logQuery(query: string, parameters: unknown[]): void {
			// better-sqlite3 runs this read synchronously right after this hook, inside any open
			// transaction; the first moment another writer can run is the next microtask.
			queueMicrotask((): void => {
				void startReadInterleaving(query);
			});
			const fault = readFault();
			if (
				fault !== null &&
				fault !== undefined &&
				matchesDatabaseFault({ query, parameters }, fault)
			)
				throw new Error('Injected SQLite driver failure');
		},
	};
	if (props.migrateBeforeServing) {
		const opened = await openNodeSignInDatabase({
			stateDirectory: path.dirname(props.databaseFile),
			migrationsFolder: props.migrationsFolder,
			logger,
		});
		if (opened.kind !== 'available') throw new Error('Production Node storage startup failed');
		const context = createStorageCaseContext({
			openDatabase: opened.database.openDatabase,
			runAtomically: opened.database.runAtomically,
			faultInjection: 'driver',
		});
		readFault = context.readFault;
		startReadInterleaving = context.startReadInterleaving;
		return { context, database: opened.database.openDatabase(), close: opened.database.close };
	}
	// The negative migration-incomplete case deliberately bypasses serving startup.
	// Its runner is not part of the production atomicity evidence.
	const nativeDatabase = new Database(props.databaseFile);
	const database = drizzle(nativeDatabase, { schema: signInSchema, logger });
	const runAtomically: AtomicRunner = async (group) => {
		try {
			const execute = nativeDatabase.transaction(() =>
				group.map((statement) => z.array(z.unknown()).parse(statement.all())),
			);
			return { kind: 'committed', rows: execute.immediate() };
		} catch {
			return { kind: 'failed', reason: 'database-error' };
		}
	};
	const context = createStorageCaseContext({ openDatabase: () => database, runAtomically });
	readFault = context.readFault;
	return { context, database, close: () => nativeDatabase.close() };
}
