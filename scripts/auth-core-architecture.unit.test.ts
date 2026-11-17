import { describe, expect, it } from 'vitest';

import {
	collectAuthCoreViolations,
	collectPortalArchitectureViolations,
} from './audit-portal-architecture.js';

const signInPackages = [
	'sign-in-core',
	'sign-in-platform-web',
	'sign-in-host-cloudflare',
	'sign-in-owner-cli',
	'sign-in-test-support',
] as const;
const coreDriverImports = [
	'better-sqlite3',
	'better-sqlite3/lib/database',
	'drizzle-orm/d1',
	'drizzle-orm/d1/session',
	'drizzle-orm/better-sqlite3',
	'drizzle-orm/better-sqlite3/session',
	'node:sqlite',
] as const;
const driverSourceForms = coreDriverImports.flatMap((specifier) => [
	`import '${specifier}';`,
	`export * from '${specifier}';`,
	`export type Driver = typeof import('${specifier}');`,
	`const loadDriver = () => import('${specifier}');`,
	`const driver = require('${specifier}');`,
]);

describe('auth core dependency boundary', () => {
	it.each(driverSourceForms)(
		'rejects each SQLite driver import form in logic and the Better Auth boundary: %s',
		(sourceText) => {
			for (const filePath of [
				'packages/sign-in-core/src/storage/driver-import-control.ts',
				'packages/sign-in-core/src/better-auth/driver-import-control.ts',
			])
				expect(
					collectAuthCoreViolations({ filePath, sourceText }).some((violation) =>
						violation.includes('forbidden'),
					),
				).toBe(true);
		},
	);
	it.each(signInPackages)('applies the existing structure audit to %s', (packageName) => {
		const filePath = `packages/${packageName}/src/schemas/new-value-schema.ts`;
		expect(
			collectPortalArchitectureViolations({ files: [{ filePath, sourceText: '' }] }),
		).toContain(`${filePath}: new portal work must not use src/schemas`);
	});
	it.each(signInPackages)('prevents tool-access from depending on %s', (packageName) => {
		const filePath = 'packages/tool-access/src/contracts/sign-in-import-control.ts';
		const specifier = `@agent-collaboration/${packageName}`;
		expect(
			collectPortalArchitectureViolations({
				files: [
					{ filePath, sourceText: `export type Dependency = typeof import('${specifier}');` },
				],
			}),
		).toContain(`${filePath}: tool-access forbidden type import ${specifier}`);
	});
	it.each([
		"import { betterAuth } from 'better-auth';",
		"export * from '@better-auth/oauth-provider';",
		"export type Database = import('@cloudflare/workers-types').D1Database;",
		"import 'drizzle-orm/d1';",
		"const load = () => import('#sign-in-core/better-auth/provider-configuration');",
		"import { WorkerEntrypoint } from 'cloudflare:workers';",
		'export interface Store { database: D1Database }',
		"export type Database = AuthWorkerEnv['DB'];",
		"import '@agent-collaboration/sign-in-host-cloudflare/worker-configuration.gen';",
	])('rejects an auth core runtime dependency: %s', (sourceText) => {
		expect(
			collectAuthCoreViolations({
				filePath: 'packages/sign-in-core/src/client-policy.ts',
				sourceText,
			}).length,
		).toBeGreaterThan(0);
	});
	it('permits Web requests, parsed domain values and injected semantic ports', () => {
		expect(
			collectAuthCoreViolations({
				filePath: 'packages/sign-in-core/src/client-policy.ts',
				sourceText:
					"import { z } from 'zod'; export const answer = (request: Request): Response => Response.json({url:request.url});",
			}),
		).toEqual([]);
	});
	it('leaves the Better Auth adapter with its own runtime dependencies', () => {
		expect(
			collectAuthCoreViolations({
				filePath: 'packages/sign-in-core/src/better-auth/provider-configuration.ts',
				sourceText: "import { betterAuth } from 'better-auth';",
			}),
		).toEqual([]);
	});
});
