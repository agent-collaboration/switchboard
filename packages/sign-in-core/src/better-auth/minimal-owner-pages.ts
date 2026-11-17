import type { SignInConfiguration } from '#sign-in-core/contracts/deployment-configuration';
import { mintPageNonce } from '#sign-in-core/contracts/page-nonce';
import type { SignInCrypto } from '#sign-in-core/contracts/sign-in-platform';
import type { OwnerPageProps } from '#sign-in-core/pages/owner-page';
import { renderOwnerPage } from '#sign-in-core/pages/owner-page-document';

/** A requested owner CLI continuation is client input: absent, the fixed resumable one, or refused. */
export type OwnerAuthorizationResume =
	| { readonly kind: 'absent' }
	| { readonly kind: 'resume'; readonly authorization: string }
	| { readonly kind: 'refused' };

/** Only fixed management authorization may resume after the owner's provider sign-in. */
export function ownerAuthorizationResume(
	value: string | null,
	configuration: SignInConfiguration,
): OwnerAuthorizationResume {
	if (value === null) return { kind: 'absent' };
	const authorization = URL.parse(value);
	if (authorization === null) return { kind: 'refused' };
	const callback = URL.parse(authorization.searchParams.get('redirect_uri') ?? 'invalid:');
	const configuredCallback = new URL(configuration.ownerCliRedirectUri);
	if (
		callback === null ||
		authorization.origin !== new URL(configuration.issuer).origin ||
		authorization.pathname !== '/api/auth/oauth2/authorize' ||
		authorization.username !== '' ||
		authorization.password !== '' ||
		authorization.searchParams.get('client_id') !== configuration.ownerCliClientId ||
		authorization.searchParams.get('response_type') !== 'code' ||
		authorization.searchParams.get('scope') !== 'tool-portal:management' ||
		authorization.searchParams.get('resource') !== configuration.managementAudience ||
		authorization.searchParams.getAll('resource').length !== 1 ||
		authorization.searchParams.get('code_challenge_method') !== 'S256' ||
		!authorization.searchParams.has('code_challenge') ||
		callback.protocol !== 'http:' ||
		!['127.0.0.1', 'localhost', '[::1]'].includes(callback.hostname) ||
		callback.hostname !== configuredCallback.hostname ||
		callback.pathname !== configuredCallback.pathname ||
		callback.search !== configuredCallback.search ||
		callback.username !== '' ||
		callback.password !== '' ||
		callback.hash !== ''
	)
		return { kind: 'refused' };
	return { kind: 'resume', authorization: authorization.toString() };
}

/** Provider and session actions retain their native authorization boundary. Always renders, so
 * it always mints the page's nonce. */
export function minimalOwnerPage(
	props: OwnerPageProps & { readonly crypto: SignInCrypto },
): Response {
	const { crypto, ...pageProps } = props;
	return renderOwnerPage({ ...pageProps, nonce: mintPageNonce(crypto) });
}
