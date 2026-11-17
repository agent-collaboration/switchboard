import { afterEach, expect, it, vi } from 'vitest';

import { createAuthProofForwarderLifecycle } from '#sign-in-test-support/test-fixtures/auth-proof-forwarder-lifecycle';
import { createLocalAuthProofClose } from '#sign-in-test-support/test-fixtures/local-auth-proof-close';
import type { NodeInvocationReceipt } from '#sign-in-test-support/test-fixtures/node-management-bridge-contracts';
import { compareNodeProofReceipts } from '#sign-in-test-support/test-fixtures/node-proof-artifacts';

afterEach(() => vi.unstubAllEnvs());

it('rejects matched receipts arriving after the post-disposal check during HTTP cleanup', async () => {
	vi.stubEnv('AUTH_PROOF_MANIFEST_FILE', undefined);
	vi.stubEnv('AUTH_PROOF_NODE_MANIFEST_FILE', undefined);
	const initialReceipt = {
		invocationId: '11111111-1111-7111-8111-111111111111',
		method: 'http',
		httpMethod: 'GET',
		path: '/api/auth/jwks',
		requestHash: 'a'.repeat(64),
		responseHash: 'b'.repeat(64),
		status: 200,
	} satisfies NodeInvocationReceipt;
	const lateReceipt = {
		...initialReceipt,
		invocationId: '22222222-2222-7222-8222-222222222222',
	} satisfies NodeInvocationReceipt;
	const initiated = [initialReceipt];
	const actual = [initialReceipt];
	const close = createLocalAuthProofClose({
		runtime: {
			getWorker: async (name) => {
				expect(name).toBe('node-management-bridge');
				return { fetch: async () => Response.json({ initiated: [], completed: [] }) };
			},
			dispose: async () => {
				expect(initiated).toHaveLength(1);
				expect(actual).toHaveLength(1);
			},
		},
		nodeHost: { receipts: actual, close: async () => {} },
		identity: null,
		receiptId: '33333333-3333-7333-8333-333333333333',
		httpReceipts: initiated,
		lifecycle: createAuthProofForwarderLifecycle(),
		closeServers: async () => {
			initiated.push(lateReceipt);
			actual.push(lateReceipt);
		},
	});
	await expect(close.close()).rejects.toThrow(
		'Node invocation receipts differ from initiating calls',
	);
	expect(close.observations).toEqual([
		{ kind: 'harness-close', state: { kind: 'ready' } },
		{ kind: 'receipt-snapshot' },
		{ kind: 'dispose-start' },
		{ kind: 'dispose-ended' },
		{ kind: 'receipts-unchanged' },
		{ kind: 'http-cleanup-start' },
		{ kind: 'http-cleanup-ended' },
	]);
	// Both producers agree after cleanup; only the immutable earlier snapshot rejects this late activity.
	expect(() => compareNodeProofReceipts(initiated, actual)).not.toThrow();
});

it('samples pending requests before evidence capture can let them finish, while still cleaning up', async (): Promise<void> => {
	vi.stubEnv('AUTH_PROOF_MANIFEST_FILE', undefined);
	vi.stubEnv('AUTH_PROOF_NODE_MANIFEST_FILE', undefined);
	const lifecycle = createAuthProofForwarderLifecycle();
	const inFlight = lifecycle.trackRequest(async (): Promise<void> => {});
	let capturedEvidence = false;
	let disposed = false;
	let closedServers = false;
	const properties = {
		runtime: {
			getWorker: async () => ({
				fetch: async () => Response.json({ initiated: [], completed: [] }),
			}),
			dispose: async (): Promise<void> => {
				disposed = true;
			},
		},
		nodeHost: undefined,
		identity: null,
		receiptId: '33333333-3333-7333-8333-333333333333',
		httpReceipts: [],
		lifecycle,
		captureEvidence: async (): Promise<void> => {
			await inFlight;
			capturedEvidence = true;
		},
		closeServers: async (): Promise<void> => {
			closedServers = true;
		},
	};
	const close = createLocalAuthProofClose(properties);
	await expect(close.close()).rejects.toMatchObject({
		state: { kind: 'pendingAtClose', pendingRequests: 1 },
	});
	expect(capturedEvidence).toBe(true);
	expect(disposed).toBe(true);
	expect(closedServers).toBe(true);
});

it('demonstrates why evidence awaited outside close must not precede the pending snapshot', async (): Promise<void> => {
	vi.stubEnv('AUTH_PROOF_MANIFEST_FILE', undefined);
	vi.stubEnv('AUTH_PROOF_NODE_MANIFEST_FILE', undefined);
	const lifecycle = createAuthProofForwarderLifecycle();
	const inFlight = lifecycle.trackRequest(async (): Promise<void> => {});
	const close = createLocalAuthProofClose({
		runtime: {
			getWorker: async () => ({
				fetch: async () => Response.json({ initiated: [], completed: [] }),
			}),
			dispose: async () => {},
		},
		nodeHost: undefined,
		identity: null,
		receiptId: '33333333-3333-7333-8333-333333333333',
		httpReceipts: [],
		lifecycle,
		closeServers: async () => {},
	});
	// Negative comparator: the old wrapper awaited evidence (which can await I/O)
	// before close sampled pending work. Causal settlement replaces any sleep.
	await inFlight;
	await expect(close.close()).resolves.toBeUndefined();
	expect(close.observations[0]).toEqual({ kind: 'harness-close', state: { kind: 'ready' } });
});

it('keeps disposal and HTTP cleanup when evidence capture fails', async (): Promise<void> => {
	vi.stubEnv('AUTH_PROOF_MANIFEST_FILE', undefined);
	vi.stubEnv('AUTH_PROOF_NODE_MANIFEST_FILE', undefined);
	let disposed = false;
	let closedServers = false;
	const close = createLocalAuthProofClose({
		runtime: {
			getWorker: async () => ({
				fetch: async () => Response.json({ initiated: [], completed: [] }),
			}),
			dispose: async (): Promise<void> => {
				disposed = true;
			},
		},
		nodeHost: undefined,
		identity: null,
		receiptId: '33333333-3333-7333-8333-333333333333',
		httpReceipts: [],
		lifecycle: createAuthProofForwarderLifecycle(),
		captureEvidence: async (): Promise<never> => {
			throw new Error('Controlled evidence failure');
		},
		closeServers: async (): Promise<void> => {
			closedServers = true;
		},
	});
	await expect(close.close()).rejects.toThrow('Controlled evidence failure');
	expect(disposed).toBe(true);
	expect(closedServers).toBe(true);
});
