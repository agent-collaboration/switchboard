import { signInSchema, type SignInDatabase } from '@agent-collaboration/sign-in-core';
import { getTableName } from 'drizzle-orm';
import { z } from 'zod';

import { storedRowProjection } from '#sign-in-test-support/test-fixtures/stored-row-projection';

export interface StoredUuidInventory {
	readonly uuidValues: number;
	readonly nonV7Locations: readonly {
		readonly table: string;
		readonly column: string;
		readonly version: string;
		readonly reason: 'wrong-version' | 'invalid-variant';
	}[];
}
export function inspectUuidCells(
	table: string,
	rows: readonly Readonly<Record<string, unknown>>[],
): StoredUuidInventory {
	let uuidValues = 0;
	const nonV7Locations: {
		readonly table: string;
		readonly column: string;
		readonly version: string;
		readonly reason: 'wrong-version' | 'invalid-variant';
	}[] = [];
	for (const row of rows) {
		for (const [column, value] of Object.entries(row)) {
			if (typeof value !== 'string') continue;
			// Inspect every text cell, including identifiers embedded in JSON/URLs,
			// without exporting the stored value or assuming which columns hold IDs.
			for (const match of value.matchAll(
				/[0-9a-f]{8}-[0-9a-f]{4}-([0-9a-f])[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}/giu,
			)) {
				uuidValues += 1;
				const version = match[1];
				if (version !== undefined && !z.uuidv7().safeParse(match[0]).success)
					nonV7Locations.push({
						table,
						column,
						version,
						reason: version === '7' ? 'invalid-variant' : 'wrong-version',
					});
			}
		}
	}
	return { uuidValues, nonV7Locations };
}
export async function readStoredUuidInventory(
	database: SignInDatabase,
): Promise<StoredUuidInventory> {
	const inventories = await Promise.all(
		Object.values(signInSchema).map(async (table) => {
			const rows = z
				.array(z.record(z.string(), z.unknown()))
				.parse(await database.select(storedRowProjection(table)).from(table));
			return inspectUuidCells(getTableName(table), rows);
		}),
	);
	return {
		uuidValues: inventories.reduce((count, inventory) => count + inventory.uuidValues, 0),
		nonV7Locations: inventories.flatMap((inventory) => inventory.nonV7Locations),
	};
}
