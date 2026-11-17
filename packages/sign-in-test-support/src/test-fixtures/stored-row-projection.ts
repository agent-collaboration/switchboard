import { getTableColumns, sql, type SQL } from 'drizzle-orm';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';

/** Keeps database byte/value readbacks independent of Drizzle's JSON/date decoding. */
export function storedRowProjection(table: SQLiteTable): Readonly<Record<string, SQL>> {
	return Object.fromEntries(
		Object.values(getTableColumns(table)).map((column) => [column.name, sql`${column}`]),
	);
}
