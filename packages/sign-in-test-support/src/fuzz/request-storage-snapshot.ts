import { createHash } from 'node:crypto';

import { signInSchema, type SignInDatabase } from '@agent-collaboration/sign-in-core';
import { z } from 'zod';

import { storedRowProjection } from '#sign-in-test-support/test-fixtures/stored-row-projection';

export type StoredRow = Readonly<Record<string, unknown>>;
export type RequestStorageSnapshot = Readonly<Record<string, readonly StoredRow[]>>;

/** Read every table, including credential and fence rows, without retaining private receipts in Git. */
export async function readRequestStorageSnapshot(
	database: SignInDatabase,
): Promise<RequestStorageSnapshot> {
	const entries = await Promise.all(
		Object.entries(signInSchema).map(async ([name, table]) => {
			const rows = z
				.array(z.record(z.string(), z.unknown()))
				.parse(await database.select(storedRowProjection(table)).from(table));
			return [
				name,
				rows.toSorted((left, right) => rowBytes(left).localeCompare(rowBytes(right))),
			] as const;
		}),
	);
	return Object.fromEntries(entries);
}

export function rowBytes(row: StoredRow): string {
	return JSON.stringify(
		Object.fromEntries(
			Object.entries(row).toSorted(([left], [right]) => left.localeCompare(right)),
		),
	);
}

/** Failures name only the changed table; assertions must never print stored credentials. */
export function snapshotDigest(snapshot: unknown): string {
	return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

export function rowsAdded(props: {
	readonly before: readonly StoredRow[];
	readonly after: readonly StoredRow[];
}): readonly StoredRow[] {
	const before = new Set(props.before.map(rowBytes));
	return props.after.filter((row) => !before.has(rowBytes(row)));
}

export function storedCredentials(snapshot: RequestStorageSnapshot): readonly string[] {
	const columns = new Set([
		'token',
		'accessToken',
		'refreshToken',
		'idToken',
		'clientSecret',
		'password',
		'privateKey',
		'secret',
		'backupCodes',
	]);
	return Object.values(snapshot).flatMap((rows) =>
		rows.flatMap((row) =>
			Object.entries(row).flatMap(([column, value]) =>
				columns.has(column) && typeof value === 'string' && value.length > 0 ? [value] : [],
			),
		),
	);
}
