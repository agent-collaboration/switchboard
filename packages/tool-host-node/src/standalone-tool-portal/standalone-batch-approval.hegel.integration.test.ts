import * as hegel from '@hegeldev/hegel';
import { expect, it } from 'vitest';

import {
	createStandaloneToolPortalApprovalCoordinator,
	createStandaloneToolPortalApprovalToken,
	type StandaloneToolPortalApprovalBatchIntent,
	type StandaloneToolPortalApprovalCoordinator,
	type StandaloneToolPortalApprovalReservation,
} from '#node-host/standalone-tool-portal/standalone-batch-approval';

const intent: StandaloneToolPortalApprovalBatchIntent = {
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
	protectedCalls: [
		{
			call: { id: 'call', name: 'write', namespace: 'alpha', arguments: {} },
			operationId: 'operation',
		},
	],
	semanticRevisions: {
		activeRevision: 'one',
		bindingRevision: 'one',
		catalogRevision: 'one',
		profilePolicyRevision: 'one',
		providerRevision: 'one',
		schemaRevision: 'one',
	},
	surfaceClass: 'mcp',
};
const token = createStandaloneToolPortalApprovalToken({
	intent,
	expiresAt: '2026-01-01T00:01:00.000Z',
	hmacKey: 'synthetic-key',
	keyVersion: 1,
	tokenId: '019b76da-a800-7000-8000-000000000001',
});
type Status = 'fresh' | 'reserved' | 'armed' | 'proven';
interface Scenario {
	readonly coordinator: StandaloneToolPortalApprovalCoordinator;
	status: Status;
	reservation: StandaloneToolPortalApprovalReservation | undefined;
}
const machine: hegel.stateful.StateMachine<Scenario> = {
	rules: {
		reserve: (tc, scenario) => {
			tc.note(`reserve status=${scenario.status}`);
			const result = scenario.coordinator.reserveDispatch(intent, token);
			switch (scenario.status) {
				case 'fresh':
					expect(result.kind).toBe('dispatch-reserved');
					if (result.kind !== 'dispatch-reserved') throw new Error('Expected reservation');
					scenario.reservation = result.reservation;
					scenario.status = 'reserved';
					break;
				case 'reserved':
				case 'proven':
					expect(result).toEqual({ kind: 'not-dispatched', reason: 'consumed-without-dispatch' });
					break;
				case 'armed':
					expect(result).toEqual({ kind: 'ambiguous', reason: 'dispatch-armed' });
					break;
				default:
					scenario.status satisfies never;
			}
		},
		arm: (tc, scenario) => {
			tc.note(`arm status=${scenario.status}`);
			if (scenario.reservation === undefined) return;
			const result = scenario.coordinator.armDispatch(scenario.reservation);
			if (scenario.status === 'reserved') {
				expect(result.kind).toBe('dispatch-authorized');
				scenario.status = 'armed';
			} else if (scenario.status === 'armed')
				expect(result).toEqual({ kind: 'ambiguous', reason: 'dispatch-armed' });
			else expect(result).toEqual({ kind: 'not-dispatched', reason: 'consumed-without-dispatch' });
		},
		prove: (tc, scenario) => {
			tc.note(`prove status=${scenario.status}`);
			if (scenario.reservation === undefined) return;
			const result = scenario.coordinator.proveNotDispatched(scenario.reservation);
			expect(result).toBe(scenario.status === 'reserved');
			if (scenario.status === 'reserved') scenario.status = 'proven';
		},
	},
	invariants: {
		reservationMatchesModel: {
			alwaysCheck: true,
			check: (_tc, scenario) => {
				expect(scenario.reservation === undefined).toBe(scenario.status === 'fresh');
			},
		},
	},
};
it('models token reservation, arming, proof and replay', async () => {
	await hegel.testAsync(
		async (tc) => {
			const coordinator = createStandaloneToolPortalApprovalCoordinator({
				credentials: [{ agentId: 'agent-a', hmacKey: 'synthetic-key', keyVersion: 1 }],
				now: () => new Date('2026-01-01T00:00:00.000Z'),
				serviceGeneration: 'generation',
			});
			await hegel.stateful.runAsync(
				tc,
				machine,
				{ coordinator, status: 'fresh', reservation: undefined },
				{ stepCount: 50 },
			);
		},
		{ testCases: 100, derandomize: true, database: hegel.Database.disabled },
	);
});
