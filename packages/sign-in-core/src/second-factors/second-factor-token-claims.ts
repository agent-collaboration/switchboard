import type { z } from 'zod';

import { personTokenSecondFactorClaimsSchema } from '#sign-in-core/contracts/person-identity-contracts';
import type { SecondFactorConfirmation } from '#sign-in-core/second-factors/second-factor-step-up';

/** Preserve the actual confirmation time; a new token does not make an old
 * confirmation fresh. The downstream change guard decides whether it is recent. */
export function secondFactorTokenClaims(
	confirmation: SecondFactorConfirmation,
): z.infer<typeof personTokenSecondFactorClaimsSchema> {
	if (confirmation.kind === 'unconfirmed') return {};
	return personTokenSecondFactorClaimsSchema.parse({
		second_factor_at: Math.floor(confirmation.at / 1000),
		second_factor_method: confirmation.method,
	});
}
