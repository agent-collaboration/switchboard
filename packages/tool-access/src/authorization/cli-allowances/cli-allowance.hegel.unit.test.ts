import * as hegel from '@hegeldev/hegel';
import * as generators from '@hegeldev/hegel/generators';
import { expect, it } from 'vitest';

import {
	CliAllowanceInputSchema,
	CliAllowanceSchema,
	evaluateCliAllowanceInvocation,
} from '#tool-access/authorization/cli-allowances/index';
import { classifyCliPathContribution } from '#tool-access/authorization/cli-path-policy';

const settings = { testCases: 500, derandomize: true, database: hegel.Database.disabled };

it('applies AND predicates, OR alternatives, and deny before ask and baseline', () => {
	hegel.test((tc) => {
		const force = tc.draw(generators.integers({ minValue: 0, maxValue: 2 }));
		const format = tc.draw(generators.integers({ minValue: 0, maxValue: 2 }));
		const publish = tc.draw(generators.integers({ minValue: 0, maxValue: 1 })) === 1;
		const deny = tc.draw(generators.integers({ minValue: 0, maxValue: 1 })) === 1;
		const baselineIndex = tc.draw(generators.integers({ minValue: 0, maxValue: 2 }));
		const baselines = ['without_approval', 'requires_approval', 'deny'] as const;
		const baseline = baselines[baselineIndex];
		if (baseline === undefined) throw new Error('Invalid baseline');
		const argv = [
			'project',
			'edit',
			'../ordinary',
			...(force === 0 ? [] : [force === 1 ? '-f' : '--force']),
			...(format === 0 ? [] : [format === 1 ? '--format=json' : '--format=text']),
			...(publish ? ['--publish'] : []),
		];
		tc.note(JSON.stringify({ argv, deny, baseline }));
		const conjunction = {
			path: ['project', 'edit'],
			flags: [{ names: ['--force', '-f'] }, { names: ['--format'], values: ['json', 'text'] }],
		};
		const policy = CliAllowanceSchema.parse({
			commands: [{ path: ['project', 'edit'] }],
			timeout: { kind: 'quick' },
			calls: {
				deny: deny ? [conjunction] : [],
				requiresApproval: [
					conjunction,
					{ path: ['project', 'edit'], flags: [{ names: ['--publish'] }] },
				],
				withoutApproval: 'remaining_admitted',
			},
		});
		const matched = force !== 0 && format !== 0;
		const expected =
			baseline === 'deny' || (deny && matched)
				? 'deny'
				: baseline === 'requires_approval' || matched || publish
					? 'requires_approval'
					: 'without_approval';
		expect(
			evaluateCliAllowanceInvocation({
				allowance: policy,
				baseline,
				input: CliAllowanceInputSchema.parse({ argv, reason: 'property' }),
			}),
		).toMatchObject({ kind: 'admitted', disposition: expected });
		expect(classifyCliPathContribution(policy, ['project', 'edit'])).toBe('none');
		expect(classifyCliPathContribution(policy, ['project', 'other'])).toBe('deny');
	}, settings);
});

it('validates authored command, flag values and UTF-8 stdin bounds', () => {
	hegel.test((tc) => {
		const command = tc.draw(generators.integers({ minValue: 0, maxValue: 1 }));
		const format = tc.draw(generators.integers({ minValue: 0, maxValue: 2 }));
		const stdinIndex = tc.draw(generators.integers({ minValue: 0, maxValue: 3 }));
		const inputs = ['', 'éé', 'ééa', 'blocked'];
		const stdin = inputs[stdinIndex];
		if (stdin === undefined) throw new Error('Invalid stdin');
		const argv = [
			command === 0 ? 'edit' : 'other',
			'./ordinary',
			...(format === 0 ? [] : [format === 1 ? '--format=json' : '--format=xml']),
		];
		tc.note(JSON.stringify({ argv, stdin }));
		const policy = CliAllowanceSchema.parse({
			commands: [
				{
					path: ['edit'],
					flagRules: [{ kind: 'allowed_values', names: ['--format'], values: ['json'] }],
				},
			],
			timeout: { kind: 'quick' },
			stdin: {
				kind: 'bounded_text',
				maxBytes: 4,
				deniedPatterns: [{ kind: 'literal', value: 'blocked' }],
			},
			calls: { deny: [], requiresApproval: [], withoutApproval: 'remaining_admitted' },
		});
		const expected = command === 0 && format !== 2 && stdinIndex < 2;
		expect(
			evaluateCliAllowanceInvocation({
				allowance: policy,
				baseline: 'without_approval',
				input: CliAllowanceInputSchema.parse({ argv, stdin, reason: 'property' }),
			}).ok,
		).toBe(expected);
	}, settings);
});

it('classifies unconditional authored command paths independently of argument-dependent rules', () => {
	hegel.test((tc) => {
		const mode = tc.draw(generators.integers({ minValue: 0, maxValue: 2 }));
		const command = tc.draw(generators.integers({ minValue: 0, maxValue: 1 }));
		tc.note(JSON.stringify({ mode, command }));
		const matcher = { path: ['edit'], flags: [] };
		const policy = CliAllowanceSchema.parse({
			commands: [{ path: ['edit'] }],
			timeout: { kind: 'quick' },
			calls: {
				deny: mode === 2 ? [matcher] : [],
				requiresApproval: mode === 1 ? [matcher] : [],
				withoutApproval: 'remaining_admitted',
			},
		});
		const expected = command === 1 || mode === 2 ? 'deny' : mode === 1 ? 'ask' : 'none';
		expect(classifyCliPathContribution(policy, [command === 0 ? 'edit' : 'other'])).toBe(expected);
	}, settings);
});
