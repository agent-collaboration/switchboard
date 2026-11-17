import { createHash, randomBytes } from 'node:crypto';

interface ProviderIdentity {
	readonly email: string;
	readonly verified: boolean;
}
interface ProviderCode extends ProviderIdentity {
	readonly challenge: string | null;
	readonly redirectUri: string;
}
type ProviderRequest = Pick<Request, 'url' | 'method' | 'text'> & {
	readonly headers: { readonly get: (name: string) => string | null };
};

/** Implements only the external GitHub protocol used by the pinned provider. */
export function createGithubOAuthProtocol(): {
	readonly authorize: (url: URL, email: string, verified: boolean) => URL;
	readonly respond: (request: ProviderRequest) => Promise<Response>;
} {
	const codes = new Map<string, ProviderCode>();
	const tokens = new Map<string, ProviderIdentity>();
	return {
		authorize(url: URL, email: string, verified: boolean): URL {
			if (url.origin !== 'https://github.com' || url.pathname !== '/login/oauth/authorize')
				throw new Error('Unexpected GitHub authorization protocol');
			const redirectUri = url.searchParams.get('redirect_uri');
			const state = url.searchParams.get('state');
			const challenge = url.searchParams.get('code_challenge');
			if (
				redirectUri === null ||
				state === null ||
				(challenge !== null && url.searchParams.get('code_challenge_method') !== 'S256')
			)
				throw new Error('Incomplete GitHub authorization protocol');
			const code = randomBytes(32).toString('base64url');
			codes.set(code, { redirectUri, challenge, email, verified });
			const callback = new URL(redirectUri);
			callback.searchParams.set('code', code);
			callback.searchParams.set('state', state);
			return callback;
		},
		async respond(request: ProviderRequest): Promise<Response> {
			const url = new URL(request.url);
			if (url.href === 'https://github.com/login/oauth/access_token' && request.method === 'POST') {
				const body = new URLSearchParams(await request.text());
				const code = body.get('code') ?? '';
				const issued = codes.get(code);
				if (
					issued === undefined ||
					body.get('redirect_uri') !== issued.redirectUri ||
					(issued.challenge !== null &&
						createHash('sha256')
							.update(body.get('code_verifier') ?? '')
							.digest('base64url') !== issued.challenge)
				)
					return Response.json({ error: 'invalid_grant' }, { status: 400 });
				codes.delete(code);
				const token = randomBytes(32).toString('base64url');
				tokens.set(token, issued);
				return Response.json({
					access_token: token,
					token_type: 'Bearer',
					scope: 'read:user,user:email',
				});
			}
			const identity = tokens.get(
				request.headers.get('authorization')?.replace(/^Bearer /u, '') ?? '',
			);
			if (identity === undefined) return Response.json({ error: 'unauthorized' }, { status: 401 });
			if (url.href === 'https://api.github.com/user/emails')
				return Response.json([
					{ email: identity.email, primary: true, verified: identity.verified },
				]);
			if (url.href === 'https://api.github.com/user')
				return Response.json({
					id: Number.parseInt(
						createHash('sha256').update(identity.email).digest('hex').slice(0, 8),
						16,
					),
					name: 'Fixture Person',
					login: 'fixture-person',
					email: identity.email,
					avatar_url: null,
				});
			return Response.json({ error: 'unexpected-provider-request' }, { status: 503 });
		},
	};
}
