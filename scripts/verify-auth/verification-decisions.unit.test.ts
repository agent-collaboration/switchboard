import { expect, it } from 'vitest';

import {
	decideRestoration,
	decideSecurityCheck,
	decideTestRun,
	renderReport,
	replaceExact,
	reportPassed,
	testReportSchema,
	type DecidingFacts,
	type TestReport,
} from './verification-decisions';

const file = 'packages/example/guard.host.e2e.test.ts';
function report(
	props: {
		readonly passed?: number;
		readonly failed?: number;
		readonly message?: string;
		readonly status?: 'passed' | 'failed' | 'pending';
		readonly file?: string;
	} = {},
): TestReport {
	const passed = props.passed ?? 1;
	const failures = props.failed ?? 0;
	return {
		success: failures === 0,
		numPassedTests: passed,
		numFailedTests: failures,
		numPendingTests: props.status === 'pending' ? 1 : 0,
		numFailedTestSuites: failures > 0 ? 1 : 0,
		testResults: [
			{
				name: props.file ?? file,
				message: '',
				assertionResults: Array.from({ length: passed + failures || 1 }, (_, index) => ({
					title: 'guard refuses removed member',
					ancestorTitles: [],
					status: props.status ?? (index < passed ? 'passed' : 'failed'),
					failureMessages:
						index < passed
							? []
							: [props.message ?? `AssertionError: expected 200 to be 403\n at ${file}:17:4`],
				})),
			},
		],
	};
}
const process = { code: 0, signal: null, remaining: [] } as const;
const selection = { files: [file], pattern: 'guard refuses removed member' };

it('accepts actual selected passes and reports their deciding facts', (): void => {
	const verdict = decideTestRun({
		report: testReportSchema.parse(report()),
		selection,
		runtimeErrors: 0,
		process,
	});
	expect(verdict).toEqual({ kind: 'passed' });
	const row: DecidingFacts = {
		id: 'flow',
		host: 'node',
		commit: 'a'.repeat(40),
		tests: { passed: 1, failed: 0, skipped: 0, names: ['guard refuses removed member'] },
		verdict,
		restored: null,
		remaining: [],
		leftAtExit: [],
	};
	expect(reportPassed([row])).toBe(true);
	expect(renderReport([row])).toContain('flow | node | aaaaaaaaaaaa | 1/0/0 | PASS | n/a | 0');
	expect(reportPassed([])).toBe(false);
	expect(reportPassed([{ ...row, restored: false }])).toBe(false);
	expect(renderReport([{ ...row, remaining: [], leftAtExit: [12] }])).toContain(
		'| 0 (cleaned 1 after exit)',
	);
	expect(renderReport([{ ...row, remaining: [12], leftAtExit: [12] }])).toContain(
		'| 1 (at parent exit 1)',
	);
});
it.each([
	{ name: 'zero tests', value: { ...report(), numPassedTests: 0, testResults: [] } },
	{ name: 'selected skip', value: report({ passed: 0, status: 'pending' }) },
	{ name: 'wrong file', value: report({ file: 'other.ts' }) },
	{ name: 'failed assertion', value: report({ passed: 0, failed: 1 }) },
])('refuses $name as a passing flow', ({ value }): void => {
	expect(
		decideTestRun({ report: testReportSchema.parse(value), selection, runtimeErrors: 0, process })
			.kind,
	).toBe('failed');
});
it('does not accept signalled, leaked, stale-count or duplicate reports', (): void => {
	for (const ending of [
		{ ...process, signal: 'SIGTERM' },
		{ ...process, remaining: [12] },
	])
		expect(
			decideTestRun({
				report: testReportSchema.parse(report()),
				selection,
				runtimeErrors: 0,
				process: ending,
			}).kind,
		).toBe('failed');
	expect(
		decideTestRun({
			report: testReportSchema.parse({ ...report(), numPassedTests: 2 }),
			selection,
			runtimeErrors: 0,
			process,
		}).kind,
	).toBe('failed');
	expect(
		decideTestRun({
			report: testReportSchema.parse(report({ passed: 2 })),
			selection,
			runtimeErrors: 0,
			process,
		}).kind,
	).toBe('failed');
});
it('requires the selected assertion red, exact restoration, and the same selected case green', (): void => {
	const red = decideTestRun({
		report: testReportSchema.parse(report({ passed: 0, failed: 1 })),
		selection,
		runtimeErrors: 0,
		process: { ...process, code: 1 },
		expected: { failure: 'expected 200 to be 403', count: 1 },
	});
	const green = decideTestRun({
		report: testReportSchema.parse(report()),
		selection,
		runtimeErrors: 0,
		process,
	});
	expect(red.kind).toBe('passed');
	expect(red).toEqual({ kind: 'passed', assertion: 'guard.host.e2e.test.ts:17' });
	expect(
		renderReport([
			{
				id: 'V5-red',
				host: 'node',
				commit: 'a'.repeat(40),
				tests: { passed: 0, failed: 1, skipped: 0, names: ['guard refuses removed member'] },
				verdict: red,
				restored: true,
				remaining: [],
				leftAtExit: [],
			},
		]),
	).toContain('PASS (expected red: guard.host.e2e.test.ts:17)');
	expect(decideSecurityCheck({ red, green, restored: true }).kind).toBe('passed');
	expect(decideSecurityCheck({ red, green, restored: false }).kind).toBe('failed');
	for (const message of [
		'Error: setup failed',
		`AssertionError: expected 200 to be 401\n at ${file}:17:4`,
		'AssertionError: expected 200 to be 403',
	])
		expect(
			decideTestRun({
				report: testReportSchema.parse(report({ passed: 0, failed: 1, message })),
				selection,
				runtimeErrors: 0,
				process: { ...process, code: 1 },
				expected: { failure: 'expected 200 to be 403', count: 1 },
			}).kind,
		).toBe('failed');
});

it('rejects a same-case assertion failure at the wrong line, even when the message matches', (): void => {
	const parsed = testReportSchema.parse(report({ passed: 0, failed: 1 }));
	const expected = { failure: 'expected 200 to be 403', count: 1, location: { file, line: 17 } };
	expect(
		decideTestRun({
			report: parsed,
			selection,
			runtimeErrors: 0,
			process: { ...process, code: 1 },
			expected,
		}).kind,
	).toBe('passed');
	expect(
		decideTestRun({
			report: parsed,
			selection,
			runtimeErrors: 0,
			process: { ...process, code: 1 },
			expected: { ...expected, location: { file, line: 18 } },
		}).kind,
	).toBe('failed');
});

it('reports unknown cleanup as a failed outcome and never as zero leftovers', (): void => {
	const verdict = decideTestRun({
		report: testReportSchema.parse(report()),
		selection,
		runtimeErrors: 0,
		process: { ...process, remaining: null },
	});
	expect(verdict.kind).toBe('failed');
	const row: DecidingFacts = {
		id: 'flow',
		host: 'node',
		commit: 'a'.repeat(40),
		tests: { passed: 1, failed: 0, skipped: 0, names: [] },
		verdict,
		remaining: null,
		leftAtExit: null,
		restored: null,
	};
	expect(renderReport([row])).toContain('| unknown');
	expect(reportPassed([row])).toBe(false);
});
it('rejects ambiguous edits and checks the entire original source map on restore', (): void => {
	expect(replaceExact('before guard after', 'guard', 'removed')).toBe('before removed after');
	expect(() => replaceExact('guard guard', 'guard', '')).toThrow('exactly once');
	expect(() => replaceExact('other', 'guard', '')).toThrow('exactly once');
	expect(() => replaceExact('guard', 'guard', 'guard')).toThrow('change');
	expect(decideRestoration({ a: 'bytes', b: 'second' }, { b: 'second', a: 'bytes' })).toBe(true);
	expect(decideRestoration({ a: 'bytes' }, { a: 'bytes', extra: 'new' })).toBe(false);
	expect(decideRestoration({ a: 'bytes' }, { a: 'wrong' })).toBe(false);
});

it('refuses intended assertion reds contaminated by unhandled or suite-level errors', (): void => {
	const parsed = testReportSchema.parse(report({ passed: 0, failed: 1 }));
	const expected = { failure: 'expected 200 to be 403', count: 1 };
	const ending = { ...process, code: 1 };
	expect(
		decideTestRun({ report: parsed, selection, process: ending, expected, runtimeErrors: 1 }).kind,
	).toBe('failed');
	const withHookError = {
		...parsed,
		testResults: parsed.testResults.map((suite) => ({ ...suite, message: 'afterAll failed' })),
	};
	expect(
		decideTestRun({ report: withHookError, selection, process: ending, expected, runtimeErrors: 0 })
			.kind,
	).toBe('failed');
});
