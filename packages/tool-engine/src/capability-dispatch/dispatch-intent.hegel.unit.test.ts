import * as hegel from '@hegeldev/hegel';
import * as generators from '@hegeldev/hegel/generators';
import { expect, it } from 'vitest';

import { canonicalDispatchJson, dispatchIntentDigest } from '#capability-dispatch/dispatch-intent';
import type { DispatchInvocation } from '#capability-dispatch/models/dispatch-contracts';

function invocation(value: number): DispatchInvocation {
	const revision = { owner: 'owner', revision: 'r1' };
	return {
		version: 'tool-dispatch-v1',
		authority: 'authority',
		operationKey: { authority: 'authority', principal: 'principal', item: 'item' },
		capability: { namespace: 'fixture', tool: 'read' },
		arguments: { a: value, z: '雪' },
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
		verifiedContextRef: 'context',
		approvalReceiptRef: null,
		surface: 'mcp',
		correlation: {},
		intentDigest: '0'.repeat(64),
	};
}

it('retains independently frozen intent bytes and SHA-256 digest', async () => {
	const bytes =
		'{"arguments":{"a":1,"z":"雪"},"authority":"authority","backendKind":"mcp_provider","bindingRevision":{"owner":"owner","revision":"r1"},"capability":{"namespace":"fixture","tool":"read"},"surface":"mcp","version":"tool-intent-v1"}';
	expect(
		canonicalDispatchJson({
			arguments: { z: '雪', a: 1 },
			authority: 'authority',
			backendKind: 'mcp_provider',
			bindingRevision: { revision: 'r1', owner: 'owner' },
			capability: { tool: 'read', namespace: 'fixture' },
			surface: 'mcp',
			version: 'tool-intent-v1',
		}),
	).toBe(bytes);
	expect(await dispatchIntentDigest(invocation(1))).toBe(
		'd1c163079dbcd33d65351d75ee39489b81aa387dc8d38a9d89d108083dcf5a8f',
	);
});

it('binds every committed intent field while ignoring object insertion order and noncommitted fields', async () => {
	await hegel.testAsync(
		async (tc) => {
			const value = tc.draw(generators.integers({ minValue: 1, maxValue: 100000 }));
			tc.note(`value=${value}`);
			const input = invocation(value);
			const digest = await dispatchIntentDigest(input);
			expect(
				await dispatchIntentDigest({
					...input,
					arguments: { z: '雪', a: value },
					correlation: { ignored: value },
					verifiedContextRef: `context-${value}`,
					operationKey: { ...input.operationKey, item: `item-${value}` },
				}),
			).toBe(digest);
			const changed = [
				{ ...input, authority: `authority-${value}` },
				{ ...input, capability: { ...input.capability, namespace: `namespace-${value}` } },
				{ ...input, capability: { ...input.capability, tool: `tool-${value}` } },
				{ ...input, arguments: { ...input.arguments, a: value + 1 } },
				{ ...input, backendKind: 'tool_vm_runner' as const },
				{ ...input, bindingRevision: { ...input.bindingRevision, owner: `owner-${value}` } },
				{ ...input, bindingRevision: { ...input.bindingRevision, revision: `revision-${value}` } },
				{ ...input, surface: 'protected_uds' as const },
			];
			await Promise.all(
				changed.map(async (entry) => expect(await dispatchIntentDigest(entry)).not.toBe(digest)),
			);
		},
		{ testCases: 500, seed: 20261117, derandomize: true, database: hegel.Database.disabled },
	);
});
