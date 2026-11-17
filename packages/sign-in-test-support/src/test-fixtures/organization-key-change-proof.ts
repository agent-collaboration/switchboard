import {
	createOrganizationKeyChangeResign,
	type SignInHttpConfiguration,
} from '@agent-collaboration/sign-in-core/better-auth';

/** Runs the production key-change re-sign (B2 rule 6) with the host's own configuration and
 * private central link. Renewal on use has no proof route: it runs inside real Fleet calls. */
export async function handleOrganizationKeyChangeProofRequest(
	request: Request,
	configuration: () => SignInHttpConfiguration,
): Promise<Response | null> {
	if (new URL(request.url).pathname !== '/__auth-proof/organization-key-change') return null;
	return Response.json({ result: await createOrganizationKeyChangeResign(configuration())() });
}
