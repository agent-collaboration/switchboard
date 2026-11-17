import { decodeJwt } from 'jose';
import { z } from 'zod';

import type { RequestCaseFixture } from '#sign-in-test-support/fuzz/request-case-fixture';
import type {
	GeneratedRequest,
	RequestFamilyContext,
} from '#sign-in-test-support/fuzz/request-families/index';
import {
	storedCredentials,
	type RequestStorageSnapshot,
} from '#sign-in-test-support/fuzz/request-storage-snapshot';
import { expectNoIssuedCredentials } from '#sign-in-test-support/test-fixtures/credential-free-refusal';

export interface ObservedRequestAnswer {
	readonly status: number;
	readonly headers: Headers;
	readonly text: string;
	readonly body: unknown;
}

export async function observeRequestAnswer(response: Response): Promise<ObservedRequestAnswer> {
	const text = await response.text();
	let body: unknown = null;
	if (response.headers.get('content-type')?.includes('json')) {
		try {
			body = JSON.parse(text);
		} catch {
			throw new Error('S2 documented-answer: response claims JSON but is malformed');
		}
	}
	return { status: response.status, headers: response.headers, text, body };
}

function forbid(value: string, forbidden: readonly string[], property: string): void {
	if (forbidden.some((credential) => credential.length > 0 && value.includes(credential)))
		throw new Error(property);
}

function credentialFields(value: unknown, path = ''): readonly string[] {
	if (Array.isArray(value)) return value.flatMap((child) => credentialFields(child, path));
	const object = z.record(z.string(), z.unknown()).safeParse(value);
	if (!object.success) return [];
	const sensitive = new Set([
		'access_token',
		'accessToken',
		'refresh_token',
		'refreshToken',
		'id_token',
		'idToken',
		'client_secret',
		'clientSecret',
		'token',
		'password',
		'privateKey',
		'sessionToken',
	]);
	return Object.entries(object.data).flatMap(([key, child]) =>
		(sensitive.has(key) ? [`${path}/${key}`] : []).concat(
			credentialFields(child, `${path}/${key}`),
		),
	);
}

/** The entitlement comes from the input fixture and release contract, never from the returned status alone. */
export function assertRequestDisclosure(props: {
	readonly fixture: Pick<
		RequestCaseFixture,
		'caller' | 'sessionId' | 'forbiddenIdentities' | 'foreignIdentities' | 'issuedCredentials'
	> & {
		readonly context: Pick<
			RequestFamilyContext,
			| 'issuer'
			| 'personId'
			| 'oauthCode'
			| 'oauthCodeVerifier'
			| 'oauthClientId'
			| 'oauthResource'
			| 'oauthRedirectUri'
			| 'invitationId'
		>;
	};
	readonly path: string;
	readonly request: GeneratedRequest;
	readonly answer: ObservedRequestAnswer;
	readonly before: RequestStorageSnapshot;
	readonly after: RequestStorageSnapshot;
}): void {
	const { fixture, path, answer, before, after } = props;
	const refusal =
		answer.status >= 400 || (answer.headers.get('location')?.includes('error=') ?? false);
	const tokenSuccess = path === '/api/auth/oauth2/token' && answer.status === 200;
	const credentials = [
		...storedCredentials(before),
		...storedCredentials(after),
		...fixture.issuedCredentials,
	];
	forbid(answer.text, credentials, 'S2 credential-disclosure: body contains a stored credential');
	for (const [name, value] of answer.headers) {
		if (name !== 'set-cookie')
			forbid(value, credentials, 'S2 credential-disclosure: header contains a stored credential');
		if (name === 'authorization' && value !== '')
			throw new Error('S2 credential-disclosure: authorization response header');
	}
	if (refusal) {
		expectNoIssuedCredentials(answer.body);
		if (credentialFields(answer.body).length > 0)
			throw new Error('S2 credential-disclosure: credential field in refusal');
	} else {
		const fields = credentialFields(answer.body);
		const allowed = tokenSuccess ? ['/access_token'] : [];
		if (fields.some((field) => !allowed.includes(field)))
			throw new Error('S2 credential-disclosure: output outside route entitlement');
	}
	if (tokenSuccess) {
		if (fixture.caller !== 'owner' || fixture.context.oauthCode === 'unissued-fixture-code')
			throw new Error('S2 credential-disclosure: token issued outside caller entitlement');
		const input = new URLSearchParams(
			typeof props.request.init.body === 'string' ? props.request.init.body : '',
		);
		for (const [name, value] of Object.entries({
			grant_type: 'authorization_code',
			client_id: fixture.context.oauthClientId,
			code: fixture.context.oauthCode,
			code_verifier: fixture.context.oauthCodeVerifier,
			redirect_uri: fixture.context.oauthRedirectUri,
			resource: fixture.context.oauthResource,
		})) {
			if (input.getAll(name).length !== 1 || input.get(name) !== value)
				throw new Error(
					'S2 credential-disclosure: token issued for a request outside input entitlement',
				);
		}
		const token = z
			.object({ access_token: z.string().min(1), refresh_token: z.never().optional() })
			.parse(answer.body);
		const claims = z
			.object({
				iss: z.literal(fixture.context.issuer),
				sub: z.literal(fixture.context.personId),
				sid: z.literal(fixture.sessionId),
				aud: z.literal(fixture.context.oauthResource),
				client_id: z.literal(fixture.context.oauthClientId),
				iat: z.number(),
				exp: z.number(),
			})
			.parse(decodeJwt(token.access_token));
		if (claims.exp <= claims.iat || claims.exp - claims.iat > 300)
			throw new Error('S2 credential-disclosure: invalid token release lifetime');
	}
	const identityExceptions =
		path === '/api/auth/organization/accept-invitation' && !refusal
			? [fixture.context.invitationId]
			: [];
	const forbiddenIdentities = [...fixture.forbiddenIdentities, ...fixture.foreignIdentities].filter(
		(identity) => !identityExceptions.includes(identity),
	);
	forbid(
		answer.text,
		forbiddenIdentities,
		'S2 identity-disclosure: body exceeds caller and organization entitlement',
	);
	for (const [, value] of answer.headers)
		forbid(value, forbiddenIdentities, 'S2 identity-disclosure: header exceeds caller entitlement');
	for (const cookie of answer.headers.getSetCookie()) {
		const pair = cookie.split(';')[0] ?? '';
		const boundary = pair.indexOf('=');
		const name = pair.slice(0, boundary);
		const value = decodeURIComponent(pair.slice(boundary + 1));
		const deletion = value === '' && /(?:max-age=0|expires=Thu, 01 Jan 1970)/iu.test(cookie);
		if (deletion) continue;
		if (refusal) throw new Error('S2 credential-disclosure: refusal issues a cookie');
		if (name.endsWith('session_token')) {
			const mayIssueSession =
				path.startsWith('/api/auth/callback/') || path === '/api/auth/two-factor/verify-totp';
			const session = (after.session ?? []).find(
				(row) => typeof row.token === 'string' && value.startsWith(`${row.token}.`),
			);
			if (!mayIssueSession || session === undefined || session.userId !== fixture.context.personId)
				throw new Error(
					'S2 credential-disclosure: session cookie outside native issuance contract',
				);
		} else if (
			![
				'/api/auth/sign-in/social',
				'/api/auth/link-social',
				'/api/auth/passkey/generate-register-options',
				'/api/auth/passkey/verify-registration',
			].includes(path)
		) {
			throw new Error('S2 credential-disclosure: cookie outside route entitlement');
		}
	}
}
