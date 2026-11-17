import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { runAuthProofProcess } from '#sign-in-test-support/test-fixtures/auth-proof-process';
import {
	requireMatchingAuthObservations,
	revisionFenceSupportingUnitFiles,
	type OfferedAuthTest,
} from '#sign-in-test-support/test-fixtures/auth-verification-journeys';

/** Isolated release deadlines are unit vectors; they never count as host observations. */
export async function runSupportingAuthUnitProof(props: {
	readonly root: string;
	readonly evidence: string;
	readonly vitest: string;
	readonly selected: readonly OfferedAuthTest[];
}): Promise<number> {
	const reportFile = path.join(props.evidence, 'supporting-unit-vitest.json');
	const runtime = await runAuthProofProcess({
		command: process.execPath,
		args: [
			props.vitest,
			'run',
			'--project',
			'unit',
			...revisionFenceSupportingUnitFiles,
			'--reporter=json',
			`--outputFile=${reportFile}`,
		],
		cwd: props.root,
		env: { ...process.env },
	});
	await writeFile(
		path.join(props.evidence, 'supporting-unit-runtime.log'),
		runtime.stdout + runtime.stderr,
		{ mode: 0o600 },
	);
	await writeFile(
		path.join(props.evidence, 'supporting-unit-process.json'),
		JSON.stringify({
			ending: runtime.ending,
			processGroup: runtime.processGroup,
			cleanup: runtime.cleanup,
		}),
		{ mode: 0o600 },
	);
	if (
		runtime.ending.kind !== 'exited' ||
		runtime.ending.code !== 0 ||
		runtime.cleanup.remainingMembers.length !== 0
	)
		throw new Error('Supporting release units or their process cleanup failed');
	const report = z
		.object({
			success: z.literal(true),
			numPassedTests: z.number().positive(),
			numFailedTests: z.literal(0),
			numPendingTests: z.literal(0),
			testResults: z.array(
				z.object({
					name: z.string(),
					assertionResults: z.array(
						z.object({
							title: z.string(),
							ancestorTitles: z.array(z.string()),
							status: z.literal('passed'),
						}),
					),
				}),
			),
		})
		.parse(JSON.parse(await readFile(reportFile, 'utf8')));
	const actual = report.testResults.flatMap((file) =>
		file.assertionResults.map((test) => ({
			file: file.name,
			name: [...test.ancestorTitles, test.title].join(' > '),
		})),
	);
	requireMatchingAuthObservations({
		selected: props.selected,
		actual,
		passedCount: report.numPassedTests,
		root: props.root,
	});
	return report.numPassedTests;
}
