import { z } from 'zod';

import type { NodeAuthProofHost } from '#sign-in-test-support/test-fixtures/node-auth-proof-host';
import {
	nodeInvocationReceiptSchema,
	type NodeInvocationReceipt,
} from '#sign-in-test-support/test-fixtures/node-management-bridge-contracts';
import {
	compareNodeProofReceipts,
	retainNodeProofReceipts,
	type NodeProofManifest,
} from '#sign-in-test-support/test-fixtures/node-proof-artifacts';

/** The existing bridge readback protocol needs only a JSON response, not other runtime capabilities. */
export interface NodeProofReceiptRuntime {
	readonly getWorker: (name: string) => Promise<{
		readonly fetch: (url: string) => Promise<Pick<Response, 'json'>>;
	}>;
}

/** Keep failure evidence before comparing both sides of every real invocation. */
export async function retainAndCompareNodeProofReceipts(props: {
	readonly runtime: NodeProofReceiptRuntime;
	readonly host: Pick<NodeAuthProofHost, 'receipts'>;
	readonly receiptId: string;
	readonly identity: NodeProofManifest | null;
	readonly httpReceipts: readonly NodeInvocationReceipt[];
}): Promise<() => void> {
	const bridge = await props.runtime.getWorker('node-management-bridge');
	const ledger = z
		.object({
			initiated: z.array(
				nodeInvocationReceiptSchema.pick({ invocationId: true, method: true, requestHash: true }),
			),
			completed: z.array(nodeInvocationReceiptSchema),
		})
		.parse(await (await bridge.fetch('https://bridge-proof.invalid/receipts')).json());
	const httpBeforeDispose = props.httpReceipts.map((receipt) => ({ ...receipt }));
	const actualBeforeDispose = props.host.receipts.map((receipt) => ({ ...receipt }));
	const expected = [...httpBeforeDispose, ...ledger.completed];
	await retainNodeProofReceipts({
		receiptId: props.receiptId,
		identity: props.identity,
		expected,
		actual: actualBeforeDispose,
	});
	const initiated = ledger.initiated.toSorted((left, right) =>
		left.invocationId.localeCompare(right.invocationId),
	);
	const completed = ledger.completed
		.map(({ invocationId, method, requestHash }) => ({ invocationId, method, requestHash }))
		.toSorted((left, right) => left.invocationId.localeCompare(right.invocationId));
	if (JSON.stringify(initiated) !== JSON.stringify(completed))
		throw new Error('Node bridge invocation did not complete');
	compareNodeProofReceipts(expected, actualBeforeDispose);
	return () => {
		compareNodeProofReceipts(httpBeforeDispose, props.httpReceipts);
		compareNodeProofReceipts(actualBeforeDispose, props.host.receipts);
	};
}
