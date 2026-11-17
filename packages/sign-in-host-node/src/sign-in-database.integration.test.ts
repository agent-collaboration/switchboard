import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { organization, epochMillisecondsSchema } from '@agent-collaboration/sign-in-core';
import { createWebSignInCapabilities } from '@agent-collaboration/sign-in-platform-web';
import { afterAll, expect, it, vi } from 'vitest';

import { openNodeSignInDatabase } from '#sign-in-host-node/sign-in-database';

vi.useFakeTimers({ toFake: ['Date'] });
vi.setSystemTime(2_208_988_800_000);
afterAll(() => vi.useRealTimers());

it('rolls back statement one when statement two is rejected by SQLite, then persists a successful retry across reopening', async () => {
	const stateDirectory = await mkdtemp(path.join(tmpdir(), '2026-10-sign-in-node-storage-'));
	const opened = await openNodeSignInDatabase({ stateDirectory });
	if (opened.kind !== 'available') throw new Error('Database setup failed');
	try {
		const database = opened.database.openDatabase();
		const platform = createWebSignInCapabilities({
			now: () => epochMillisecondsSchema.parse(2_208_988_800_000),
		});
		const row = {
			id: platform.ids.nextId(),
			name: 'Atomic proof',
			slug: 'atomic-proof',
			createdAt: new Date(platform.clock.now()),
		};
		const rejected = await opened.database.runAtomically([
			database.insert(organization).values(row).returning(),
			database.insert(organization).values(row).returning(),
		]);
		expect(rejected).toEqual({ kind: 'failed', reason: 'database-error' });
		expect(await opened.database.openDatabase().select().from(organization)).toEqual([]);
		const committed = await opened.database.runAtomically([
			database.insert(organization).values(row).returning(),
		]);
		expect(committed.kind).toBe('committed');
	} finally {
		opened.database.close();
	}
	const reopened = await openNodeSignInDatabase({ stateDirectory });
	if (reopened.kind !== 'available') throw new Error('Database reopen failed');
	try {
		expect(
			await reopened.database.openDatabase().select({ slug: organization.slug }).from(organization),
		).toEqual([{ slug: 'atomic-proof' }]);
	} finally {
		reopened.database.close();
	}
});

it('returns an unavailable result when the startup migration cannot be read', async () => {
	const stateDirectory = await mkdtemp(path.join(tmpdir(), '2026-10-sign-in-node-migration-'));
	expect(
		await openNodeSignInDatabase({
			stateDirectory,
			migrationsFolder: path.join(stateDirectory, 'missing-migrations'),
		}),
	).toEqual({ kind: 'unavailable', reason: 'database-error' });
});
