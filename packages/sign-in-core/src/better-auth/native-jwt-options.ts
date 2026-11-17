import type { JwtOptions } from 'better-auth/plugins/jwt';

import type { SignInConfiguration } from '#sign-in-core/contracts/deployment-configuration';

/** Person and organization signing share Better Auth's native key policy. */
export function signInJwtOptions(configuration: Pick<SignInConfiguration, 'issuer'>): JwtOptions {
	return {
		jwt: { issuer: configuration.issuer },
		jwks: { keyPairConfig: { alg: 'EdDSA' } },
	};
}
