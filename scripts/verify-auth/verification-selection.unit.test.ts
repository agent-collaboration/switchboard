import { expect, it } from 'vitest';

import { securityChecks } from '../../verification/security-checks';
import { resolveVerificationSelection } from './verification-cli';
import { decideTestRun, testReportSchema } from './verification-decisions';
import { selectSecurityTests } from './verification-runner';

// The adopted single-baseline coverage table, independent of the producer lists.
const journeys = ['passkey-sign-in', 'organizations', 'cli-sign-in', 'agents'];
const controls = [
	'V5',
	'F1',
	'V6-provider',
	'V6-outer',
	'B04',
	'HTTP09',
	'HTTP10',
	'HTTP11',
	'HTTP12',
	'HTTP13',
	'HTTP14',
	'HTTP15',
	'HTTP16',
	'stale-reply',
];

it('defaults the aggregate to the adopted four journeys and fourteen controls', (): void => {
	expect(
		resolveVerificationSelection({ journey: 'all', flows: undefined, checks: undefined }),
	).toEqual({ flows: journeys, checks: controls });
});

it('keeps all journeys for the approved journey-only aggregate and all checks for the security entry', (): void => {
	expect(
		resolveVerificationSelection({ journey: 'all', flows: undefined, checks: 'none' }),
	).toEqual({ flows: journeys, checks: [] });
	expect(
		resolveVerificationSelection({
			journey: 'security-checks',
			flows: undefined,
			checks: undefined,
		}),
	).toEqual({ flows: [], checks: controls });
	expect(
		resolveVerificationSelection({ journey: 'organizations', flows: undefined, checks: undefined }),
	).toEqual({ flows: ['organizations'], checks: [] });
});

it('rejects unknown, duplicated and empty selections before any target drive', (): void => {
	for (const flows of ['unknown', 'agents,agents', 'agents,'])
		expect(() => resolveVerificationSelection({ journey: 'all', flows, checks: 'none' })).toThrow();
	for (const checks of ['unknown', 'F1,F1', 'F1,'])
		expect(() => resolveVerificationSelection({ journey: 'all', flows: 'none', checks })).toThrow();
});

it('refuses duplicate first control observations across files when the second named observation is missing', (): void => {
	const check = securityChecks.find((candidate) => candidate.id === 'HTTP09');
	if (check === undefined) throw new Error('HTTP09 is required');
	const file = 'packages/sign-in-test-support/src/people-membership-lookup.host.e2e.test.ts';
	const title = 'people: lookup refuses member before a facts query and releases no subject fields';
	const report = testReportSchema.parse({
		success: false,
		numPassedTests: 0,
		numFailedTests: 2,
		numPendingTests: 0,
		numFailedTestSuites: 2,
		testResults: [
			file,
			'packages/sign-in-test-support/src/people-organization-list.host.e2e.test.ts',
		].map((name) => ({
			name,
			assertionResults: [
				{
					title,
					status: 'failed',
					failureMessages: [`AssertionError: expected 1 to be +0\n at /checkout/${file}:37:4`],
				},
			],
		})),
	});
	expect(
		decideTestRun({
			checkoutRoot: '/checkout',
			report,
			selection: selectSecurityTests(check),
			runtimeErrors: 0,
			process: { code: 1, signal: null, remaining: [] },
			expected: { failure: 'expected 1 to be +0', count: 2, location: { file, line: 37 } },
		}).kind,
	).toBe('failed');
});
