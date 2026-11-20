import { expect, it } from 'vitest';

import { resolveVerificationSelection } from './verification-cli';

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
