import { expect, it } from 'vitest';

import { resolveAssertionLocation } from './verification-assertion-anchor';
import { decideTestRun, testReportSchema } from './verification-decisions';

const file = 'request-lifecycle-transitions.unit.test.ts';
const marker = '\texpect(\n\t\tlifecycle.transition(\n\t\t\tnewer,';
const source =
	'\n'.repeat(30) +
	[
		'\texpect(',
		'\t\tlifecycle.transition(',
		'\t\t\tnewer,',
		"\t\t\t{ kind: 'reply', generation: pending.generation, reply: { kind: 'member' } },",
		'\t\t\t{},',
		'\t\t),',
		"\t).toEqual({ kind: 'refused', reason: 'stale' });",
		"\texpect(newer).toEqual({ kind: 'pending', generation: 3, request });",
	].join('\n');

it('resolves the multi-line expect to its matcher37, without admitting the neighbor38', (): void => {
	const location = resolveAssertionLocation({ file, source, marker, assertion: 'expect(' });
	expect(location).toEqual({ file, line: 37, column: 4 });
	const verdict = (line: number, column = 4): string =>
		decideTestRun({
			checkoutRoot: '/checkout',
			report: testReportSchema.parse({
				success: false,
				numPassedTests: 0,
				numFailedTests: 1,
				numPendingTests: 0,
				numFailedTestSuites: 1,
				testResults: [
					{
						name: file,
						assertionResults: [
							{
								title: 'stale',
								status: 'failed',
								failureMessages: [`AssertionError: to deeply equal\n at ${file}:${line}:${column}`],
							},
						],
					},
				],
			}),
			selection: { files: [file], pattern: '^stale$' },
			process: { code: 1, signal: null, remaining: [] },
			runtimeErrors: 0,
			expected: { failure: 'to deeply equal', count: 1, location },
		}).kind;
	expect(verdict(37)).toBe('passed');
	expect(verdict(37, 25)).toBe('failed');
	expect(verdict(38)).toBe('failed');
	expect(verdict(31)).toBe('failed');
});

it('rejects a different matcher on the same source line', (): void => {
	const first = "expect(first).toEqual('value');";
	const second = "expect(second).toEqual('value');";
	const source = `${first} ${second}`;
	const expectedLocation = resolveAssertionLocation({
		file,
		source,
		marker: first,
		assertion: 'expect(',
	});
	const nearbyLocation = resolveAssertionLocation({
		file,
		source,
		marker: second,
		assertion: 'expect(',
	});
	expect(expectedLocation.line).toBe(nearbyLocation.line);
	expect(expectedLocation.column).not.toBe(nearbyLocation.column);
	function verdictAt(location: typeof expectedLocation): string {
		const report = testReportSchema.parse({
			success: false,
			numPassedTests: 0,
			numFailedTests: 1,
			numPendingTests: 0,
			numFailedTestSuites: 1,
			testResults: [
				{
					name: file,
					assertionResults: [
						{
							title: 'same line',
							status: 'failed',
							failureMessages: [
								`AssertionError: to deeply equal\n at ${file}:${location.line}:${location.column}`,
							],
						},
					],
				},
			],
		});
		return decideTestRun({
			checkoutRoot: '/checkout',
			report,
			selection: { files: [file], pattern: '^same line$' },
			process: { code: 1, signal: null, remaining: [] },
			runtimeErrors: 0,
			expected: { failure: 'to deeply equal', count: 1, location: expectedLocation },
		}).kind;
	}
	expect(verdictAt(expectedLocation)).toBe('passed');
	expect(verdictAt(nearbyLocation)).toBe('failed');
});

it('keeps an inline matcher on its own line even when the marker includes preceding source', (): void => {
	expect(
		resolveAssertionLocation({
			file: 'inline.ts',
			source: 'const value = 1;\nexpect(value).toBe(1);',
			marker: 'const value = 1;\nexpect(value).toBe(1);',
			assertion: 'expect(',
		}),
	).toEqual({ file: 'inline.ts', line: 2, column: 15 });
});

it('rejects duplicated source and text inside a string instead of guessing an assertion', (): void => {
	const inline = 'expect(value).toBe(1)';
	expect(() =>
		resolveAssertionLocation({
			file,
			source: `${inline};\n${inline};`,
			marker: inline,
			assertion: 'expect(',
		}),
	).toThrow('source changed');
	expect(() =>
		resolveAssertionLocation({
			file,
			source: `const message = "${inline}";`,
			marker: inline,
			assertion: 'expect(',
		}),
	).toThrow('matcher is missing');
});
