import { expect, it } from 'vitest';

import type { NodeInvocationReceipt } from '#sign-in-test-support/test-fixtures/node-management-bridge-contracts';
import { compareNodeProofReceipts } from '#sign-in-test-support/test-fixtures/node-proof-artifacts';

const receipt = {
	invocationId: '11111111-1111-7111-8111-111111111111',
	method: 'registerAndLink',
	httpMethod: 'POST',
	path: '/__auth-proof/node-management',
	requestHash: 'a'.repeat(64),
	responseHash: 'b'.repeat(64),
	status: 200,
} satisfies NodeInvocationReceipt;

it('requires every initiating call to have exactly one Node receipt with the same bytes and status', () => {
	expect(() => compareNodeProofReceipts([receipt], [receipt])).not.toThrow();
	for (const actual of [
		[],
		[receipt, receipt],
		[{ ...receipt, requestHash: 'c'.repeat(64) }],
		[{ ...receipt, responseHash: 'c'.repeat(64) }],
		[{ ...receipt, status: 503 }],
		[{ ...receipt, httpMethod: 'GET' }],
		[{ ...receipt, path: '/different-route' }],
	] satisfies readonly (readonly NodeInvocationReceipt[])[])
		expect(() => compareNodeProofReceipts([receipt], actual)).toThrow(
			'Node invocation receipts differ',
		);
});
