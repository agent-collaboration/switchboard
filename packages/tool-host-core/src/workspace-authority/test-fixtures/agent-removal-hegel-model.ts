import type { AgentManagementAuthority, AgentRemoval } from '@agent-collaboration/tool-host-core';
import * as hegel from '@hegeldev/hegel';
import * as generators from '@hegeldev/hegel/generators';
import { expect } from 'vitest';

// Synthetic, fixed UUIDv7 identities. No clock or random UUID source enters the model.
const clientIds = [
	'019a9310-0000-7000-8000-000000000001',
	'019a9310-0000-7000-8000-000000000002',
] as const;
const requestIds = [
	'019a9310-0000-7000-8000-000000000101',
	'019a9310-0000-7000-8000-000000000102',
	'019a9310-0000-7000-8000-000000000103',
] as const;

interface AgentModel {
	readonly clientId: string;
	persona: string | null;
	removal: AgentRemoval | null;
}
interface RemovalScenario {
	readonly authority: AgentManagementAuthority;
	readonly agents: readonly AgentModel[];
}
type BeginIntent = Parameters<AgentManagementAuthority['beginAgentRemoval']>[2];
type BeginDecision =
	| { readonly kind: 'refused' }
	| { readonly kind: 'accepted'; readonly removal: AgentRemoval };

const removalConflictMessages = [
	'Agent removal prevents admission',
	'Pending membership replacement conflicts',
	'Pending membership operation conflicts',
	'Membership operation intent conflicts',
	'Retired client cannot be changed',
	'Membership operation conflicts',
	'Membership still active',
] as const;

async function expectConflict(action: Promise<unknown>): Promise<void> {
	let refused = false;
	try {
		await action;
	} catch (error: unknown) {
		if (
			!(error instanceof Error) ||
			!removalConflictMessages.some((message) => error.message === message)
		)
			throw error;
		refused = true;
	}
	expect(refused, 'the authority must refuse this transition').toBe(true);
}

function canAdmit(agent: AgentModel): boolean {
	return (
		agent.removal === null ||
		(agent.removal.kind === 'complete' && agent.removal.operation === 'unlink')
	);
}

// Independent transition table: the model records caller-visible membership and intent,
// never storage rows or a production decision helper.
function decideBegin(agent: AgentModel, requestId: string, intent: BeginIntent): BeginDecision {
	const previous = agent.removal;
	const pending = {
		kind: 'pending',
		operation: intent.operation,
		requestId,
	} satisfies AgentRemoval;
	if (intent.replacesPendingRequestId !== undefined) {
		return previous?.kind === 'pending' &&
			previous.operation === intent.operation &&
			previous.requestId === intent.replacesPendingRequestId &&
			requestId !== previous.requestId
			? { kind: 'accepted', removal: pending }
			: { kind: 'refused' };
	}
	if (previous === null) return { kind: 'accepted', removal: pending };
	if (previous.requestId === requestId) {
		return previous.operation === intent.operation
			? { kind: 'accepted', removal: previous }
			: { kind: 'refused' };
	}
	if (previous.operation === 'disable') return { kind: 'refused' };
	if (previous.kind === 'pending' && intent.operation === 'unlink') return { kind: 'refused' };
	return { kind: 'accepted', removal: pending };
}

function drawAgent(tc: hegel.TestCase, scenario: RemovalScenario): AgentModel {
	return tc.draw(generators.sampledFrom(scenario.agents));
}

async function admitAgent(
	tc: hegel.TestCase,
	scenario: RemovalScenario,
	agent: AgentModel,
): Promise<void> {
	const persona = tc.draw(generators.sampledFrom(['reader', 'operator', 'é-reader']));
	tc.note(`admit ${agent.clientId} persona=${persona} removal=${JSON.stringify(agent.removal)}`);
	const action = scenario.authority.setMembership(agent.clientId, persona);
	if (!canAdmit(agent)) await expectConflict(action);
	else {
		await action;
		agent.persona = persona;
	}
}

async function beginRemoval(props: {
	readonly tc: hegel.TestCase;
	readonly scenario: RemovalScenario;
	readonly agent: AgentModel;
	readonly requestId: string;
	readonly intent: BeginIntent;
}): Promise<void> {
	const { tc, scenario, agent, requestId, intent } = props;
	tc.note(
		`begin ${agent.clientId} request=${requestId} intent=${JSON.stringify(intent)} previous=${JSON.stringify(agent.removal)}`,
	);
	const expected = decideBegin(agent, requestId, intent);
	const action = scenario.authority.beginAgentRemoval(agent.clientId, requestId, intent);
	switch (expected.kind) {
		case 'refused':
			await expectConflict(action);
			return;
		case 'accepted':
			expect(await action).toEqual(expected.removal);
			agent.persona = null;
			agent.removal = expected.removal;
			return;
		default:
			expected satisfies never;
	}
}

const removalMachine: hegel.stateful.StateMachine<RemovalScenario> = {
	rules: {
		admit: async (tc, scenario) => admitAgent(tc, scenario, drawAgent(tc, scenario)),
		beginUnlink: async (tc, scenario) =>
			beginRemoval({
				tc,
				scenario,
				agent: drawAgent(tc, scenario),
				requestId: tc.draw(generators.sampledFrom(requestIds)),
				intent: { operation: 'unlink' },
			}),
		beginDisable: async (tc, scenario) =>
			beginRemoval({
				tc,
				scenario,
				agent: drawAgent(tc, scenario),
				requestId: tc.draw(generators.sampledFrom(requestIds)),
				intent: { operation: 'disable' },
			}),
		repeatSameRequestAndIntent: async (tc, scenario) => {
			const agent = drawAgent(tc, scenario);
			tc.assume(agent.removal !== null);
			if (agent.removal === null) return;
			await beginRemoval({
				tc,
				scenario,
				agent,
				requestId: agent.removal.requestId,
				intent: { operation: agent.removal.operation },
			});
		},
		conflictingIntentForSameRequest: async (tc, scenario) => {
			const agent = drawAgent(tc, scenario);
			tc.assume(agent.removal !== null);
			if (agent.removal === null) return;
			await beginRemoval({
				tc,
				scenario,
				agent,
				requestId: agent.removal.requestId,
				intent: { operation: agent.removal.operation === 'unlink' ? 'disable' : 'unlink' },
			});
		},
		replacePendingRequest: async (tc, scenario) => {
			const agent = drawAgent(tc, scenario);
			await beginRemoval({
				tc,
				scenario,
				agent,
				requestId: tc.draw(generators.sampledFrom(requestIds)),
				intent: {
					operation: tc.draw(generators.sampledFrom(['unlink', 'disable'] as const)),
					replacesPendingRequestId: tc.draw(generators.sampledFrom(requestIds)),
				},
			});
		},
		completeMatchingRemovalAndReadmitAfterUnlink: async (tc, scenario) => {
			const agent = drawAgent(tc, scenario);
			tc.assume(agent.removal !== null);
			if (agent.removal === null) return;
			const { requestId, operation } = agent.removal;
			tc.note(`complete ${agent.clientId} ${requestId} ${operation} persona=${agent.persona}`);
			const action = scenario.authority.completeAgentRemoval(agent.clientId, requestId, operation);
			if (agent.persona !== null) await expectConflict(action);
			else {
				await action;
				agent.removal = { kind: 'complete', requestId, operation };
				expect(await scenario.authority.readMembership(agent.clientId)).toBeNull();
				expect(await scenario.authority.readAgentRemoval(agent.clientId)).toEqual(agent.removal);
				// A successful unlink must permit a fresh authorized admission, in the same sequence.
				if (operation === 'unlink') await admitAgent(tc, scenario, agent);
			}
		},
		completeConflictingRemoval: async (tc, scenario) => {
			const agent = drawAgent(tc, scenario);
			tc.assume(agent.removal !== null);
			if (agent.removal === null) return;
			const operation = agent.removal.operation === 'unlink' ? 'disable' : 'unlink';
			tc.note(`conflicting complete ${agent.clientId} ${agent.removal.requestId} ${operation}`);
			await expectConflict(
				scenario.authority.completeAgentRemoval(agent.clientId, agent.removal.requestId, operation),
			);
		},
	},
	invariants: {
		membershipAndRemovalMatchIndependentModel: {
			alwaysCheck: true,
			check: async (_tc, scenario) => {
				await Promise.all(
					scenario.agents.map(async (agent): Promise<void> => {
						expect(await scenario.authority.readMembership(agent.clientId)).toEqual(
							agent.persona === null ? null : { persona: agent.persona },
						);
						expect(await scenario.authority.readAgentRemoval(agent.clientId)).toEqual(
							agent.removal,
						);
					}),
				);
			},
		},
		pendingRemovalAndDisableRefuseAdmission: {
			alwaysCheck: true,
			check: async (tc, scenario) => {
				await Promise.all(
					scenario.agents.map(async (agent): Promise<void> => {
						if (canAdmit(agent)) return;
						tc.note(`forbidden admission probe ${agent.clientId} ${JSON.stringify(agent.removal)}`);
						await expectConflict(
							scenario.authority.setMembership(agent.clientId, 'forbidden-reader'),
						);
						expect(await scenario.authority.readMembership(agent.clientId)).toBeNull();
						expect(await scenario.authority.readAgentRemoval(agent.clientId)).toEqual(
							agent.removal,
						);
					}),
				);
			},
		},
	},
};

export async function runAgentRemovalModel(
	tc: hegel.TestCase,
	authority: AgentManagementAuthority,
): Promise<void> {
	await hegel.stateful.runAsync(
		tc,
		removalMachine,
		{
			authority,
			agents: clientIds.map((clientId): AgentModel => ({ clientId, persona: null, removal: null })),
		},
		{ stepCount: 50 },
	);
}
