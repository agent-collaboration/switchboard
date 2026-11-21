import { assessAccessInput } from '@agent-collaboration/tool-access/contracts';
import {
	dispatchInvocationSchema,
	type BackendKind,
	type DispatchInvocation,
	type ToolBackend,
} from '@agent-collaboration/tool-engine/capability-dispatch';
import type { StandalonePortalCallPlan } from '@agent-collaboration/tool-engine/standalone-tool-portal';
import * as hegel from '@hegeldev/hegel';
import * as generators from '@hegeldev/hegel/generators';
import { expect, it } from 'vitest';

import type {
	NodeStandaloneInvocation,
	StandaloneToolPortalInvocationOptions,
} from '#node-host/standalone-tool-portal/models/standalone-portal-contracts';
import {
	createStandaloneToolPortalApprovalCoordinator,
	createStandaloneToolPortalApprovalToken,
} from '#node-host/standalone-tool-portal/standalone-batch-approval';
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
const semanticRevisions = {
	activeRevision: 'one',
	bindingRevision: 'one',
	catalogRevision: 'one',
	profilePolicyRevision: 'one',
	providerRevision: 'one',
	schemaRevision: 'one',
};
const expiry = 60_000;
function makeInvocation(item: string): DispatchInvocation {
	return dispatchInvocationSchema.parse({
		version: 'tool-dispatch-v1',
		authority: 'authority',
		operationKey: { authority: 'authority', principal: 'caller-a', item },
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
}
interface OperationModel {
	readonly plan: StandalonePortalCallPlan;
	readonly invocation: DispatchInvocation;
	recordRevision: string | undefined;
	receipt: string | undefined;
	armed: boolean;
	dispatched: boolean;
}
interface Scenario {
	readonly backend: ToolBackend<BackendKind>;
	readonly prepared: Awaited<ReturnType<typeof prepareStandaloneBatchDispatch>>;
	readonly operations: readonly OperationModel[];
	readonly effects: Map<string, number>;
	readonly clock: { now: number };
	readonly reached: Set<string>;
	result: { actual: string; expected: string } | undefined;
}
const machine: hegel.stateful.StateMachine<Scenario> = {
	rules: {
		createAndArm: async (tc, scenario) => {
			const operation = tc.draw(generators.sampledFrom(scenario.operations));
			tc.note(`arm ${operation.plan.operationId}`);
			if (!operation.plan.requiresApproval || operation.armed || scenario.clock.now >= expiry)
				return;
			const created = await scenario.prepared.operations.createOrRead({
				invocation: operation.invocation,
				requiresApproval: true,
			});
			expect(created.kind).toBe('created');
			if (created.kind !== 'created') throw new Error('Expected operation');
			const decision = await scenario.prepared.approvals.challenge(operation.invocation);
			expect(decision.kind).toBe('approved');
			if (decision.kind !== 'approved') throw new Error('Expected receipt');
			operation.receipt = decision.receipt.reference;
			const armed = await scenario.prepared.operations.transition({
				invocation: { ...operation.invocation, approvalReceiptRef: operation.receipt },
				expectedRevision: created.record.revision,
				next: { kind: 'armed' },
			});
			expect(armed.kind).toBe('found');
			if (armed.kind !== 'found') throw new Error('Expected armed operation');
			operation.recordRevision = armed.record.revision;
			operation.armed = true;
		},
		invoke: async (tc, scenario) => {
			const operation = tc.draw(generators.sampledFrom(scenario.operations));
			const correctReceipt = tc.draw(generators.sampledFrom([true, false]));
			const receipt = correctReceipt ? (operation.receipt ?? null) : 'wrong-receipt';
			const approved =
				!operation.plan.requiresApproval ||
				(scenario.clock.now < expiry && operation.armed && receipt === operation.receipt);
			const expected = !operation.dispatched && approved ? 'completed' : 'not-dispatched';
			if (operation.plan.requiresApproval && !operation.dispatched) {
				if (!operation.armed && scenario.clock.now < expiry) scenario.reached.add('unarmed');
				if (operation.armed && scenario.clock.now < expiry && !correctReceipt)
					scenario.reached.add('wrong-receipt');
				if (operation.armed && scenario.clock.now < expiry && correctReceipt)
					scenario.reached.add('approved');
				if (operation.armed && scenario.clock.now >= expiry && correctReceipt)
					scenario.reached.add('expired');
			}
			if (operation.dispatched) scenario.reached.add('replay');
			tc.note(
				`invoke ${operation.plan.operationId} armed=${operation.armed} receipt=${correctReceipt} time=${scenario.clock.now} dispatched=${operation.dispatched}`,
			);
			const result = await scenario.backend.invoke({
				...operation.invocation,
				approvalReceiptRef: receipt,
			});
			if (expected === 'completed') operation.dispatched = true;
			scenario.result = { actual: result.kind, expected };
		},
		expire: (_tc, scenario) => {
			scenario.clock.now = expiry;
		},
	},
	invariants: {
		oneEffect: {
			alwaysCheck: true,
			check: (_tc, scenario) => {
				for (const operation of scenario.operations)
					expect(scenario.effects.get(operation.plan.operationId) ?? 0).toBe(
						operation.dispatched ? 1 : 0,
					);
				if (scenario.result !== undefined)
					expect(scenario.result.actual).toBe(scenario.result.expected);
			},
		},
	},
};
it('models independent protected and unprotected operation effects, approval gates and replay', async () => {
	const reached = new Set<string>();
	await hegel.testAsync(
		async (tc) => {
			const protectedSecond = tc.draw(generators.sampledFrom([true, false]));
			const operations: OperationModel[] = ['one', 'two', 'three'].map((name, index) => {
				const operationId = `operation-${name}`;
				const call = { id: `call-${name}`, name: 'read', namespace: 'alpha', arguments: {} };
				const plan: StandalonePortalCallPlan = {
					call,
					operationId,
					requiresApproval: index === 0 || (index === 1 && protectedSecond),
					request: {
						authority: 'authority',
						principal: 'caller-a',
						item: operationId,
						verifiedContextRef: 'verified-a',
						correlation: {},
						access,
					},
				};
				return {
					plan,
					invocation: makeInvocation(operationId),
					recordRevision: undefined,
					receipt: undefined,
					armed: false,
					dispatched: false,
				};
			});
			const intent = {
				authenticatedEnvelope: options.authenticatedEnvelope,
				protectedCalls: operations
					.filter((operation) => operation.plan.requiresApproval)
					.map(({ plan }) => ({ call: plan.call, operationId: plan.operationId })),
				semanticRevisions,
				surfaceClass: options.surfaceClass,
			};
			const token = createStandaloneToolPortalApprovalToken({
				intent,
				expiresAt: new Date(expiry).toISOString(),
				hmacKey: 'synthetic-key',
				keyVersion: 1,
				tokenId: '019b76da-a800-7000-8000-000000000001',
			});
			const effects = new Map<string, number>();
			const selected: NodeStandaloneInvocation = {
				authority: 'authority',
				principal: 'caller-a',
				verifiedContextRef: 'verified-a',
				owningGeneration: 'generation',
				correlation: {},
				entries: [],
				readOptions: options,
				operationId: (id) => id,
				accessForCall: async () => access,
				semanticRevisions,
				invoke: async ({ call, invocation }) => {
					const operationId = invocation.operationKey.item;
					effects.set(operationId, (effects.get(operationId) ?? 0) + 1);
					return {
						id: call.id,
						operationId,
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
			const clock = { now: 0 };
			const coordinator = createStandaloneToolPortalApprovalCoordinator({
				credentials: [{ agentId: 'agent-a', hmacKey: 'synthetic-key', keyVersion: 1 }],
				now: () => new Date(clock.now),
				serviceGeneration: 'generation',
			});
			const prepared = await prepareStandaloneBatchDispatch({
				plans: operations.map(({ plan }) => plan),
				options: { ...options, approvalToken: token },
				selected,
				coordinator,
				now: () => clock.now,
				receiptReference: () => 'receipt',
				validateCurrent: async () => true,
			});
			const backend = prepared.backends.get('mcp_provider');
			if (backend === undefined) throw new Error('Missing backend');
			try {
				await hegel.stateful.runAsync(
					tc,
					machine,
					{ backend, prepared, operations, effects, clock, reached, result: undefined },
					{ stepCount: 50 },
				);
			} finally {
				prepared.release();
			}
		},
		{ testCases: 100, seed: 20261117, derandomize: true, database: hegel.Database.disabled },
	);
	expect([...reached].toSorted()).toEqual([
		'approved',
		'expired',
		'replay',
		'unarmed',
		'wrong-receipt',
	]);
});
