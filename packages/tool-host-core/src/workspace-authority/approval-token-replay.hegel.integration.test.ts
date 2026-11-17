import {
	createInMemoryApprovalTokenUse,
	hashCallArguments,
	signApprovalToken,
	verifyApprovalToken,
} from '@agent-collaboration/tool-engine/mcp-gateway';
import * as hegel from '@hegeldev/hegel';
import * as generators from '@hegeldev/hegel/generators';
import { expect, it } from 'vitest';

import { createApprovalExecutionGateway } from '#tool-host-core/workspace-authority/test-fixtures/approval-execution-gateway';
import { createVolatileAuthorityStore } from '#tool-host-core/workspace-authority/volatile-authority-store';
import { createWorkspaceAuthority } from '#tool-host-core/workspace-authority/workspace-authority';

interface ReplayScenario {
	readonly clock: { now: number };
	readonly memory: ReturnType<typeof createInMemoryApprovalTokenUse>;
	readonly store: ReturnType<typeof createVolatileAuthorityStore>;
	readonly authority: ReturnType<typeof createWorkspaceAuthority>;
	readonly memoryModel: Map<string, number>;
	readonly authorityModel: Map<string, number>;
}

function replayBytes(entries: ReadonlyMap<string, number>): number {
	let size = 2;
	for (const [key, expiry] of entries)
		size += new TextEncoder().encode(JSON.stringify(key)).length + 1 + String(expiry).length;
	return size + Math.max(0, entries.size - 1);
}

function createScenario(): ReplayScenario {
	const clock = { now: 100 };
	const store = createVolatileAuthorityStore();
	return {
		clock,
		store,
		memory: createInMemoryApprovalTokenUse({ now: () => clock.now, limit: 2 }),
		authority: createWorkspaceAuthority({ store, clock: { nowMs: () => clock.now }, cap: 45 }),
		memoryModel: new Map(),
		authorityModel: new Map(),
	};
}

async function useToken(scenario: ReplayScenario, tokenId: string, expiry: number): Promise<void> {
	const now = scenario.clock.now;
	for (const [id, storedExpiry] of scenario.memoryModel)
		if (storedExpiry <= now) scenario.memoryModel.delete(id);
	const memoryResult = scenario.memoryModel.has(tokenId)
		? { ok: false, reason: 'replayed' }
		: scenario.memoryModel.size >= 2
			? { ok: false, reason: 'replay-cache-full' }
			: { ok: true };
	expect(await scenario.memory(tokenId, expiry)).toEqual(memoryResult);
	if (memoryResult.ok) scenario.memoryModel.set(tokenId, expiry);
	const priorExpiry = scenario.authorityModel.get(tokenId);
	const retained = new Map(
		[...scenario.authorityModel].filter(([, storedExpiry]) => storedExpiry > now),
	);
	retained.set(tokenId, expiry);
	const authorityResult =
		priorExpiry !== undefined && priorExpiry > now
			? { ok: false, reason: 'replayed' }
			: replayBytes(retained) > 45
				? { ok: false, reason: 'replay-cache-full' }
				: { ok: true };
	expect(await scenario.authority.consumeApprovalToken(tokenId, expiry)).toEqual(authorityResult);
	if (authorityResult.ok) {
		scenario.authorityModel.clear();
		for (const [id, storedExpiry] of retained) scenario.authorityModel.set(id, storedExpiry);
	}
}

const replayMachine: hegel.stateful.StateMachine<ReplayScenario> = {
	rules: {
		consume: async (tc, scenario) => {
			const tokenId = tc.draw(generators.sampledFrom(['token-a', 'token-b', 'token-c', 'é-token']));
			const expiry =
				scenario.clock.now + tc.draw(generators.integers({ minValue: 1, maxValue: 10 }));
			tc.note(`consume ${tokenId} now=${scenario.clock.now} expiry=${expiry}`);
			await useToken(scenario, tokenId, expiry);
		},
		advance: (tc, scenario) => {
			const delta = tc.draw(generators.integers({ minValue: 0, maxValue: 10 }));
			scenario.clock.now += delta;
			tc.note(`advance ${delta} now=${scenario.clock.now}`);
		},
		reachExpiry: (tc, scenario) => {
			const live = [...scenario.memoryModel.values(), ...scenario.authorityModel.values()].filter(
				(expiry) => expiry > scenario.clock.now,
			);
			if (live.length > 0) scenario.clock.now = Math.min(...live);
			tc.note(`reach expiry now=${scenario.clock.now}`);
		},
	},
	invariants: {
		storedRecordsMatch: {
			alwaysCheck: true,
			check: async (_tc, scenario) => {
				expect((await scenario.store.read('approval-uses-v1')) ?? {}).toEqual(
					Object.fromEntries(scenario.authorityModel),
				);
			},
		},
		liveMemoryEntriesRefuseReplay: {
			alwaysCheck: true,
			check: async (_tc, scenario) => {
				for (const [id, expiry] of scenario.memoryModel)
					if (expiry > scenario.clock.now)
						expect(await scenario.memory(id, expiry)).toEqual({ ok: false, reason: 'replayed' });
				for (const [id, expiry] of scenario.memoryModel)
					if (expiry <= scenario.clock.now) scenario.memoryModel.delete(id);
			},
		},
	},
};

it('models replay, expiry pruning and each capacity across generated sequences', async () => {
	await hegel.testAsync(
		async (tc) => {
			await hegel.stateful.runAsync(tc, replayMachine, createScenario(), { stepCount: 50 });
		},
		{ testCases: 100, derandomize: true, database: hegel.Database.disabled },
	);
});

it('refuses a signed approval at exact expiry after pruning without a second effect', async () => {
	await hegel.testAsync(
		async (tc) => {
			const issued = tc.draw(generators.integers({ minValue: 0, maxValue: 10000 }));
			const lifetime = tc.draw(generators.integers({ minValue: 1, maxValue: 1000 }));
			const value = tc.draw(generators.integers({ minValue: 1, maxValue: 10000 }));
			const expiry = issued + lifetime;
			tc.note(`issued=${issued} expiry=${expiry} value=${value}`);
			let now = issued;
			const store = createVolatileAuthorityStore();
			const authority = createWorkspaceAuthority({ store, clock: { nowMs: () => now }, cap: 4096 });
			const key = new Uint8Array(32).fill(23);
			const calls = [
				{
					namespace: 'fixture',
					toolName: 'protected-call',
					argumentsHash: await hashCallArguments({ value }),
				},
			];
			const token = await signApprovalToken({
				key,
				agentId: 'agent-a',
				calls,
				issuedAtMs: issued,
				expiresAtMs: expiry,
				jti: '018f0000-0000-7000-8000-000000000001',
			});
			const consumeTokenId = authority.consumeApprovalToken;
			const { gateway, effects } = createApprovalExecutionGateway({
				key,
				consumeTokenId,
				nowMs: () => now,
			});
			const call = (): ReturnType<typeof gateway.call> =>
				gateway.call({
					calls: [
						{
							id: 'protected',
							namespace: 'fixture',
							toolName: 'protected-call',
							arguments: { value },
						},
					],
					portalApprovalToken: token,
				});
			expect((await call()).ok).toBe(true);
			expect((await call()).ok).toBe(false);
			expect(effects).toEqual([{ value }]);
			now = expiry;
			expect(await authority.consumeApprovalToken('prune', expiry + 1)).toEqual({ ok: true });
			expect(
				await verifyApprovalToken({
					key,
					agentId: 'agent-a',
					calls,
					token,
					nowMs: now,
					consumeTokenId,
				}),
			).toEqual({ ok: false, reason: 'expired' });
			expect((await call()).ok).toBe(false);
			expect(effects).toEqual([{ value }]);
			expect(
				await authority.consumeApprovalToken('018f0000-0000-7000-8000-000000000001', expiry),
			).toEqual({ ok: true });
		},
		{ testCases: 100, derandomize: true, database: hegel.Database.disabled },
	);
});
