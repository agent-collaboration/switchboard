import { sql } from 'drizzle-orm';
import { z } from 'zod';

import type { StorageCaseContext } from '#sign-in-test-support/storage-cases/storage-case-context';

const schemaEntry = z.strictObject({
	type: z.string(),
	name: z.string(),
	table: z.string(),
	sql: z.string().nullable(),
});
const columnEntry = z.strictObject({
	position: z.number().int(),
	name: z.string(),
	type: z.string(),
	notNull: z.number().int(),
	defaultValue: z.string().nullable(),
	primaryKey: z.number().int(),
});
const foreignKeyEntry = z.strictObject({
	id: z.number().int(),
	sequence: z.number().int(),
	table: z.string(),
	from: z.string(),
	to: z.string(),
	onUpdate: z.string(),
	onDelete: z.string(),
	match: z.string(),
});
const indexEntry = z.strictObject({
	name: z.string(),
	unique: z.number().int(),
	origin: z.string(),
	partial: z.number().int(),
});
const indexReadback = indexEntry.extend({ columns: z.array(z.string()) });

export const schemaReadbackSchema = z.strictObject({
	entries: z.array(schemaEntry),
	tables: z.array(
		z.strictObject({
			name: z.string(),
			columns: z.array(columnEntry),
			foreignKeys: z.array(foreignKeyEntry),
			indexes: z.array(indexReadback),
		}),
	),
});
export type SchemaReadback = z.infer<typeof schemaReadbackSchema>;

function catalogFailure(error: unknown): Error {
	const messages: string[] = [];
	let current: unknown = error;
	for (let depth = 0; depth < 6; depth += 1) {
		const cause = z
			.object({ message: z.string(), cause: z.unknown().optional() })
			.safeParse(current);
		if (!cause.success) break;
		messages.push(cause.data.message.split('\nparams:')[0] ?? 'Catalog query rejected');
		current = cause.data.cause;
	}
	// This path has only catalog/table-name parameters, never application rows or credentials.
	return new Error('Catalog query: ' + messages.join(' | '));
}

/** Reads the database's own catalog through ordinary Drizzle SELECT builders.
 * No second schema, authored DDL or migration statement splitter is executed. */
export async function readStorageSchema(
	context: StorageCaseContext,
	details: 'catalog' | 'metadata',
): Promise<SchemaReadback> {
	const entries = z.array(schemaEntry).parse(
		await context
			.openDatabase()
			.select({
				type: sql<string>`type`,
				name: sql<string>`name`,
				table: sql<string>`tbl_name`,
				sql: sql<string | null>`sql`,
			})
			.from(sql`sqlite_schema`)
			.orderBy(sql`type`, sql`name`),
	);
	const tables = await Promise.all(
		entries
			.filter((entry) => entry.type === 'table')
			.map(async (entry) => {
				// D1 forbids the table-valued PRAGMA functions (SQLITE_AUTH). Its
				// actual catalog DDL is compared byte-for-byte with the Node catalog;
				// Node supplies the detailed metadata, and both legs prove constraints
				// with real writes. No driver SQL bypass is used for introspection.
				if (details === 'catalog')
					return { name: entry.name, columns: [], foreignKeys: [], indexes: [] };
				const [columns, foreignKeys, indexes] = await Promise.all([
					context
						.openDatabase()
						.select({
							position: sql<number>`cid`,
							name: sql<string>`name`,
							type: sql<string>`type`,
							notNull: sql<number>`"notnull"`,
							defaultValue: sql<string | null>`dflt_value`,
							primaryKey: sql<number>`pk`,
						})
						.from(sql`pragma_table_info(${entry.name})`)
						.orderBy(sql`cid`),
					context
						.openDatabase()
						.select({
							id: sql<number>`id`,
							sequence: sql<number>`seq`,
							table: sql<string>`"table"`,
							from: sql<string>`"from"`,
							to: sql<string>`"to"`,
							onUpdate: sql<string>`on_update`,
							onDelete: sql<string>`on_delete`,
							match: sql<string>`match`,
						})
						.from(sql`pragma_foreign_key_list(${entry.name})`)
						.orderBy(sql`id`, sql`seq`),
					context
						.openDatabase()
						.select({
							name: sql<string>`name`,
							unique: sql<number>`"unique"`,
							origin: sql<string>`origin`,
							partial: sql<number>`partial`,
						})
						.from(sql`pragma_index_list(${entry.name})`)
						.orderBy(sql`name`),
				]);
				const indexColumns = await Promise.all(
					z
						.array(indexEntry)
						.parse(indexes)
						.map(async (index) => ({
							name: index.name,
							unique: index.unique,
							origin: index.origin,
							partial: index.partial,
							columns: z
								.array(z.object({ name: z.string() }))
								.parse(
									await context
										.openDatabase()
										.select({ name: sql<string>`name` })
										.from(sql`pragma_index_info(${index.name})`)
										.orderBy(sql`seqno`),
								)
								.map((column) => column.name),
						})),
				);
				return {
					name: entry.name,
					columns: z.array(columnEntry).parse(columns),
					foreignKeys: z.array(foreignKeyEntry).parse(foreignKeys),
					indexes: indexColumns,
				};
			}),
	).catch((error: unknown) => {
		throw catalogFailure(error);
	});
	return { entries, tables };
}
