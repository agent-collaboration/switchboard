import { assessAccessInput } from '@agent-collaboration/tool-access/contracts';
import {
	dispatchInvocationSchema,
	type BackendKind,
	type DispatchInvocation,
	type ToolBackend,
} from '@agent-collaboration/tool-engine/capability-dispatch';
import type { StandalonePortalCallPlan } from '@agent-collaboration/tool-engine/standalone-tool-portal';
import * as hegel from '@hegeldev/hegel';
import { expect, it } from 'vitest';

import type {
	NodeStandaloneInvocation,
	StandaloneToolPortalInvocationOptions,
} from '#node-host/standalone-tool-portal/models/standalone-portal-contracts';
import { createStandaloneToolPortalApprovalCoordinator } from '#node-host/standalone-tool-portal/standalone-batch-approval';
import { prepareStandaloneBatchDispatch } from '#node-host/standalone-tool-portal/standalone-batch-dispatch';

const revision = { owner: 'fixture', revision: 'v1' };
const options: StandaloneToolPortalInvocationOptions = {
	authenticatedEnvelope: {
		audience: 'tool-portal:mcp',
		principal: {
			agentId: 'agent-a',
			credentialVersion: 1,
			profileAssignmentRevision: 'revision',
			toolPortalProfileId: 'profile',
		},
		serviceGeneration: 'generation',
	},
	correlation: { sessionId: 'session' },
	surfaceClass: 'mcp',
};
const access = assessAccessInput.parse({
	capability: { namespace: 'alpha', tool: 'read' },
	surface: 'mcp',
	call: { arguments: {}, digest: 'a'.repeat(64), account: null },
	facts: {
		workspace: { kind: 'not-configured' },
		assignment: {
			revision,
			profileRevision: revision,
			profile: { profileId: 'reader', namespaces: {} },
		},
		surface: { eligible: ['mcp'], snapshot: revision },
		accounts: [],
		upstream: { status: 'available', credentialNeed: 'none', binding: revision },
	},
});
const call = { id: 'call-one', name: 'read', namespace: 'alpha', arguments: {} };
const plan: StandalonePortalCallPlan = {
	call,
	operationId: 'operation-one',
	requiresApproval: false,
	request: {
		authority: 'authority',
		principal: 'caller-a',
		item: 'operation-one',
		verifiedContextRef: 'verified-a',
		correlation: {},
		access,
	},
};
const invocation: DispatchInvocation = dispatchInvocationSchema.parse({
	version: 'tool-dispatch-v1',
	authority: 'authority',
	operationKey: { authority: 'authority', principal: 'caller-a', item: 'operation-one' },
	capability: { namespace: 'alpha', tool: 'read' },
	arguments: {},
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
interface Scenario {
	readonly backend: ToolBackend<BackendKind>;
	readonly effects: { count: number };
	attempts: number;
}
const machine: hegel.stateful.StateMachine<Scenario> = {
	rules: {
		invoke: async (tc, scenario) => {
			tc.note(`attempt=${scenario.attempts + 1}`);
			const result = await scenario.backend.invoke(invocation);
			expect(result.kind).toBe(scenario.attempts === 0 ? 'completed' : 'not-dispatched');
			scenario.attempts += 1;
		},
	},
	invariants: {
		oneEffect: {
			alwaysCheck: true,
			check: (_tc, scenario) => {
				expect(scenario.effects.count).toBe(Math.min(scenario.attempts, 1));
			},
		},
	},
};
it('models repeated backend admission while the selected resource runs at most once', async () => {
	await hegel.testAsync(
		async (tc) => {
			const effects = { count: 0 };
			const selected: NodeStandaloneInvocation = {
				authority: 'authority',
				principal: 'caller-a',
				verifiedContextRef: 'verified-a',
				owningGeneration: 'generation',
				correlation: {},
				entries: [],
				readOptions: options,
				operationId: () => 'operation-one',
				accessForCall: async () => access,
				semanticRevisions: {
					activeRevision: 'one',
					bindingRevision: 'one',
					catalogRevision: 'one',
					profilePolicyRevision: 'one',
					providerRevision: 'one',
					schemaRevision: 'one',
				},
				invoke: async () => {
					effects.count += 1;
					return {
						id: call.id,
						operationId: plan.operationId,
						owningGeneration: 'generation',
						status: 'ok',
						outcome: {
							kind: 'completed',
							completion: 'succeeded',
							certainty: 'proven',
							retryClass: 'forbidden',
						},
						value: {},
					};
				},
			};
			const coordinator = createStandaloneToolPortalApprovalCoordinator({
				credentials: [{ agentId: 'agent-a', hmacKey: 'synthetic-key', keyVersion: 1 }],
				now: () => new Date(0),
				serviceGeneration: 'generation',
			});
			const prepared = await prepareStandaloneBatchDispatch({
				plans: [plan],
				options,
				selected,
				coordinator,
				now: () => 0,
				receiptReference: () => 'receipt',
				validateCurrent: async () => true,
			});
			const backend = prepared.backends.get('mcp_provider');
			if (backend === undefined) throw new Error('Missing backend');
			try {
				await hegel.stateful.runAsync(
					tc,
					machine,
					{ backend, effects, attempts: 0 },
					{ stepCount: 50 },
				);
			} finally {
				prepared.release();
			}
		},
		{ testCases: 100, derandomize: true, database: hegel.Database.disabled },
	);
});
