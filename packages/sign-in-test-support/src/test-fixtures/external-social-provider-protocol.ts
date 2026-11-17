import type { SocialLoginProvider } from '@agent-collaboration/sign-in-core/better-auth';
import { Response as WorkerResponse, type V4FetchHandler } from 'miniflare';

import { createGithubOAuthProtocol } from '#sign-in-test-support/test-fixtures/github-oauth-protocol';
import { createGoogleOAuthProtocol } from '#sign-in-test-support/test-fixtures/google-oauth-protocol';

export async function createExternalSocialProviderProtocol(): Promise<{
	readonly google: Awaited<ReturnType<typeof createGoogleOAuthProtocol>>;
	readonly authorize: (
		provider: SocialLoginProvider,
		url: URL,
		email: string,
		verified: boolean,
	) => URL;
	readonly respond: (request: Request) => Promise<Response>;
	readonly fetch: V4FetchHandler;
}> {
	const google = await createGoogleOAuthProtocol();
	const github = createGithubOAuthProtocol();
	async function respond(request: Parameters<typeof github.respond>[0]): Promise<Response> {
		return ['github.com', 'api.github.com'].includes(new URL(request.url).hostname)
			? github.respond(request)
			: google.respond(request);
	}
	return {
		google,
		authorize: (provider, url, email, verified) =>
			(provider === 'google' ? google : github).authorize(url, email, verified),
		respond,
		async fetch(request): Promise<WorkerResponse> {
			const response = await respond(request);
			return new WorkerResponse(await response.arrayBuffer(), {
				status: response.status,
				headers: Object.fromEntries(response.headers),
			});
		},
	};
}
