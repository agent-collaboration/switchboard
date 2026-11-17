import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

/**
 * Native code + S256 through a loopback callback: the browser signs in at the issuer, which
 * redirects here with the code. Shared by the management CLI and the fleet CLI; each owns its
 * own client, scope, resource and exchange.
 */
export async function authorizeThroughLoopback(props: {
	readonly issuer: string;
	readonly redirectUri: string;
	readonly clientId: string;
	readonly scope: string;
	readonly resource: string;
	readonly codeChallenge: string;
	readonly browser: (url: string) => Promise<void>;
}): Promise<{ readonly code: string; readonly redirectUri: string }> {
	const state = randomBytes(32).toString('base64url');
	const redirect = new URL(props.redirectUri);
	const callback = Promise.withResolvers<string>();
	const callbackResult = callback.promise.then(
		(code) =>
			({ kind: 'authorized', code }) satisfies {
				readonly kind: 'authorized';
				readonly code: string;
			},
		() => ({ kind: 'refused' }) satisfies { readonly kind: 'refused' },
	);
	const server = createServer((request, response) => {
		const received = new URL(request.url ?? '/', redirect.origin);
		if (
			request.method !== 'GET' ||
			received.pathname !== redirect.pathname ||
			received.searchParams.get('state') !== state
		) {
			response.writeHead(400).end('Invalid owner sign-in callback.');
			return;
		}
		const code = received.searchParams.get('code');
		if (
			received.searchParams.get('iss') !== props.issuer ||
			code === null ||
			received.searchParams.has('error')
		) {
			response.writeHead(400).end('Owner sign-in refused.');
			callback.reject(new Error('Owner authorization refused'));
			return;
		}
		response
			.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' })
			.end('Owner sign-in complete. Return to the CLI.');
		callback.resolve(code);
	});
	server.on('error', callback.reject);
	const timeout = setTimeout(
		() => callback.reject(new Error('Owner loopback sign-in timed out')),
		300_000,
	);
	try {
		await new Promise<void>((resolveListen, rejectListen) => {
			server.once('error', rejectListen);
			server.listen(
				{
					host: redirect.hostname.replace(/^\[|\]$/g, ''),
					port: redirect.port === '' ? 0 : Number(redirect.port),
				},
				resolveListen,
			);
		});
		const address = server.address();
		if (address === null || typeof address === 'string')
			throw new Error('Owner loopback listener unavailable');
		redirect.port = String(address.port);
		const authorization = new URL('/api/auth/oauth2/authorize', props.issuer);
		authorization.search = new URLSearchParams({
			client_id: props.clientId,
			response_type: 'code',
			redirect_uri: redirect.toString(),
			scope: props.scope,
			resource: props.resource,
			code_challenge: props.codeChallenge,
			code_challenge_method: 'S256',
			state,
		}).toString();
		const browserUrl = new URL('/sign-in', props.issuer);
		browserUrl.searchParams.set('authorize', authorization.toString());
		await props.browser(browserUrl.toString());
		const authorizationResult = await callbackResult;
		if (authorizationResult.kind !== 'authorized')
			throw new Error('Owner authorization refused or timed out');
		return { code: authorizationResult.code, redirectUri: redirect.toString() };
	} finally {
		clearTimeout(timeout);
		server.closeAllConnections();
		await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
	}
}
