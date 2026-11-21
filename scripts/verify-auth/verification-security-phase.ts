import type { Verdict } from './verification-decisions';

export type SecurityHost = 'cloudflare' | 'node';

/** One check's proof, from mutation custody through both hosts and final restoration. */
export type SecurityPhase =
	| { readonly kind: 'prepared'; readonly expectedAssertion: string }
	| {
			readonly kind: 'red-pending';
			readonly host: SecurityHost;
			readonly expectedAssertion: string;
	  }
	| { readonly kind: 'restore-pending' }
	| { readonly kind: 'failure-restore-pending'; readonly reason: string }
	| { readonly kind: 'restored' }
	| { readonly kind: 'green-pending'; readonly host: SecurityHost }
	| { readonly kind: 'final-restore-pending' }
	| { readonly kind: 'complete' }
	| { readonly kind: 'failed'; readonly reason: string; readonly restored: boolean };

export type SecurityEvent =
	| { readonly kind: 'mutant-built' }
	| { readonly kind: 'red-observed'; readonly host: SecurityHost; readonly verdict: Verdict }
	| { readonly kind: 'source-restored'; readonly exact: boolean }
	| { readonly kind: 'restored-built' }
	| { readonly kind: 'green-observed'; readonly host: SecurityHost; readonly verdict: Verdict }
	| { readonly kind: 'execution-failed'; readonly reason: string };

export type SecurityEffect =
	| { readonly kind: 'mutate-and-build' }
	| { readonly kind: 'run-red'; readonly host: SecurityHost }
	| { readonly kind: 'restore' }
	| { readonly kind: 'rebuild' }
	| { readonly kind: 'run-green'; readonly host: SecurityHost }
	| { readonly kind: 'done' }
	| { readonly kind: 'stop'; readonly reason: string; readonly restored: boolean };

function refuse(phase: SecurityPhase, reason: string): SecurityPhase {
	switch (phase.kind) {
		case 'failed':
			return phase;
		case 'complete':
			return { kind: 'failed', reason, restored: true };
		case 'prepared':
		case 'red-pending':
		case 'restore-pending':
		case 'failure-restore-pending':
		case 'restored':
		case 'green-pending':
		case 'final-restore-pending':
			return { kind: 'failure-restore-pending', reason };
		default:
			return phase satisfies never;
	}
}

/** Observations never authorize a later phase unless its own predecessor completed. */
export function transitionSecurityPhase(phase: SecurityPhase, event: SecurityEvent): SecurityPhase {
	if (phase.kind === 'failed') return phase;
	if (event.kind === 'execution-failed') {
		if (
			phase.kind === 'restore-pending' ||
			phase.kind === 'failure-restore-pending' ||
			phase.kind === 'final-restore-pending'
		)
			return {
				kind: 'failed',
				reason: 'source restoration could not be observed',
				restored: false,
			};
		return refuse(phase, event.reason);
	}
	switch (phase.kind) {
		case 'prepared':
			if (event.kind === 'mutant-built')
				return {
					kind: 'red-pending',
					host: 'cloudflare',
					expectedAssertion: phase.expectedAssertion,
				};
			break;
		case 'red-pending':
			if (
				event.kind === 'red-observed' &&
				event.host === phase.host &&
				event.verdict.kind === 'passed' &&
				event.verdict.assertion === phase.expectedAssertion
			)
				return phase.host === 'cloudflare'
					? { ...phase, host: 'node' }
					: { kind: 'restore-pending' };
			break;
		case 'restore-pending':
			if (event.kind === 'source-restored')
				return event.exact
					? { kind: 'restored' }
					: { kind: 'failed', reason: 'source restoration differs', restored: false };
			break;
		case 'failure-restore-pending':
			if (event.kind === 'source-restored')
				return { kind: 'failed', reason: phase.reason, restored: event.exact };
			break;
		case 'restored':
			if (event.kind === 'restored-built') return { kind: 'green-pending', host: 'cloudflare' };
			break;
		case 'green-pending':
			if (
				event.kind === 'green-observed' &&
				event.host === phase.host &&
				event.verdict.kind === 'passed' &&
				event.verdict.assertion === undefined
			)
				return phase.host === 'cloudflare'
					? { ...phase, host: 'node' }
					: { kind: 'final-restore-pending' };
			break;
		case 'final-restore-pending':
			if (event.kind === 'source-restored')
				return event.exact
					? { kind: 'complete' }
					: { kind: 'failed', reason: 'final source restoration differs', restored: false };
			break;
		case 'complete':
			return refuse(phase, 'observation after completed proof');
		default:
			phase satisfies never;
	}
	return refuse(phase, 'unexpected or unqualified security observation');
}

export function securityPhaseEffect(phase: SecurityPhase): SecurityEffect {
	switch (phase.kind) {
		case 'prepared':
			return { kind: 'mutate-and-build' };
		case 'red-pending':
			return { kind: 'run-red', host: phase.host };
		case 'restore-pending':
		case 'failure-restore-pending':
		case 'final-restore-pending':
			return { kind: 'restore' };
		case 'restored':
			return { kind: 'rebuild' };
		case 'green-pending':
			return { kind: 'run-green', host: phase.host };
		case 'complete':
			return { kind: 'done' };
		case 'failed':
			return { kind: 'stop', reason: phase.reason, restored: phase.restored };
		default:
			return phase satisfies never;
	}
}
