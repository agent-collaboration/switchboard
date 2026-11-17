/** get-session is a public cookie-bound read for the sign-in pages' browser
 * components (owner decision, 12 Nov). Better Auth 1.7.11 includes
 * `session.token` in its JSON; this keeps the token where the httpOnly cookie
 * keeps it, out of page scripts. */
export type SessionReadBody =
	| { readonly kind: 'unchanged' }
	| { readonly kind: 'stripped'; readonly body: Readonly<Record<string, unknown>> };

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Accepts the endpoint's returned value in either shape Better Auth hands an
 * after hook: the plain body, or better-call's `{ body, _flag: 'json' }`. */
export function sessionReadWithoutToken(returned: unknown): SessionReadBody {
	const body = isRecord(returned) && returned['_flag'] === 'json' ? returned['body'] : returned;
	if (!isRecord(body)) return { kind: 'unchanged' };
	const session = body['session'];
	if (!isRecord(session)) return { kind: 'unchanged' };
	const { token: _withheldToken, ...sessionWithoutToken } = session;
	return { kind: 'stripped', body: { ...body, session: sessionWithoutToken } };
}
