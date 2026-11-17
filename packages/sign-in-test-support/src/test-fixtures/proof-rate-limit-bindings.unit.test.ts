import { fileURLToPath } from 'node:url';

import { expect, it } from 'vitest';

import { loadProofRateLimitBindings } from '#sign-in-test-support/test-fixtures/proof-rate-limit-bindings';

it('uses the R52 deployment limits in the actual local binding definitions', async () => {
	const bindings = await loadProofRateLimitBindings(
		fileURLToPath(new URL('../../../../', import.meta.url)),
	);
	// The literals are the adopted R52 table, independent of both producers.
	expect(bindings).toMatchObject({
		SIGN_IN_ATTEMPTS: { type: 'rate-limit', simple: { limit: 10, period: 60 } },
		AUTH_REQUESTS: { type: 'rate-limit', simple: { limit: 300, period: 60 } },
	});
});
