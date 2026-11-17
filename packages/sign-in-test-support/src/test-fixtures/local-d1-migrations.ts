import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

export const localSignInDatabaseId = '00000000-0000-7000-8000-000000000001';

/** Wrangler applies the checked-in migrations before the test Worker can serve. */
export async function applyLocalSignInMigrations(props: {
	readonly repositoryRoot: string;
	readonly runtimeDirectory: string;
	readonly migrationsFolder?: string;
}): Promise<string> {
	const configPath = path.join(props.runtimeDirectory, 'wrangler.json');
	const persistRoot = path.join(props.runtimeDirectory, 'state');
	await writeFile(
		configPath,
		JSON.stringify({
			name: 'sign-in-storage-proof',
			compatibility_date: '2026-08-15',
			d1_databases: [
				{
					binding: 'DB',
					database_name: 'sign-in-proof',
					database_id: localSignInDatabaseId,
					migrations_dir:
						props.migrationsFolder ??
						path.join(props.repositoryRoot, 'packages/sign-in-core/drizzle'),
				},
			],
		}),
		{ mode: 0o600 },
	);
	try {
		const result = await promisify(execFile)(
			process.execPath,
			[
				path.join(
					props.repositoryRoot,
					'packages/sign-in-test-support/node_modules/wrangler/bin/wrangler.js',
				),
				'd1',
				'migrations',
				'apply',
				'DB',
				'--local',
				'--persist-to',
				persistRoot,
				'--config',
				configPath,
			],
			{
				cwd: props.repositoryRoot,
				env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' },
				maxBuffer: 4 * 1024 * 1024,
			},
		);
		await writeFile(
			path.join(props.runtimeDirectory, 'migration-apply.log'),
			result.stdout + result.stderr + '\nEXIT_CODE=0\n',
			{ mode: 0o600 },
		);
	} catch (error) {
		await writeFile(path.join(props.runtimeDirectory, 'migration-apply-error.log'), String(error), {
			mode: 0o600,
		});
		throw error;
	}
	// Pinned Wrangler's getLocalPersistencePath/executeLocally append v3; Miniflare's
	// resourcePersistencePath is that parent and it appends d1. Both use this exact file.
	return path.join(persistRoot, 'v3');
}
