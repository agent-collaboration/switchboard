import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

import {
	createPersonTokenVerifier,
	personTokenClaimsSchema,
} from '@agent-collaboration/tool-access/contracts';
import { z } from 'zod';

import {
	cachedOwnerTokenSchema,
	requirePrivateRuntimePath,
	saveOwnerToken,
	type AuthTarget,
} from '#sign-in-owner-cli/auth-target';
import { authorizeThroughLoopback } from '#sign-in-owner-cli/loopback-authorization';

const maximumOwnerTokenLifetimeSeconds = 300;
const ownerTokenClockSkewSeconds = 60;
type OwnerTokenPolicyCheck =
	| { readonly kind: 'accepted' }
	| {
			readonly kind: 'refused';
			readonly reason:
				| 'refused:malformed'
				| 'wrong-client'
				| 'lifetime-exceeds-issuance-ceiling'
				| 'lifetime-exceeds-local-window';
	  };

/** Called only after signature/issuer/audience/expiry verification. The existing
 * raw-claims schema remains the authority for the authenticated payload. */
function checkVerifiedOwnerToken(props: {
	readonly token: string;
	readonly expectedClientId: string;
	readonly now: () => number;
}): OwnerTokenPolicyCheck {
	let payload: unknown;
	try {
		const encoded = props.token.split('.')[1];
		if (encoded === undefined) return { kind: 'refused', reason: 'refused:malformed' };
		payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
	} catch {
		return { kind: 'refused', reason: 'refused:malformed' };
	}
	const claims = personTokenClaimsSchema.safeParse(payload);
	if (!claims.success) return { kind: 'refused', reason: 'refused:malformed' };
	if (claims.data.client_id !== props.expectedClientId)
		return { kind: 'refused', reason: 'wrong-client' };
	if (claims.data.exp - claims.data.iat > maximumOwnerTokenLifetimeSeconds)
		return { kind: 'refused', reason: 'lifetime-exceeds-issuance-ceiling' };
	if (
		claims.data.exp * 1000 >
		props.now() + (maximumOwnerTokenLifetimeSeconds + ownerTokenClockSkewSeconds) * 1000
	)
		return { kind: 'refused', reason: 'lifetime-exceeds-local-window' };
	return { kind: 'accepted' };
}

export function ownerPkceChallenge(verifier: string): string {
	return createHash('sha256').update(verifier).digest('base64url');
}

export async function openBrowser(url: string): Promise<void> {
	const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
	await promisify(execFile)(command, [url]);
}

/** Public native code+S256 flow. An expired credential requires another browser sign-in; no refresh exists. */
export async function ownerManagementToken(props: {
	readonly target: AuthTarget;
	readonly forceAuth?: boolean;
	readonly browser?: (url: string) => Promise<void>;
	readonly now?: () => number;
}): Promise<string> {
	const target = props.target;
	const now = props.now ?? Date.now;
	const verifier = createPersonTokenVerifier({
		deployment: target.issuer,
		audience: target.managementAudience,
		jwksUrl: new URL('/api/auth/jwks', target.issuer),
		now,
	});
	if (props.forceAuth !== true) {
		try {
			const cached = cachedOwnerTokenSchema.parse(
				JSON.parse(
					await readFile(await requirePrivateRuntimePath(target.tokenCachePath, true), 'utf8'),
				),
			);
			if (
				cached.issuer === target.issuer &&
				cached.audience === target.managementAudience &&
				cached.clientId === target.ownerCliClientId &&
				cached.expiresAt > now()
			) {
				const checked = await verifier.verify(cached.token);
				if (
					checked.kind === 'verified' &&
					checkVerifiedOwnerToken({
						token: cached.token,
						expectedClientId: target.ownerCliClientId,
						now,
					}).kind === 'accepted'
				)
					return cached.token;
				if (checked.kind === 'unavailable')
					throw new Error('Sign-in service unavailable; no owner authorization started');
			}
		} catch (error) {
			if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
		}
	}
	const codeVerifier = randomBytes(32).toString('base64url');
	const { code, redirectUri } = await authorizeThroughLoopback({
		issuer: target.issuer,
		redirectUri: target.ownerCliRedirectUri,
		clientId: target.ownerCliClientId,
		scope: 'tool-portal:management',
		resource: target.managementAudience,
		codeChallenge: ownerPkceChallenge(codeVerifier),
		browser: props.browser ?? openBrowser,
	});
	const result = await fetch(new URL('/api/auth/oauth2/token', target.issuer), {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: 'authorization_code',
			client_id: target.ownerCliClientId,
			code,
			code_verifier: codeVerifier,
			redirect_uri: redirectUri,
			resource: target.managementAudience,
		}),
	});
	if (!result.ok) throw new Error('Owner code exchange refused');
	const token = z
		.object({
			access_token: z.string(),
			expires_in: z.number().positive().max(300),
			refresh_token: z.never().optional(),
		})
		.parse(await result.json());
	const checked = await verifier.verify(token.access_token);
	if (checked.kind !== 'verified')
		throw new Error(`Owner token failed verification (${checked.kind}:${checked.reason})`);
	const policy = checkVerifiedOwnerToken({
		token: token.access_token,
		expectedClientId: target.ownerCliClientId,
		now,
	});
	if (policy.kind === 'refused')
		throw new Error(`Owner token failed verification (${policy.reason})`);
	await saveOwnerToken(target.tokenCachePath, {
		issuer: target.issuer,
		audience: target.managementAudience,
		clientId: target.ownerCliClientId,
		token: token.access_token,
		expiresAt: checked.proof.expiresAt * 1000,
	});
	return token.access_token;
}
