import { expect, it } from 'vitest';

import { createAuthProofForwarderLifecycle } from '#sign-in-test-support/test-fixtures/auth-proof-forwarder-lifecycle';
import type { NodeInvocationReceipt } from '#sign-in-test-support/test-fixtures/node-management-bridge-contracts';
import { compareNodeProofReceipts } from '#sign-in-test-support/test-fixtures/node-proof-artifacts';

const receipt = {
	invocationId: '11111111-1111-7111-8111-111111111111',
	method: 'http',
	httpMethod: 'GET',
	path: '/api/auth/jwks',
	requestHash: 'a'.repeat(64),
	responseHash: 'b'.repeat(64),
	status: 200,
} satisfies NodeInvocationReceipt;

it('snapshots settled requests before disposal and checks the snapshot afterward', async () => {
	const lifecycle = createAuthProofForwarderLifecycle();
	const order: string[] = [];
	await lifecycle.trackRequest(async () => {
		order.push('request-ended');
	});
	await lifecycle.closeWithReceiptSnapshot({
		report: async (state) => {
			expect(state).toEqual({ kind: 'ready' });
		},
		capture: async () => {
			order.push('snapshot');
			return () => {
				order.push('unchanged');
			};
		},
		dispose: async () => {
			order.push('disposed');
		},
	});
	expect(order).toEqual(['request-ended', 'snapshot', 'disposed', 'unchanged']);
});

it('classifies pendingAtClose without waiting or counting disposal as a passing case', async () => {
	const lifecycle = createAuthProofForwarderLifecycle();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const tracked = lifecycle.trackRequest(async () => {
		entered.resolve();
		await release.promise;
	});
	await entered.promise;
	const order: string[] = [];
	try {
		await expect(
			lifecycle.closeWithReceiptSnapshot({
				report: async (state) => {
					expect(state).toEqual({ kind: 'pendingAtClose', pendingRequests: 1 });
					order.push('pendingAtClose');
				},
				capture: async () => {
					order.push('snapshot');
					return () => {
						order.push('unchanged');
					};
				},
				dispose: async () => {
					order.push('disposed');
				},
			}),
		).rejects.toMatchObject({ state: { kind: 'pendingAtClose', pendingRequests: 1 } });
		expect(order).toEqual(['pendingAtClose', 'snapshot', 'disposed', 'unchanged']);
	} finally {
		release.resolve();
		await tracked;
	}
});

it('rejects a receipt added during disposal instead of allowing a late invocation', async () => {
	const lifecycle = createAuthProofForwarderLifecycle();
	const actual: NodeInvocationReceipt[] = [receipt];
	await expect(
		lifecycle.closeWithReceiptSnapshot({
			report: async () => {},
			capture: async () => {
				const before = actual.slice();
				return () => compareNodeProofReceipts(before, actual);
			},
			dispose: async () => {
				actual.push({ ...receipt, invocationId: '22222222-2222-7222-8222-222222222222' });
			},
		}),
	).rejects.toThrow('Node invocation receipts differ from initiating calls');
});

it('still disposes when the pre-disposal receipt comparison fails', async () => {
	const lifecycle = createAuthProofForwarderLifecycle();
	let disposed = false;
	await expect(
		lifecycle.closeWithReceiptSnapshot({
			report: async () => {},
			capture: async () => {
				throw new Error('pre-disposal mismatch');
			},
			dispose: async () => {
				disposed = true;
			},
		}),
	).rejects.toThrow('pre-disposal mismatch');
	expect(disposed).toBe(true);
});

it('retains a failed forwarder as a closed failure after disposing', async () => {
	const lifecycle = createAuthProofForwarderLifecycle();
	await lifecycle.trackRequest(async () => {
		throw new Error('must-not-escape');
	});
	let disposed = false;
	await expect(
		lifecycle.closeWithReceiptSnapshot({
			report: async (state) => {
				expect(state).toEqual({ kind: 'failedForwarder', failedRequests: 1 });
			},
			capture: async () => () => {},
			dispose: async () => {
				disposed = true;
			},
		}),
	).rejects.toMatchObject({ state: { kind: 'failedForwarder', failedRequests: 1 } });
	expect(disposed).toBe(true);
});

it('propagates disposal failure instead of reporting a successful close', async () => {
	const lifecycle = createAuthProofForwarderLifecycle();
	let checkedAfterDispose = false;
	await expect(
		lifecycle.closeWithReceiptSnapshot({
			report: async () => {},
			capture: async () => () => {
				checkedAfterDispose = true;
			},
			dispose: async () => {
				throw new Error('dispose failed');
			},
		}),
	).rejects.toThrow('dispose failed');
	expect(checkedAfterDispose).toBe(false);
});

it('waits for owned HTTP handlers to settle after listener cleanup', async () => {
	const lifecycle = createAuthProofForwarderLifecycle();
	const entered = Promise.withResolvers<void>();
	const closed = Promise.withResolvers<void>();
	const tracked = lifecycle.trackRequest(async () => {
		entered.resolve();
		await closed.promise;
	});
	await entered.promise;
	let settled = false;
	const waiting = lifecycle.settleAfterHttpCleanup().then(() => {
		settled = true;
	});
	await Promise.resolve();
	expect(settled).toBe(false);
	closed.resolve();
	await tracked;
	await waiting;
	expect(settled).toBe(true);
});
