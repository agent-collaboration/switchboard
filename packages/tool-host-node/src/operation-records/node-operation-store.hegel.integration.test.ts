import {
	dispatchInvocationSchema,
	type DispatchInvocation,
	type OperationRecord,
} from '@agent-collaboration/tool-engine/capability-dispatch';
import * as hegel from '@hegeldev/hegel';
import * as generators from '@hegeldev/hegel/generators';
import { expect, it } from 'vitest';

import {
	openNodeOperationStore,
	type NodeOperationStore,
} from '#node-host/operation-records/node-operation-store';

const revision = { owner: 'fixture', revision: 'v1' };
function invocation(): DispatchInvocation {
	return dispatchInvocationSchema.parse({
		version: 'tool-dispatch-v1',
		authority: 'authority',
		operationKey: { authority: 'authority', principal: 'caller-a', item: 'one' },
		capability: { namespace: 'alpha', tool: 'read' },
		arguments: { value: 42 },
		backendKind: 'mcp_provider',
		bindingRevision: revision,
		admissionRevisions: {
			hostConfig: revision,
			registration: null,
			workspaceAllowance: null,
			profile: revision,
			assignment: revision,
			surfaceSnapshot: revision,
			upstreamBinding: revision,
			accounts: [],
		},
		verifiedContextRef: 'verified-a',
		approvalReceiptRef: null,
		surface: 'mcp',
		correlation: {},
		intentDigest: 'a'.repeat(64),
	});
}
const states: readonly OperationRecord['state'][] = [
	{ kind: 'ready' },
	{ kind: 'pending', reference: 'approval' },
	{ kind: 'armed' },
	{ kind: 'completed', result: { value: 42 } },
	{ kind: 'ambiguous', reason: 'unknown' },
	{ kind: 'result-expired' },
];
const allowed: Readonly<
	Record<OperationRecord['state']['kind'], readonly OperationRecord['state']['kind'][]>
> = {
	ready: ['pending', 'armed'],
	pending: ['armed'],
	armed: ['completed', 'ambiguous'],
	completed: ['result-expired'],
	ambiguous: [],
	'result-expired': [],
};
interface Scenario {
	readonly store: NodeOperationStore;
	readonly call: DispatchInvocation;
	state: OperationRecord['state'];
	revision: string;
}
async function transition(
	scenario: Scenario,
	next: OperationRecord['state'],
	stale: boolean,
): Promise<void> {
	const permitted = !stale && allowed[scenario.state.kind].includes(next.kind);
	const outcome = await scenario.store.transition({
		invocation: scenario.call,
		expectedRevision: stale ? 'stale-revision' : scenario.revision,
		next,
	});
	if (permitted) {
		expect(outcome.kind).toBe('found');
		if (outcome.kind !== 'found') throw new Error('Expected transition');
		expect(outcome.record.state).toEqual(next);
		expect(outcome.record.revision).not.toBe(scenario.revision);
		scenario.state = next;
		scenario.revision = outcome.record.revision;
	} else expect(outcome.kind).toBe('conflict');
}
const machine: hegel.stateful.StateMachine<Scenario> = {
	rules: {
		tryTransition: async (tc, scenario) => {
			const next = tc.draw(generators.sampledFrom(states));
			const stale = tc.draw(generators.sampledFrom([true, false]));
			tc.note(`${scenario.state.kind} -> ${next.kind}, stale=${stale}`);
			await transition(scenario, next, stale);
		},
	},
	invariants: {
		persistedStateMatches: {
			alwaysCheck: true,
			check: async (_tc, scenario) => {
				const result = await scenario.store.lookup({
					version: 'tool-operation-v1',
					key: scenario.call.operationKey,
					verifiedContextRef: 'verified-a',
				});
				expect(result).toMatchObject({
					kind: 'found',
					record: { state: scenario.state, revision: scenario.revision },
				});
			},
		},
	},
};
it('models allowed operation transitions and revision conflicts', async () => {
	await hegel.testAsync(
		async (tc) => {
			const store = await openNodeOperationStore({
				directory: 'unused',
				authority: 'authority',
				authorize: () => true,
				now: () => 0,
			});
			const call = invocation();
			const created = await store.createOrRead({ invocation: call, requiresApproval: true });
			if (created.kind !== 'created') throw new Error('Expected new operation');
			const scenario: Scenario = {
				store,
				call,
				state: { kind: 'ready' },
				revision: created.record.revision,
			};
			try {
				await hegel.stateful.runAsync(tc, machine, scenario, { stepCount: 50 });
			} finally {
				await store.close();
			}
		},
		{ testCases: 100, derandomize: true, database: hegel.Database.disabled },
	);
});
