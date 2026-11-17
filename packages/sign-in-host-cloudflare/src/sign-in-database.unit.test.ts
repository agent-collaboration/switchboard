import { user } from '@agent-collaboration/sign-in-core';
import { expect, it } from 'vitest';

import { openSignInDatabase } from '#sign-in-host-cloudflare/sign-in-database';

function emptyResult<TValue>(): D1Result<TValue> {
	return {
		success: true,
		results: [],
		meta: {
			duration: 0,
			size_after: 0,
			rows_read: 0,
			rows_written: 0,
			last_row_id: 0,
			changed_db: false,
			changes: 0,
		},
	};
}
function emptyStatement(executions: string[]): D1PreparedStatement {
	function raw<TValue = unknown[]>(options: {
		columnNames: true;
	}): Promise<[string[], ...TValue[]]>;
	function raw<TValue = unknown[]>(options?: { columnNames?: false }): Promise<TValue[]>;
	async function raw(options?: { columnNames?: boolean }): Promise<unknown[]> {
		executions.push('raw');
		return options?.columnNames === true ? [[]] : [];
	}
	return {
		bind: () => emptyStatement(executions),
		first: async () => null,
		run: async <TValue>() => {
			executions.push('run');
			return emptyResult<TValue>();
		},
		all: async <TValue>() => {
			executions.push('all');
			return emptyResult<TValue>();
		},
		raw,
	};
}

it('each primary view sends queries and batches to its fresh session and never uses root-only methods', async () => {
	// Arrange: the root can open sessions, but cannot execute any query itself.
	const sessions: { queries: string[]; batches: number; executions: string[] }[] = [];
	const unexpectedRootCalls: string[] = [];
	const constraints: (D1SessionBookmark | undefined)[] = [];
	const binding = {
		prepare: () => {
			unexpectedRootCalls.push('prepare');
			return emptyStatement(unexpectedRootCalls);
		},
		batch: async <TValue>() => {
			unexpectedRootCalls.push('batch');
			return [emptyResult<TValue>()];
		},
		exec: async () => {
			unexpectedRootCalls.push('exec');
			return { count: 0, duration: 0 };
		},
		dump: async () => {
			unexpectedRootCalls.push('dump');
			return new ArrayBuffer(0);
		},
		withSession(constraint?: D1SessionBookmark): D1DatabaseSession {
			constraints.push(constraint);
			const recording: { queries: string[]; batches: number; executions: string[] } = {
				queries: [],
				batches: 0,
				executions: [],
			};
			sessions.push(recording);
			return {
				prepare(query) {
					recording.queries.push(query);
					return emptyStatement(recording.executions);
				},
				async batch<TValue>(statements: D1PreparedStatement[]): Promise<D1Result<TValue>[]> {
					recording.batches += 1;
					return statements.map(() => emptyResult<TValue>());
				},
				getBookmark: () => null,
			};
		},
	} satisfies AuthWorkerEnv['DB'];

	// Act: exercise the pinned driver's real query and batch paths on two views.
	await Promise.all(
		[0, 1].map(async () => {
			const database = openSignInDatabase(binding);
			const prepared = database.select({ id: user.id }).from(user).prepare();
			await Promise.all([prepared.run(), prepared.all(), prepared.get(), prepared.values()]);
			await database.batch([database.delete(user).returning({ id: user.id })]);
		}),
	);

	// Assert: a driver upgrade using any extra root method fails these assertions.
	expect(constraints).toEqual(['first-primary', 'first-primary']);
	expect(
		sessions.map(({ queries, batches }) => ({
			kinds: [...new Set(queries.map((query) => query.trim().split(/\s+/u)[0]))],
			batches,
		})),
	).toEqual([
		{ kinds: ['select', 'delete'], batches: 1 },
		{ kinds: ['select', 'delete'], batches: 1 },
	]);
	expect(sessions.map((recording) => recording.executions)).toEqual([
		['run', 'raw', 'raw', 'raw'],
		['run', 'raw', 'raw', 'raw'],
	]);
	expect(unexpectedRootCalls).toEqual([]);
});
