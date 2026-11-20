import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { buildStorageProofApplication } from '#sign-in-test-support/storage-cases/storage-proof-application';
import { controlledWorkerDateScript } from '#sign-in-test-support/test-fixtures/controlled-sign-in-clock';
import { proofModuleHashes } from '#sign-in-test-support/test-fixtures/proof-bundle-artifacts';
import {
	clockedWorkerManifest,
	proofStartupModuleSource,
} from '#sign-in-test-support/test-fixtures/worker-module-manifest';

/** The organization record cases execute a separate component Worker, not the HTTP proof wrapper. */
export async function prepareOrganizationStorageProof(
	root: string,
	evidence: string,
): Promise<Readonly<Record<string, string>>> {
	const application = await buildStorageProofApplication(root);
	await writeFile(path.join(evidence, 'organization-storage-application.mjs'), application, {
		mode: 0o600,
	});
	return proofModuleHashes(
		clockedWorkerManifest({
			kind: 'storage-proof',
			startup: proofStartupModuleSource,
			application,
			clock: controlledWorkerDateScript(),
		}),
	);
}

function moduleIdentity(modules: Readonly<Record<string, string>>): string {
	return JSON.stringify(
		Object.entries(modules).toSorted(([left], [right]) => left.localeCompare(right)),
	);
}

/** Compare every actual storage owner against the separately frozen three-module map. */
export function requireOrganizationStorageProof(
	stdout: string,
	expected: Readonly<Record<string, string>>,
): readonly Readonly<Record<string, string>>[] {
	const marker = z.object({ event: z.literal('storage-worker-modules') });
	const receipt = marker.extend({
		moduleHashes: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/u)),
	});
	const actual = stdout.split('\n').flatMap((line): Readonly<Record<string, string>>[] => {
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			return [];
		}
		return marker.safeParse(value).success ? [receipt.parse(value).moduleHashes] : [];
	});
	if (
		actual.length === 0 ||
		actual.some((modules) => moduleIdentity(modules) !== moduleIdentity(expected))
	)
		throw new Error('Organization storage Worker modules differ from the frozen component');
	return actual;
}
