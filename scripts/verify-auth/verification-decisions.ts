import path from 'node:path';

import { z } from 'zod';

const assertionSchema = z.object({
	title: z.string(),
	fullName: z.string().optional(),
	ancestorTitles: z.array(z.string()).default([]),
	status: z.enum(['passed', 'failed', 'pending', 'skipped', 'todo', 'disabled']),
	failureMessages: z.array(z.string()).default([]),
});
export const testReportSchema = z.object({
	success: z.boolean(),
	numPassedTests: z.number().int().nonnegative(),
	numFailedTests: z.number().int().nonnegative(),
	numPendingTests: z.number().int().nonnegative(),
	numFailedTestSuites: z.number().int().nonnegative(),
	testResults: z.array(
		z.object({
			name: z.string(),
			message: z.string().default(''),
			assertionResults: z.array(assertionSchema),
		}),
	),
});
export type TestReport = z.infer<typeof testReportSchema>;
export interface TestSelection {
	readonly files: readonly string[];
	readonly pattern?: string;
	readonly minimumPassed?: number;
	readonly allowedSkips?: readonly string[];
}
export interface ProcessResult {
	readonly code: number | null;
	readonly signal: string | null;
	readonly remaining: readonly number[] | null;
}
export interface AssertionOutcome {
	readonly file: string;
	readonly name: string;
	readonly status: z.infer<typeof assertionSchema>['status'];
	readonly messages: readonly string[];
}
export type Verdict =
	| { readonly kind: 'passed'; readonly assertion?: string }
	| { readonly kind: 'failed'; readonly reason: string; readonly assertion: string | null };

export function observedAssertions(report: TestReport): readonly AssertionOutcome[] {
	return report.testResults.flatMap((suite) =>
		suite.assertionResults.map((test) => ({
			file: suite.name.replaceAll('\\', '/'),
			name: test.fullName ?? [...test.ancestorTitles, test.title].join(' > '),
			status: test.status,
			messages: test.failureMessages,
		})),
	);
}

function failed(reason: string, assertion: string | null = null): Verdict {
	return { kind: 'failed', reason, assertion };
}
export function assertionLocation(test: AssertionOutcome | undefined): string | null {
	if (test === undefined) return null;
	for (const message of test.messages) {
		const location = /(?:\bat\s+[^\n]*?\()?([^\s()]+\.(?:ts|tsx)):(\d+):(\d+)/u.exec(message);
		if (location?.[1] !== undefined && location[2] !== undefined)
			return `${path.basename(location[1])}:${location[2]}`;
	}
	return null;
}

export interface ExpectedFailure {
	readonly failure: string;
	readonly count: number;
	readonly location?: { readonly file: string; readonly line: number };
}

export function decideTestRun(props: {
	readonly report: TestReport;
	readonly selection: TestSelection;
	readonly process: ProcessResult;
	readonly runtimeErrors: number;
	readonly expected?: ExpectedFailure;
}): Verdict {
	if (props.runtimeErrors !== 0) return failed('unhandled runtime errors occurred');
	if (props.report.testResults.some((suite) => suite.message.length > 0))
		return failed('suite setup or teardown failed');
	if (props.process.remaining === null)
		return failed('owned-process cleanup could not be observed');
	if (props.process.remaining.length > 0) return failed('owned processes remain');
	if (props.process.signal !== null) return failed('test process ended by signal');
	const tests = observedAssertions(props.report);
	const active = tests.filter((test) => test.status === 'passed' || test.status === 'failed');
	if (active.length === 0) return failed('no tests ran');
	const selectedFile = (test: AssertionOutcome): boolean =>
		props.selection.files.some((file) => test.file === file || test.file.endsWith(`/${file}`));
	if (tests.some((test) => !selectedFile(test)))
		return failed('report contains an unselected file');
	if (
		props.report.testResults.some(
			(suite) =>
				!props.selection.files.some(
					(file) => suite.name === file || suite.name.replaceAll('\\', '/').endsWith(`/${file}`),
				),
		)
	)
		return failed('report contains an unselected suite');
	const pattern =
		props.selection.pattern === undefined ? null : new RegExp(props.selection.pattern, 'u');
	if (active.some((test) => pattern !== null && !pattern.test(test.name)))
		return failed('report contains an unselected test');
	if (
		props.selection.files.some(
			(file) => !active.some((test) => test.file.endsWith(`/${file}`) || test.file === file),
		)
	)
		return failed('a selected file ran no tests');
	if (new Set(active.map((test) => `${test.file}:${test.name}`)).size !== active.length)
		return failed('duplicate executed test');
	const passes = active.filter((test) => test.status === 'passed');
	const failures = active.filter((test) => test.status === 'failed');
	if (
		props.report.numPassedTests !== passes.length ||
		props.report.numFailedTests !== failures.length
	)
		return failed('test counts disagree with actual results');
	const skips = tests.filter((test) => test.status !== 'passed' && test.status !== 'failed');
	if (skips.length !== props.report.numPendingTests) return failed('skip counts disagree');
	if (
		skips.some(
			(test) =>
				(pattern === null || pattern.test(test.name)) &&
				!props.selection.allowedSkips?.includes(test.name),
		)
	)
		return failed('a selected test was skipped');
	if (props.expected !== undefined) {
		if (
			props.process.code !== 1 ||
			props.report.success ||
			failures.length !== props.expected.count ||
			passes.length !== 0
		)
			return failed('security check did not produce exactly its intended failures');
		if (
			failures.some(
				(test) =>
					!test.messages.some(
						(message) =>
							message.startsWith('AssertionError:') &&
							message.includes(props.expected?.failure ?? ''),
					) || assertionLocation(test) === null,
			)
		)
			return failed(
				'security check failed outside the named assertion',
				assertionLocation(failures[0] ?? active[0]),
			);
		if (props.expected.location !== undefined) {
			const expectedLocation = `${path.basename(props.expected.location.file)}:${props.expected.location.line}`;
			if (failures.some((test) => assertionLocation(test) !== expectedLocation))
				return failed(
					'security check failed at a different assertion',
					assertionLocation(failures[0]),
				);
		}
		const assertion = assertionLocation(failures[0]);
		if (assertion === null) return failed('security red has no observed assertion');
		return { kind: 'passed', assertion };
	}
	if (
		props.process.code !== 0 ||
		!props.report.success ||
		props.report.numFailedTestSuites > 0 ||
		failures.length > 0
	)
		return failed(
			'test run failed',
			failures[0] === undefined ? null : assertionLocation(failures[0]),
		);
	if (passes.length < (props.selection.minimumPassed ?? 1))
		return failed('required tests did not all pass');
	return { kind: 'passed' };
}

/** Match one exact site; zero or multiple sites must never silently change the intended mutation. */
export function replaceExact(source: string, find: string, replacement: string): string {
	if (find.length === 0 || source.split(find).length !== 2)
		throw new Error('Mutation must match exactly once');
	if (find === replacement) throw new Error('Mutation must change the source');
	return source.replace(find, replacement);
}
export function decideRestoration(
	before: Readonly<Record<string, string>>,
	after: Readonly<Record<string, string>>,
): boolean {
	const keys = Object.keys(before).sort();
	return (
		JSON.stringify(keys) === JSON.stringify(Object.keys(after).sort()) &&
		keys.every((key) => before[key] === after[key])
	);
}
export function decideSecurityCheck(props: {
	readonly red: Verdict;
	readonly green: Verdict;
	readonly restored: boolean;
}): Verdict {
	if (!props.restored) return failed('security check source was not restored exactly');
	if (props.red.kind === 'failed') return props.red;
	return props.green;
}

export interface DecidingFacts {
	readonly id: string;
	readonly host: 'cloudflare' | 'node' | 'unknown';
	readonly commit: string;
	readonly tests: {
		readonly passed: number;
		readonly failed: number;
		readonly skipped: number;
		readonly names: readonly string[];
	};
	readonly verdict: Verdict;
	readonly restored: boolean | null;
	readonly remaining: readonly number[] | null;
	readonly leftAtExit: readonly number[] | null;
}
export function reportPassed(rows: readonly DecidingFacts[]): boolean {
	return (
		rows.length > 0 &&
		rows.every(
			(row) =>
				row.verdict.kind === 'passed' &&
				row.restored !== false &&
				row.remaining !== null &&
				row.remaining.length === 0,
		)
	);
}
export function renderReport(rows: readonly DecidingFacts[]): string {
	return [
		'journey/check | host | commit | tests pass/fail/skip | result/assertion | restored | left running',
		...rows.map(
			(row) =>
				`${row.id} | ${row.host} | ${row.commit.slice(0, 12)} | ${row.tests.passed}/${row.tests.failed}/${row.tests.skipped} | ${row.verdict.kind === 'passed' ? `PASS${row.verdict.assertion === undefined ? '' : ` (expected red: ${row.verdict.assertion})`}` : `FAIL: ${row.verdict.reason}${row.verdict.assertion === null ? '' : ` (${row.verdict.assertion})`}`} | ${row.restored === null ? 'n/a' : row.restored ? 'yes' : 'NO'} | ${row.remaining === null ? 'unknown' : row.remaining.length}${row.leftAtExit !== null && row.leftAtExit.length > 0 ? ` (${row.remaining?.length === 0 ? 'cleaned' : 'at parent exit'} ${row.leftAtExit.length}${row.remaining?.length === 0 ? ' after exit' : ''})` : ''}`,
		),
	].join('\n');
}
