import type { Where } from 'better-auth/adapters';
import {
	and,
	eq,
	gt,
	gte,
	inArray,
	isNotNull,
	isNull,
	like,
	lt,
	lte,
	ne,
	notInArray,
	or,
	type SQL,
} from 'drizzle-orm';
import { SQLiteColumn } from 'drizzle-orm/sqlite-core';

import { fencedTable, type FencedModel } from '#sign-in-core/storage/authorization-fence-mutations';

/** Native where-clauses as SQL, matching the pinned Drizzle adapter's AND-group / OR-group semantics. */
export function fencedPredicate(model: FencedModel, selectors: readonly Where[]): SQL | undefined {
	const columns = fencedTable(model);
	function comparison(selector: Where): SQL {
		const entry = Object.entries(columns).find(([name]) => name === selector.field)?.[1];
		if (!(entry instanceof SQLiteColumn))
			throw new Error(`Unknown ${model} field ${selector.field}`);
		// These native models have UUID ids and exact role selectors. Refuse unsupported
		// comparison modes rather than silently weakening a caller's predicate.
		if (selector.mode === 'insensitive')
			throw new Error('Fenced models do not accept insensitive selectors');
		const value = selector.value;
		switch (selector.operator ?? 'eq') {
			case 'eq':
				return value === null ? isNull(entry) : eq(entry, value);
			case 'ne':
				return value === null ? isNotNull(entry) : ne(entry, value);
			case 'gt':
				return gt(entry, value);
			case 'gte':
				return gte(entry, value);
			case 'lt':
				return lt(entry, value);
			case 'lte':
				return lte(entry, value);
			case 'in':
				if (!Array.isArray(value)) throw new Error('Array selector required');
				return inArray(entry, value);
			case 'not_in':
				if (!Array.isArray(value)) throw new Error('Array selector required');
				return notInArray(entry, value);
			case 'contains':
				return like(entry, `%${String(value)}%`);
			case 'starts_with':
				return like(entry, `${String(value)}%`);
			case 'ends_with':
				return like(entry, `%${String(value)}`);
		}
	}
	const conjunctions = selectors.filter((selector) => selector.connector !== 'OR').map(comparison);
	const alternatives = selectors.filter((selector) => selector.connector === 'OR').map(comparison);
	return and(
		conjunctions.length === 0 ? undefined : and(...conjunctions),
		alternatives.length === 0 ? undefined : or(...alternatives),
	);
}
