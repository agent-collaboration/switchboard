import * as hegel from '@hegeldev/hegel';
import * as generators from '@hegeldev/hegel/generators';
import { expect, it } from 'vitest';

import {
	securityPhaseEffect,
	transitionSecurityPhase,
	type SecurityEvent,
	type SecurityPhase,
} from '../../../scripts/verify-auth/verification-security-phase';

const assertion = 'guard.test.ts:17';
const initial: SecurityPhase = { kind: 'prepared', expectedAssertion: assertion };
const correct: readonly SecurityEvent[] = [
	{ kind: 'mutant-built' },
	{ kind: 'red-observed', host: 'cloudflare', verdict: { kind: 'passed', assertion } },
	{ kind: 'red-observed', host: 'node', verdict: { kind: 'passed', assertion } },
	{ kind: 'source-restored', exact: true },
	{ kind: 'restored-built' },
	{ kind: 'green-observed', host: 'cloudflare', verdict: { kind: 'passed' } },
	{ kind: 'green-observed', host: 'node', verdict: { kind: 'passed' } },
	{ kind: 'source-restored', exact: true },
];
const events: readonly SecurityEvent[] = [
	...correct,
	{
		kind: 'red-observed',
		host: 'cloudflare',
		verdict: { kind: 'passed', assertion: 'wrong.ts:2' },
	},
	{ kind: 'red-observed', host: 'node', verdict: { kind: 'passed' } },
	{
		kind: 'red-observed',
		host: 'node',
		verdict: { kind: 'failed', reason: 'setup', assertion: null },
	},
	{ kind: 'green-observed', host: 'node', verdict: { kind: 'passed', assertion } },
	{
		kind: 'green-observed',
		host: 'cloudflare',
		verdict: { kind: 'failed', reason: 'signal or unknown cleanup', assertion: null },
	},
	{ kind: 'source-restored', exact: false },
	{ kind: 'execution-failed', reason: 'effect unavailable' },
];
const settings = {
	testCases: 2_000,
	seed: 20261120,
	derandomize: true,
	database: hegel.Database.disabled,
	reportMultipleFailures: false,
};

/** Independent protocol: only this literal ordered word can complete; one bad symbol poisons it. */
function symbol(event: SecurityEvent): string {
	switch (event.kind) {
		case 'mutant-built':
			return 'M';
		case 'restored-built':
			return 'B';
		case 'source-restored':
			return event.exact ? 'S' : 'fault';
		case 'execution-failed':
			return 'fault';
		case 'red-observed':
			return event.verdict.kind === 'passed' && event.verdict.assertion === assertion
				? event.host === 'cloudflare'
					? 'RC'
					: 'RN'
				: 'fault';
		case 'green-observed':
			return event.verdict.kind === 'passed' && event.verdict.assertion === undefined
				? event.host === 'cloudflare'
					? 'GC'
					: 'GN'
				: 'fault';
		default:
			return event satisfies never;
	}
}
const acceptedWord = ['M', 'RC', 'RN', 'S', 'B', 'GC', 'GN', 'S'];
const expectedEffects = [
	'mutate-and-build',
	'run-red',
	'run-red',
	'restore',
	'rebuild',
	'run-green',
	'run-green',
	'restore',
	'done',
];

function checkTrace(trace: readonly SecurityEvent[]): readonly string[] {
	let phase: SecurityPhase = initial;
	let position = 0;
	let poisoned = false;
	const visited = [phase.kind];
	for (const event of trace) {
		if (poisoned || symbol(event) !== acceptedWord[position]) poisoned = true;
		else position += 1;
		phase = transitionSecurityPhase(phase, event);
		visited.push(phase.kind);
		expect(phase.kind === 'complete', JSON.stringify(trace)).toBe(!poisoned && position === 8);
		if (!poisoned) expect(securityPhaseEffect(phase).kind).toBe(expectedEffects[position]);
		else expect(securityPhaseEffect(phase).kind).not.toBe('done');
	}
	return visited;
}

it.each(['arbitrary', 'perturbed-completion'] as const)(
	'Hegel: security proof rejects invalid event sequences (%s)',
	(family): void => {
		const visited = new Set<string>();
		hegel.test((testCase): void => {
			let trace: SecurityEvent[];
			if (family === 'arbitrary') {
				const prefix = testCase.draw(
					generators.integers({ minValue: 0, maxValue: correct.length }),
				);
				trace = [
					...correct.slice(0, prefix),
					...testCase.draw(
						generators.arrays(generators.sampledFrom(events), { minSize: 0, maxSize: 24 }),
					),
				];
			} else {
				trace = [...correct];
				const position = testCase.draw(
					generators.integers({ minValue: 0, maxValue: correct.length - 1 }),
				);
				const operation = testCase.draw(
					generators.sampledFrom(['omit', 'replace', 'duplicate', 'unchanged'] as const),
				);
				const replacement = testCase.draw(generators.sampledFrom(events));
				if (operation === 'omit') trace.splice(position, 1);
				if (operation === 'replace') trace.splice(position, 1, replacement);
				if (operation === 'duplicate') trace.splice(position, 0, replacement);
			}
			for (const phase of checkTrace(trace)) visited.add(phase);
		}, settings);
		for (const phase of [
			'prepared',
			'red-pending',
			'restore-pending',
			'failure-restore-pending',
			'restored',
			'green-pending',
			'final-restore-pending',
			'complete',
			'failed',
		])
			expect(visited.has(phase), phase).toBe(true);
	},
);

it('shrinks a wrong green-before-restore transition to the single forbidden GN observation', (): void => {
	// Deliberately wrong implementation for sensitivity only: no product/driver source is changed.
	const wrongTransition = (phase: SecurityPhase, event: SecurityEvent): SecurityPhase =>
		symbol(event) === 'GN' ? { kind: 'complete' } : transitionSecurityPhase(phase, event);
	expect(() =>
		hegel.test((testCase): void => {
			const trace = testCase.draw(
				generators.arrays(generators.sampledFrom(events), { minSize: 1, maxSize: 24 }),
			);
			let phase: SecurityPhase = initial;
			let position = 0;
			let poisoned = false;
			const observed: string[] = [];
			for (const event of trace) {
				const code = symbol(event);
				observed.push(code);
				if (poisoned || code !== acceptedWord[position]) poisoned = true;
				else position += 1;
				phase = wrongTransition(phase, event);
				if (phase.kind === 'complete' && (poisoned || position !== 8))
					throw new Error(`green-before-restore:${JSON.stringify(observed)}`);
			}
		}, settings),
	).toThrow('green-before-restore:["GN"]');
});
