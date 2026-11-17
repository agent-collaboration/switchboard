import * as hegel from '@hegeldev/hegel';
import * as generators from '@hegeldev/hegel/generators';
import { expect, it } from 'vitest';

import {
	authorizeModeledTransaction,
	completeModeledCallback,
	consumeModeledCallback,
	createCeremonyModel,
	createModeledTransaction,
	decideModeledCompletion,
	discardModeledCompletion,
	modelPrincipal,
	principalWithFault,
	reapModeledCeremonies,
	type BrowserFault,
	type CeremonyModelState,
	type ModelCompletion,
	type ModelTransaction,
} from './oauth-ceremony-hegel-fixture.js';

const browserFaults: readonly BrowserFault[] = [
	'none',
	'subject',
	'issuer',
	'browser',
	'csrf',
	'state',
	'redirect',
];

function drawTransaction(
	testCase: hegel.TestCase,
	state: CeremonyModelState,
): ModelTransaction | undefined {
	return state.transactions.length === 0
		? undefined
		: testCase.draw(generators.sampledFrom(state.transactions));
}
function drawCompletion(
	testCase: hegel.TestCase,
	state: CeremonyModelState,
): ModelCompletion | undefined {
	return state.completions.length === 0
		? undefined
		: testCase.draw(generators.sampledFrom(state.completions));
}

function finishModeledCompletion(state: CeremonyModelState, entry: ModelCompletion): void {
	const expected = entry.phase !== 'removed';
	expect(state.store.finishCompletion(entry.handle.completionSessionId)).toBe(expected);
	discardModeledCompletion(state, entry);
}

function assertRetainedCeremonies(state: CeremonyModelState): void {
	for (const entry of state.transactions) {
		expect(state.store.getTransaction(entry.handle.transactionId)?.kind).toBe(
			entry.phase === 'removed' ? undefined : entry.phase,
		);
		const completion = state.completions.find(
			(candidate: ModelCompletion): boolean =>
				candidate.phase !== 'removed' &&
				candidate.handle.transactionId === entry.handle.transactionId,
		);
		const context = state.store.getCeremonyContext(entry.handle.transactionId);
		expect(context?.transactionId).toBe(
			entry.phase !== 'removed' || completion !== undefined
				? entry.handle.transactionId
				: undefined,
		);
	}
	for (const entry of state.completions) {
		expect(state.store.getCompletionSession(entry.handle.completionSessionId)?.kind).toBe(
			entry.phase === 'removed' ? undefined : entry.phase,
		);
	}
	expect(
		state.transactions.filter((entry: ModelTransaction): boolean => entry.phase !== 'removed')
			.length,
	).toBeLessThanOrEqual(state.maxTransactions);
	expect(
		state.completions.filter((entry: ModelCompletion): boolean => entry.phase !== 'removed').length,
	).toBeLessThanOrEqual(state.maxCompletions);
	expect(state.observedDiscards).toEqual(state.expectedDiscards);
}

const ceremonyMachine: hegel.stateful.StateMachine<CeremonyModelState> = {
	rules: {
		create: (testCase: hegel.TestCase, state: CeremonyModelState): void => {
			const ownerInitiated = testCase.draw(generators.booleans());
			testCase.note(JSON.stringify({ ownerInitiated, nowMs: state.clock.nowMs }));
			createModeledTransaction(state, ownerInitiated);
		},
		authorize: (testCase: hegel.TestCase, state: CeremonyModelState): void => {
			const entry = drawTransaction(testCase, state);
			if (entry !== undefined) authorizeModeledTransaction(state, entry);
		},
		callback: (testCase: hegel.TestCase, state: CeremonyModelState): void => {
			const entry = drawTransaction(testCase, state);
			const fault = testCase.draw(generators.sampledFrom(browserFaults));
			testCase.note(`callback fault=${fault}`);
			if (entry !== undefined) consumeModeledCallback(state, entry, fault);
		},
		completeCallback: (testCase: hegel.TestCase, state: CeremonyModelState): void => {
			const entry = drawTransaction(testCase, state);
			if (entry !== undefined) completeModeledCallback(state, entry);
		},
		completionDecision: (testCase: hegel.TestCase, state: CeremonyModelState): void => {
			const entry = drawCompletion(testCase, state);
			const fault = testCase.draw(generators.sampledFrom(browserFaults));
			const cancel = testCase.draw(generators.booleans());
			testCase.note(JSON.stringify({ fault, cancel }));
			if (entry !== undefined) decideModeledCompletion(state, entry, fault, cancel);
		},
		cancelTransaction: (testCase: hegel.TestCase, state: CeremonyModelState): void => {
			const entry = drawTransaction(testCase, state);
			if (entry === undefined) return;
			const pendingOnly = testCase.draw(generators.booleans());
			const matchingAgent = testCase.draw(generators.booleans());
			const completion = state.completions.find(
				(candidate: ModelCompletion): boolean =>
					candidate.handle.transactionId === entry.handle.transactionId &&
					candidate.phase !== 'removed',
			);
			let expected = false;
			if (matchingAgent && entry.phase !== 'removed') {
				expected = !pendingOnly || (!entry.ownerInitiated && entry.phase !== 'consuming-callback');
				if (expected) entry.phase = 'removed';
			} else if (matchingAgent && completion?.phase === 'awaiting-account-confirmation') {
				expected = !pendingOnly || !completion.ownerInitiated;
				if (expected) discardModeledCompletion(state, completion);
			}
			const input = {
				transactionId: entry.handle.transactionId,
				agentId: matchingAgent ? 'hermes' : 'another-agent',
			};
			testCase.note(JSON.stringify({ pendingOnly, matchingAgent, expected }));
			expect(
				pendingOnly
					? state.store.cancelPendingTransaction(input)
					: state.store.cancelTransaction(input),
			).toBe(expected);
		},
		cancelBrowserCeremonies: (testCase: hegel.TestCase, state: CeremonyModelState): void => {
			const fault = testCase.draw(
				generators.sampledFrom(['none', 'issuer', 'subject'] satisfies readonly BrowserFault[]),
			);
			let expectedCount = 0;
			if (fault === 'none') {
				for (const entry of state.transactions) {
					if (entry.phase !== 'removed') {
						entry.phase = 'removed';
						expectedCount++;
					}
				}
				for (const entry of state.completions) {
					if (entry.phase === 'awaiting-account-confirmation') {
						discardModeledCompletion(state, entry);
						expectedCount++;
					}
				}
			}
			expect(state.store.cancelBrowserCeremonies(principalWithFault(fault))).toBe(expectedCount);
		},
		finishCompletion: (testCase: hegel.TestCase, state: CeremonyModelState): void => {
			const entry = drawCompletion(testCase, state);
			if (entry !== undefined) finishModeledCompletion(state, entry);
		},
		advanceClock: (testCase: hegel.TestCase, state: CeremonyModelState): void => {
			const expiries = [...state.transactions, ...state.completions]
				.filter((entry): boolean => entry.phase !== 'removed')
				.map((entry): number => entry.expiresAtMs);
			const target =
				expiries.length === 0
					? state.clock.nowMs + 1
					: testCase.draw(generators.sampledFrom(expiries));
			const offset = testCase.draw(generators.sampledFrom([-1, 0, 1]));
			state.clock.nowMs = Math.max(state.clock.nowMs, target + offset);
			testCase.note(`nowMs=${state.clock.nowMs}`);
		},
		reapExpired: (_testCase: hegel.TestCase, state: CeremonyModelState): void => {
			expect(state.store.reapExpired()).toEqual(reapModeledCeremonies(state));
		},
		invalidate: (_testCase: hegel.TestCase, state: CeremonyModelState): void => {
			state.store.invalidateAll();
			for (const entry of state.transactions) entry.phase = 'removed';
			for (const entry of state.completions) discardModeledCompletion(state, entry);
		},
	},
	invariants: {
		retainedStateCapacityAndGrantDisposal: {
			alwaysCheck: true,
			check: (_testCase: hegel.TestCase, state: CeremonyModelState): void =>
				assertRetainedCeremonies(state),
		},
	},
};

function exercisePrincipalAndFirstUse(state: CeremonyModelState): void {
	const transaction = createModeledTransaction(state, false);
	if (transaction === undefined)
		throw new Error('Empty ceremony model could not create a transaction.');
	for (const fault of ['subject', 'issuer'] satisfies readonly BrowserFault[]) {
		expect((): unknown =>
			state.store.bindBrowserIdentity({
				transactionId: transaction.handle.transactionId,
				identity: principalWithFault(fault),
			}),
		).toThrow('OAuth transaction is already bound to another browser session.');
	}
	authorizeModeledTransaction(state, transaction);
	for (const fault of [
		'subject',
		'issuer',
		'browser',
		'state',
		'redirect',
	] satisfies readonly BrowserFault[])
		consumeModeledCallback(state, transaction, fault);
	consumeModeledCallback(state, transaction, 'none');
	consumeModeledCallback(state, transaction, 'none');
	const completion = completeModeledCallback(state, transaction);
	if (completion === undefined) throw new Error('First callback must have completion capacity.');
	for (const fault of ['subject', 'issuer', 'browser', 'csrf'] satisfies readonly BrowserFault[]) {
		decideModeledCompletion(state, completion, fault, false);
		decideModeledCompletion(state, completion, fault, true);
	}
	decideModeledCompletion(state, completion, 'none', false);
	decideModeledCompletion(state, completion, 'none', false);
	decideModeledCompletion(state, completion, 'none', true);
	expect(state.store.cancelBrowserCeremonies(modelPrincipal)).toBe(0);
	finishModeledCompletion(state, completion);
	finishModeledCompletion(state, completion);
}

function exerciseCapacityAndExpiry(state: CeremonyModelState): void {
	// Fill the real completion store; the refused completion must preserve its consuming transaction.
	for (let index = 0; index <= state.maxCompletions; index++) {
		const transaction = createModeledTransaction(state, index % 2 === 0);
		if (transaction === undefined)
			throw new Error('Sequential completions must leave transaction capacity.');
		authorizeModeledTransaction(state, transaction);
		consumeModeledCallback(state, transaction, 'none');
		completeModeledCallback(state, transaction);
	}
	assertRetainedCeremonies(state);
	// Transaction capacity refuses instead of evicting live records.
	for (let index = 0; index <= state.maxTransactions; index++)
		createModeledTransaction(state, false);
	assertRetainedCeremonies(state);
	const awaiting = state.completions.find(
		(entry: ModelCompletion): boolean => entry.phase === 'awaiting-account-confirmation',
	);
	if (awaiting === undefined) throw new Error('Capacity setup did not retain a completion.');
	state.clock.nowMs = awaiting.expiresAtMs;
	decideModeledCompletion(state, awaiting, 'none', false);
	state.clock.nowMs = Math.max(
		state.clock.nowMs,
		...state.transactions.map((entry: ModelTransaction): number => entry.expiresAtMs),
	);
	expect(state.store.reapExpired()).toEqual(reapModeledCeremonies(state));
	assertRetainedCeremonies(state);
	const transaction = createModeledTransaction(state, false);
	if (transaction === undefined) throw new Error('Expiry must free transaction capacity.');
	authorizeModeledTransaction(state, transaction);
	state.clock.nowMs = transaction.expiresAtMs;
	consumeModeledCallback(state, transaction, 'none');
	consumeModeledCallback(state, transaction, 'none');
}

function exerciseCancellation(state: CeremonyModelState): void {
	for (const ownerInitiated of [false, true]) {
		const transaction = createModeledTransaction(state, ownerInitiated);
		if (transaction === undefined)
			throw new Error('Cancellation setup requires empty transaction capacity.');
		const input = { transactionId: transaction.handle.transactionId, agentId: 'hermes' };
		expect(state.store.cancelPendingTransaction({ ...input, agentId: 'another-agent' })).toBe(
			false,
		);
		expect(state.store.cancelTransaction({ ...input, agentId: 'another-agent' })).toBe(false);
		expect(state.store.cancelPendingTransaction(input)).toBe(!ownerInitiated);
		if (ownerInitiated) expect(state.store.cancelTransaction(input)).toBe(true);
		transaction.phase = 'removed';
		expect(state.store.cancelPendingTransaction(input)).toBe(false);
		const consuming = createModeledTransaction(state, ownerInitiated);
		if (consuming === undefined) throw new Error('Cancellation must free transaction capacity.');
		authorizeModeledTransaction(state, consuming);
		consumeModeledCallback(state, consuming, 'none');
		const consumingInput = { transactionId: consuming.handle.transactionId, agentId: 'hermes' };
		expect(state.store.cancelPendingTransaction(consumingInput)).toBe(false);
		const completion = completeModeledCallback(state, consuming);
		if (completion === undefined)
			throw new Error('Cancellation setup requires empty completion capacity.');
		expect(state.store.cancelPendingTransaction(consumingInput)).toBe(!ownerInitiated);
		if (ownerInitiated) {
			// Browser cancellation, unlike agent cancellation, admits the matching principal.
			decideModeledCompletion(state, completion, 'none', true);
		} else discardModeledCompletion(state, completion);
		expect(state.store.cancelTransaction(consumingInput)).toBe(false);
		assertRetainedCeremonies(state);
	}
}

it('M2 transaction and completion principals, first use, cancellation, caps and expiry follow the sequential model', async (): Promise<void> => {
	await hegel.testAsync(
		async (testCase: hegel.TestCase): Promise<void> => {
			// Arrange
			const state = createCeremonyModel({
				capacity: testCase.draw(generators.integers({ minValue: 1, maxValue: 4 })),
				transactionTtlMs: testCase.draw(generators.integers({ minValue: 1, maxValue: 30 })),
				completionTtlMs: testCase.draw(generators.integers({ minValue: 1, maxValue: 30 })),
			});
			testCase.note(
				JSON.stringify({
					capacity: state.maxTransactions,
					transactionTtlMs: state.transactionTtlMs,
					completionTtlMs: state.completionTtlMs,
				}),
			);
			exercisePrincipalAndFirstUse(state);
			exerciseCancellation(state);
			exerciseCapacityAndExpiry(state);
			// Act / Assert: the independent model checks every retained record after every step.
			await hegel.stateful.runAsync(testCase, ceremonyMachine, state, { stepCount: 50 });
		},
		{ testCases: 100, seed: 20261117, derandomize: true, database: hegel.Database.disabled },
	);
});
