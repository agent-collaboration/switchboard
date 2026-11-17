import {
	createProviderRequestState,
	createSignInProvider,
	type SignInHttpConfiguration,
} from '@agent-collaboration/sign-in-core/better-auth';
import { z } from 'zod';

export const fleetAdminProofRedirectUri = 'http://127.0.0.1/fleet-admin-proof';

/**
 * Fixture setup only: the owner registers a native PKCE client for `fleet:admin` and links it
 * to the admin resource through Better Auth's own admin APIs, as the owner bootstrap does for
 * the management CLI. Issuance itself then runs through the unchanged public routes.
 */
export async function handleFleetAdminClientProof(
	request: Request,
	readConfiguration: () => SignInHttpConfiguration,
): Promise<Response | null> {
	if (new URL(request.url).pathname !== '/__auth-proof/fleet-admin-client') return null;
	const configuration = readConfiguration();
	const clientId = z.strictObject({ clientId: z.uuidv7() }).parse(await request.json()).clientId;
	const auth = createSignInProvider({
		...configuration,
		authority: { kind: 'owner-bootstrap' },
		requestState: createProviderRequestState(),
		generatedClientId: clientId,
	});
	const headers = new Headers({ cookie: request.headers.get('cookie') ?? '' });
	await auth.api.adminCreateOAuthClient({
		headers,
		body: {
			client_name: 'Fleet admin proof client',
			token_endpoint_auth_method: 'none',
			application_type: 'native',
			redirect_uris: [fleetAdminProofRedirectUri],
			grant_types: ['authorization_code'],
			response_types: ['code'],
			require_pkce: true,
			subject_type: 'public',
			scope: 'fleet:admin',
			skip_consent: true,
		},
	});
	await auth.api.adminLinkClientResource({
		headers,
		params: { identifier: configuration.configuration.centralAdminAudience, client_id: clientId },
	});
	return Response.json({ clientId });
}
