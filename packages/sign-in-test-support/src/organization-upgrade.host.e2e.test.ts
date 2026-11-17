import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { expect, it } from 'vitest';
import { z } from 'zod';

import { createStorageTestHost } from '#sign-in-test-support/storage-cases/dual-storage-test-host';
import { schemaReadbackSchema } from '#sign-in-test-support/storage-cases/schema-readback';
import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import { retiredAdmissionTables } from '#sign-in-test-support/test-fixtures/organization-schema-expectations';

useControlledSignInClock();

it('people: commits the exact owner-approved organization migration', async () => {
	const bytes = await readFile(
		new URL('../../sign-in-core/drizzle/0001_organization_access.sql', import.meta.url),
	);
	expect(createHash('sha256').update(bytes).digest('hex')).toBe(
		'7aab738055ad0d8d58b2dcaca37ce886566d8741124dcb7a25d86ff2df8897a3',
	);
});

it.each(['d1-workerd', 'better-sqlite3'] as const)(
	'people: upgrades seeded main rows through the production %s migrator without inventing membership',
	async (leg) => {
		const host = await createStorageTestHost(leg, 'baseline');
		try {
			const beforeCatalog = schemaReadbackSchema.parse(
				await host.runCommand({ kind: 'schema-readback', details: 'catalog' }),
			);
			for (const table of retiredAdmissionTables)
				expect(beforeCatalog.tables.some((candidate) => candidate.name === table)).toBe(true);
			const before = await host.runCommand({ kind: 'seed-baseline' });
			await host.upgrade();
			expect(await host.runCommand({ kind: 'read-upgrade' })).toEqual(before);
			const additions = z
				.object({
					organizations: z.array(z.unknown()).length(0),
					factors: z.array(z.unknown()).length(0),
					memberships: z.array(z.unknown()).length(0),
					invitations: z.array(z.unknown()).length(0),
					sessions: z.array(
						z.object({
							activeOrganizationId: z.null(),
							secondFactorAt: z.null(),
							secondFactorMethod: z.null(),
						}),
					),
					audit: z.array(z.object({ organizationId: z.null() })),
					verifiedPeople: z.array(
						z.object({
							id: z.uuidv7(),
							emailVerified: z.literal(true),
							twoFactorEnabled: z.literal(false),
							secondFactorSetAt: z.null(),
						}),
					),
				})
				.parse(await host.runCommand({ kind: 'upgrade-additions' }));
			expect(additions.sessions).toHaveLength(1);
			expect(additions.audit).toHaveLength(1);
			expect(additions.verifiedPeople).toHaveLength(1);
			const afterCatalog = schemaReadbackSchema.parse(
				await host.runCommand({ kind: 'schema-readback', details: 'catalog' }),
			);
			for (const table of retiredAdmissionTables)
				expect(afterCatalog.tables.some((candidate) => candidate.name === table)).toBe(false);
			// No request or historical claim is used to seed the new organization tables.
			expect(await host.runCommand({ kind: 'upgrade-additions' })).toEqual(additions);
			await host.restart();
			expect(await host.runCommand({ kind: 'read-upgrade' })).toEqual(before);
		} finally {
			await host.close();
		}
	},
);

it('people: commits the exact approved second-factor migration', async () => {
	const bytes = await readFile(
		new URL('../../sign-in-core/drizzle/0002_second_factors.sql', import.meta.url),
	);
	expect(createHash('sha256').update(bytes).digest('hex')).toBe(
		'755982dd980fb3d95283b037bf03102ba78e1ab74d8b3bbcf052573b6625bad2',
	);
});
