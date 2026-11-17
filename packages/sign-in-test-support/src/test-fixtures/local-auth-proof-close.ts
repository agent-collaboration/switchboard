import type { Miniflare } from 'miniflare';

import type {
	AuthProofCloseState,
	createAuthProofForwarderLifecycle,
} from '#sign-in-test-support/test-fixtures/auth-proof-forwarder-lifecycle';
import { recordAuthProofPhase } from '#sign-in-test-support/test-fixtures/auth-proof-phase-recording';
import type { NodeAuthProofHost } from '#sign-in-test-support/test-fixtures/node-auth-proof-host';
import type { NodeInvocationReceipt } from '#sign-in-test-support/test-fixtures/node-management-bridge-contracts';
import type { NodeProofManifest } from '#sign-in-test-support/test-fixtures/node-proof-artifacts';
import {
	retainAndCompareNodeProofReceipts,
	type NodeProofReceiptRuntime,
} from '#sign-in-test-support/test-fixtures/node-proof-receipt-readback';

export type AuthProofTeardownObservation =
	| { readonly kind: 'harness-close'; readonly state: AuthProofCloseState }
	| {
			readonly kind:
				| 'receipt-snapshot'
				| 'dispose-start'
				| 'dispose-ended'
				| 'receipts-unchanged'
				| 'http-cleanup-start'
				| 'http-cleanup-ended'
				| 'final-receipts-unchanged';
	  };

/** Snapshots live Worker ledgers before disposal, then rejects late native or initiating receipts. */
export function createLocalAuthProofClose(props: {
	readonly runtime: NodeProofReceiptRuntime & Pick<Miniflare, 'dispose'>;
	readonly nodeHost: Pick<NodeAuthProofHost, 'receipts' | 'close'> | undefined;
	readonly identity: NodeProofManifest | null;
	readonly receiptId: string;
	readonly httpReceipts: readonly NodeInvocationReceipt[];
	readonly lifecycle: ReturnType<typeof createAuthProofForwarderLifecycle>;
	readonly closeServers: () => Promise<void>;
	readonly captureEvidence?: () => Promise<void>;
}): {
	readonly observations: readonly AuthProofTeardownObservation[];
	readonly close: () => Promise<void>;
} {
	const observations: AuthProofTeardownObservation[] = [];
	async function record(event: AuthProofTeardownObservation): Promise<void> {
		observations.push(event);
		await recordAuthProofPhase({ ...event, receiptId: props.receiptId });
	}
	return {
		observations,
		async close(): Promise<void> {
			const finalSnapshot: {
				current:
					| { readonly kind: 'unavailable' }
					| { readonly kind: 'captured'; readonly assertUnchanged: () => void };
			} = {
				current: { kind: 'unavailable' },
			};
			try {
				await props.lifecycle.closeWithReceiptSnapshot({
					report: (state) => record({ kind: 'harness-close', state }),
					capture: async () => {
						const assertUnchanged =
							props.nodeHost === undefined
								? () => {}
								: await retainAndCompareNodeProofReceipts({
										runtime: props.runtime,
										host: props.nodeHost,
										receiptId: props.receiptId,
										identity: props.identity,
										httpReceipts: props.httpReceipts,
									});
						finalSnapshot.current = { kind: 'captured', assertUnchanged };
						// Pending state and receipt identities must be fixed before export I/O can settle requests.
						await props.captureEvidence?.();
						await record({ kind: 'receipt-snapshot' });
						return async () => {
							assertUnchanged();
							await record({ kind: 'receipts-unchanged' });
						};
					},
					dispose: async () => {
						await record({ kind: 'dispose-start' });
						await props.runtime.dispose();
						await record({ kind: 'dispose-ended' });
					},
				});
			} finally {
				try {
					await props.nodeHost?.close();
				} finally {
					await record({ kind: 'http-cleanup-start' });
					await props.closeServers();
					await props.lifecycle.settleAfterHttpCleanup();
					await record({ kind: 'http-cleanup-ended' });
					if (finalSnapshot.current.kind === 'captured') {
						finalSnapshot.current.assertUnchanged();
						await record({ kind: 'final-receipts-unchanged' });
					}
				}
			}
		},
	};
}
