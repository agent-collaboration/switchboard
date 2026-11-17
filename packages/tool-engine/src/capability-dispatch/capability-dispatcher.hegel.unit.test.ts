import { createAccessAssessor } from '@agent-collaboration/tool-access/authorization';
import { assessAccessInput } from '@agent-collaboration/tool-access/contracts';
import {
	createCapabilityDispatcher,
	type ApprovalPort,
	type ApprovalReceipt,
	type BackendKind,
	type DispatchInvocation,
	type DispatchRequest,
	type OperationPort,
	type OperationRecord,
	type ToolBackend,
	type ResourceResult,
} from '@agent-collaboration/tool-engine/capability-dispatch';
import * as hegel from '@hegeldev/hegel';
import * as generators from '@hegeldev/hegel/generators';
import { expect, it, vi } from 'vitest';

import { projectManagedAccessProfile } from '#legacy-gateway-runtime/managed-tool-engine/managed-access/access-profile-projection.js';
import { toolPortalConfig } from '#legacy-gateway-runtime/managed-tool-engine/test-fixtures/managed-profile-test-fixture.js';

const revision = { owner: 'controller', revision: 'policy:1' };
const now = Date.parse('2026-10-20T12:00:00.000Z');
function request(): DispatchRequest {
	return {
		authority: 'computer-a',
		principal: 'agent-a',
		item: 'original-item',
		verifiedContextRef: 'issuance-a',
		correlation: {},
		access: assessAccessInput.parse({
			capability: { namespace: 'github', tool: 'get_issue' },
			surface: 'protected_uds',
			call: { arguments: { issue: 42 }, account: null, digest: 'a'.repeat(64) },
			facts: {
				workspace: { kind: 'not-configured' },
				assignment: {
					profile: projectManagedAccessProfile({
						config: toolPortalConfig,
						profileId: 'gate-c-profile',
					}),
					profileRevision: revision,
					revision,
				},
				surface: { eligible: ['protected_uds'], snapshot: revision },
				accounts: [],
				upstream: { status: 'available', credentialNeed: 'none', binding: revision },
			},
		}),
	};
}
function requireApproval(input: DispatchRequest): void {
	const policy = input.access.facts.assignment.profile.namespaces.github;
	if (policy === undefined) throw new Error('Missing fixture policy.');
	policy.calls = {
		kind: 'selectors',
		withoutApproval: { allow: [], deny: [] },
		requiresApproval: { allow: ['get_issue'], deny: [] },
	};
}
function harness(backendResult: ResourceResult = { kind: 'completed', result: { issue: 42 } }): {
	dispatcher: ReturnType<typeof createCapabilityDispatcher>;
	invocations: DispatchInvocation[];
	operations: OperationPort;
	approvals: ApprovalPort;
	keys: DispatchInvocation['operationKey'][];
} {
	const invocations: DispatchInvocation[] = [];
	const keys: DispatchInvocation['operationKey'][] = [];
	const records = new Map<string, OperationRecord>();
	const operations: OperationPort = {
		createOrRead: async ({ invocation }) => {
			keys.push(invocation.operationKey);
			const key = JSON.stringify(invocation.operationKey);
			const old = records.get(key);
			if (old !== undefined)
				return old.intentDigest === invocation.intentDigest
					? { kind: 'existing', record: old }
					: { kind: 'conflict' };
			const record: OperationRecord = {
				version: 'tool-operation-v1',
				key: invocation.operationKey,
				intentDigest: invocation.intentDigest,
				createdAt: new Date(now).toISOString(),
				updatedAt: new Date(now).toISOString(),
				revision: '1',
				state: { kind: 'ready' },
			};
			records.set(key, record);
			return { kind: 'created', record };
		},
		lookup: async ({ key }) => {
			const record = records.get(JSON.stringify(key));
			return record === undefined ? { kind: 'not-found' } : { kind: 'found', record };
		},
		transition: async ({ invocation, expectedRevision, next }) => {
			const key = JSON.stringify(invocation.operationKey);
			const record = records.get(key);
			if (record === undefined || record.revision !== expectedRevision) return { kind: 'conflict' };
			const updated = { ...record, revision: String(Number(record.revision) + 1), state: next };
			records.set(key, updated);
			return { kind: 'found', record: updated };
		},
	};
	function receipt(invocation: DispatchInvocation): ApprovalReceipt {
		return {
			reference: 'receipt:1',
			decision: 'approve',
			authoritativeRevision: revision,
			operationKey: invocation.operationKey,
			intentDigest: invocation.intentDigest,
			backendKind: invocation.backendKind,
			bindingRevision: invocation.bindingRevision,
			admissionRevisions: invocation.admissionRevisions,
			verifiedContextRef: invocation.verifiedContextRef,
			expiresAt: '2026-10-20T13:00:00.000Z',
		};
	}
	const approvals: ApprovalPort = {
		challenge: async (invocation) => ({ kind: 'approved', receipt: receipt(invocation) }),
		receipt: async ({ invocation }) => ({ kind: 'approved', receipt: receipt(invocation) }),
		decision: async () => ({ kind: 'denied' }),
	};
	const backend: ToolBackend<BackendKind> = {
		backendKind: 'mcp_provider',
		list: async () => ({}),
		describe: async () => ({}),
		search: async () => ({}),
		invoke: async (invocation) => {
			invocations.push(invocation);
			return backendResult;
		},
	};
	return {
		invocations,
		operations,
		approvals,
		keys,
		dispatcher: createCapabilityDispatcher({
			assessAccess: createAccessAssessor({ workspaceLayer: 'not-configured', config: revision }),
			operations,
			approvals,
			backends: new Map([['mcp_provider', backend]]),
			now: () => now,
		}),
	};
}

it('requires both offered and current receipts to match every invocation binding', async () => {
	await hegel.testAsync(
		async (tc) => {
			const value = tc.draw(generators.integers({ minValue: 1, maxValue: 100000 }));
			tc.note(`receipt mismatch suffix=${value}`);
			const fields = [
				'authority',
				'principal',
				'item',
				'digest',
				'backend',
				'binding',
				'admission',
				'context',
				'expiry',
				'reference',
			] as const;
			await Promise.all(
				(['challenge', 'receipt'] as const).flatMap((stage) =>
					fields
						.filter((field) => stage !== 'challenge' || field !== 'reference')
						.map(async (field) => {
							const subject = harness();
							const input = request();
							requireApproval(input);
							if (stage === 'challenge') {
								const original = subject.approvals.challenge;
								vi.spyOn(subject.approvals, 'challenge').mockImplementation(async (invocation) => {
									const result = await original(invocation);
									if (result.kind !== 'approved') throw new Error('Fixture must approve');
									mutateReceipt(result.receipt, field, value);
									return result;
								});
							} else {
								const originalReceipt = subject.approvals.receipt;
								vi.spyOn(subject.approvals, 'receipt').mockImplementation(async (props) => {
									const result = await originalReceipt(props);
									if (result.kind !== 'approved') throw new Error('Fixture must approve');
									mutateReceipt(result.receipt, field, value);
									return result;
								});
							}
							expect((await subject.dispatcher.dispatch(input)).kind).not.toBe('completed');
							expect(subject.invocations).toEqual([]);
						}),
				),
			);
			const subject = harness();
			const input = request();
			requireApproval(input);
			expect((await subject.dispatcher.dispatch(input)).kind).toBe('completed');
			expect(subject.invocations).toHaveLength(1);
		},
		{ testCases: 500, derandomize: true, database: hegel.Database.disabled },
	);
});

function mutateReceipt(
	receipt: ApprovalReceipt,
	field:
		| 'authority'
		| 'principal'
		| 'item'
		| 'digest'
		| 'backend'
		| 'binding'
		| 'admission'
		| 'context'
		| 'expiry'
		| 'reference',
	value: number,
): void {
	switch (field) {
		case 'authority':
			receipt.operationKey = { ...receipt.operationKey, authority: `different-${value}` };
			break;
		case 'principal':
			receipt.operationKey = { ...receipt.operationKey, principal: `different-${value}` };
			break;
		case 'item':
			receipt.operationKey = { ...receipt.operationKey, item: `different-${value}` };
			break;
		case 'digest':
			receipt.intentDigest = 'b'.repeat(64);
			break;
		case 'backend':
			receipt.backendKind = 'tool_vm_runner';
			break;
		case 'binding':
			receipt.bindingRevision = { ...revision, revision: `different-${value}` };
			break;
		case 'admission':
			receipt.admissionRevisions = {
				...receipt.admissionRevisions,
				assignment: { ...revision, revision: `different-${value}` },
			};
			break;
		case 'context':
			receipt.verifiedContextRef = `different-${value}`;
			break;
		case 'expiry':
			receipt.expiresAt = new Date(now).toISOString();
			break;
		case 'reference':
			receipt.reference = `different-${value}`;
			break;
		default:
			field satisfies never;
	}
}
