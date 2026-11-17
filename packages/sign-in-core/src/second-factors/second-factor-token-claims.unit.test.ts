import { expect, it } from 'vitest';

import { epochMillisecondsSchema } from '#sign-in-core/contracts/sign-in-platform';
import { secondFactorTokenClaims } from '#sign-in-core/second-factors/second-factor-token-claims';

it.each(['app', 'recoveryCode', 'passkey'] as const)(
	'copies the stored %s method without changing its confirmation time',
	(method) => {
		// C13 / Lead bf3f57cb: method is copied as is. Seconds are truncated
		// from the real stamp; minting a token cannot refresh confirmation.
		expect(
			secondFactorTokenClaims({
				kind: 'confirmed',
				at: epochMillisecondsSchema.parse(2_208_988_800_999),
				method,
			}),
		).toEqual({ second_factor_at: 2_208_988_800, second_factor_method: method });
	},
);
it('omits both claims when the session has never confirmed a second factor', () => {
	expect(secondFactorTokenClaims({ kind: 'unconfirmed' })).toEqual({});
});
