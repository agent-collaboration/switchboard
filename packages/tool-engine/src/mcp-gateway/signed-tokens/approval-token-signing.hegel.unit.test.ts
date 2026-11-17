import * as hegel from '@hegeldev/hegel';
import * as generators from '@hegeldev/hegel/generators';
import { expect, it } from 'vitest';

import {
	signAudienceScopedApprovalToken,
	verifyAudienceScopedApprovalToken,
} from '#mcp-gateway/signed-tokens/approval-token-signing';

it('binds the audience, ordered call fields, key, agent, and expiry', async () => {
	await hegel.testAsync(
		async (tc) => {
			const value = tc.draw(generators.integers({ minValue: 1, maxValue: 100000 }));
			const issuedAtMs = tc.draw(generators.integers({ minValue: 0, maxValue: 100000 }));
			const lifetime = tc.draw(generators.integers({ minValue: 1, maxValue: 10000 }));
			tc.note(`value=${value} issued=${issuedAtMs} lifetime=${lifetime}`);
			const key = new Uint8Array(32).fill(17);
			const calls = [
				{ namespace: `namespace-${value}`, toolName: 'first', argumentsHash: `hash-${value}` },
				{ namespace: 'other', toolName: 'second', argumentsHash: `other-${value}` },
			];
			const expiresAtMs = issuedAtMs + lifetime;
			const signed = {
				key,
				audience: `audience-${value}`,
				agentId: `agent-${value}`,
				calls,
				issuedAtMs,
				expiresAtMs,
				jti: '018f0000-0000-7000-8000-000000000001',
			};
			const token = await signAudienceScopedApprovalToken(signed);
			const input = {
				...signed,
				token,
				nowMs: expiresAtMs - 1,
				consumeTokenId: async () => ({ ok: true as const }),
			};
			expect(await verifyAudienceScopedApprovalToken(input)).toEqual({ ok: true });
			expect(await verifyAudienceScopedApprovalToken({ ...input, nowMs: expiresAtMs })).toEqual({
				ok: false,
				reason: 'expired',
			});
			expect(
				await verifyAudienceScopedApprovalToken({ ...input, maxLifetimeMs: lifetime - 1 }),
			).toEqual({ ok: false, reason: 'ttl-exceeded' });
			expect(
				await verifyAudienceScopedApprovalToken({
					...input,
					audience: `${input.audience}-changed`,
				}),
			).toEqual({ ok: false, reason: 'signature-mismatch' });
			expect(
				await verifyAudienceScopedApprovalToken({ ...input, key: new Uint8Array(32).fill(18) }),
			).toEqual({ ok: false, reason: 'signature-mismatch' });
			expect(
				await verifyAudienceScopedApprovalToken({ ...input, agentId: `${input.agentId}-changed` }),
			).toEqual({ ok: false, reason: 'agent-mismatch' });
			const first = calls[0];
			const second = calls[1];
			if (first === undefined || second === undefined) throw new Error('Missing calls');
			await Promise.all(
				[
					[second, first],
					[{ ...first, namespace: `${first.namespace}-changed` }, second],
					[{ ...first, toolName: 'changed' }, second],
					[{ ...first, argumentsHash: 'changed' }, second],
					[first],
				].map(async (changed) => {
					expect(await verifyAudienceScopedApprovalToken({ ...input, calls: changed })).toEqual({
						ok: false,
						reason: 'call-mismatch',
					});
				}),
			);
		},
		{ testCases: 500, derandomize: true, database: hegel.Database.disabled },
	);
});

it('matches a frozen HMAC-SHA256 audience-scoped token vector', async () => {
	const token = await signAudienceScopedApprovalToken({
		key: new Uint8Array(32).fill(17),
		audience: 'audience',
		agentId: 'agent',
		calls: [],
		issuedAtMs: 100,
		expiresAtMs: 200,
		jti: '018f0000-0000-7000-8000-000000000001',
	});
	expect(token).toBe(
		'eyJhZ2VudElkIjoiYWdlbnQiLCJjYWxscyI6W10sImV4cCI6MjAwLCJpYXQiOjEwMCwianRpIjoiMDE4ZjAwMDAtMDAwMC03MDAwLTgwMDAtMDAwMDAwMDAwMDAxIn0.xBEz8wA4QlSfHlW2pn_oDf9usVKBF9ITIWeUi-c0-rk',
	);
});
