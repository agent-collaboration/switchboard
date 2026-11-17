import {
	createProviderRequestState,
	createSignInProvider,
	type SignInHttpConfiguration,
} from '@agent-collaboration/sign-in-core/better-auth';
import { z } from 'zod';

import { controlledSignInIds } from '#sign-in-test-support/test-fixtures/controlled-sign-in-clock';

const commandSchema = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('create') }),
	z.strictObject({ kind: z.literal('disable'), clientId: z.string().min(1) }),
]);

/** Fixture setup uses the real owner cookie and existing provider APIs. No
 * authentication hook, endpoint or claim is replaced. */
export async function handleIntrospectionClientFixture(
	request: Request,
	configuration: () => SignInHttpConfiguration,
): Promise<Response | null> {
	if (new URL(request.url).pathname !== '/__auth-proof/introspection-client') return null;
	if (request.method !== 'POST') return new Response(null, { status: 405 });
	const command = commandSchema.parse(await request.json());
	const properties = configuration();
	const provider = createSignInProvider({
		...properties,
		authority: { kind: 'owner-bootstrap' },
		requestState: createProviderRequestState(),
		generatedClientId: controlledSignInIds.nextId(),
	});
	if (command.kind === 'disable') {
		await provider.api.adminUpdateOAuthClient({
			headers: request.headers,
			body: { client_id: command.clientId, update: { disabled: true } },
		});
		return Response.json({ kind: 'disabled' });
	}
	const client = z.object({ client_id: z.string(), client_secret: z.string() }).parse(
		await provider.api.adminCreateOAuthClient({
			headers: request.headers,
			body: {
				client_name: 'Confidential introspection proof caller',
				token_endpoint_auth_method: 'client_secret_basic',
				grant_types: ['client_credentials'],
				client_credentials_scopes: ['tool-portal:management'],
				scope: 'tool-portal:management',
			},
		}),
	);
	await provider.api.adminLinkClientResource({
		headers: request.headers,
		params: {
			identifier: properties.configuration.managementAudience,
			client_id: client.client_id,
		},
	});
	return Response.json({ clientId: client.client_id, clientSecret: client.client_secret });
}
