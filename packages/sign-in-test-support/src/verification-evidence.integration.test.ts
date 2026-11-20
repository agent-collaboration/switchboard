import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, it } from 'vitest';

import {
	cleanupSuccessfulEvidence,
	type VerificationReport,
} from '../../../scripts/verify-auth/verification-runner';

it.each([true, false])(
	'keeps only the compact report on success=%s, preserving unrelated files',
	async (success): Promise<void> => {
		const parent = await mkdtemp(path.join(tmpdir(), 'verify-evidence-retention-'));
		try {
			const evidence = path.join(parent, 'evidence');
			await mkdir(path.join(evidence, 'logs'), { recursive: true });
			await mkdir(path.join(evidence, 't', 'browser'), { recursive: true });
			await writeFile(path.join(evidence, 'logs', 'command.log'), 'raw command diagnostic');
			await writeFile(
				path.join(evidence, 't', 'browser', 'chrome.stderr.log'),
				'raw browser diagnostic',
			);
			await writeFile(
				path.join(evidence, 't', 'browser', 'failure-state.png'),
				'raw browser artifact',
			);
			await writeFile(path.join(parent, 'outside.txt'), 'unrelated');
			const report: VerificationReport = {
				commit: 'a'.repeat(40),
				chrome: 'fixture',
				requested: { flows: ['cli-sign-in'], checks: [] },
				evidence,
				problems: success ? [] : ['failed'],
				rows: [
					{
						id: 'cli-sign-in',
						host: 'node',
						commit: 'a'.repeat(40),
						tests: { passed: 1, failed: 0, skipped: 0, names: ['delivered CLI'] },
						verdict: { kind: 'passed' },
						restored: null,
						remaining: [],
						leftAtExit: [],
						cleanup: 'natural',
					},
				],
			};
			const compact = JSON.stringify(report);
			await writeFile(path.join(evidence, 'report.json'), compact);

			await cleanupSuccessfulEvidence(report);

			expect((await readdir(evidence)).sort()).toEqual(
				success ? ['report.json'] : ['logs', 'report.json', 't'],
			);
			expect(await readFile(path.join(evidence, 'report.json'), 'utf8')).toBe(compact);
			expect(await readFile(path.join(parent, 'outside.txt'), 'utf8')).toBe('unrelated');
			if (!success)
				expect(
					await readFile(path.join(evidence, 't', 'browser', 'chrome.stderr.log'), 'utf8'),
				).toBe('raw browser diagnostic');
		} finally {
			await rm(parent, { recursive: true });
		}
	},
);
