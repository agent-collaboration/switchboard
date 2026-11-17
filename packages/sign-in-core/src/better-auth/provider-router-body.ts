/**
 * What Better Auth's router decides about a request body before any middleware or endpoint runs:
 * Better Call 1.4.2 `getBody` (`dist/utils.mjs:4-31`) under Better Auth 1.7.11's router-wide
 * `allowedMediaTypes: ["application/json"]` (`dist/api/index.mjs:163`).
 *
 * A wrapper check that must run before the provider reads the body this way, so client input the
 * provider would refuse at parse time gets the provider's own parse-time status, not a later one.
 */
export type ProviderRouterBody =
	/** No body stream: the router parses nothing and leaves the decision to the endpoint. */
	| { readonly kind: 'absent' }
	/** The router refuses the body before any middleware or endpoint runs. */
	| { readonly kind: 'refused'; readonly response: Response }
	/** An allowed type the router does not parse as JSON, so it can carry no JSON fields. */
	| { readonly kind: 'not-json' }
	| { readonly kind: 'json'; readonly payload: unknown };

const providerAllowedMediaType = 'application/json';
const jsonContentTypePattern = /^application\/([a-z0-9.+-]*\+)?json/iu;

/** Reads a clone; the original request still reaches the provider unread. */
export async function readProviderRouterBody(request: Request): Promise<ProviderRouterBody> {
	const contentType = request.headers.get('content-type') ?? '';
	const normalizedContentType = contentType.toLowerCase();
	if (request.body === null) return { kind: 'absent' };
	const baseType = normalizedContentType.split(';')[0]?.trim() ?? '';
	if (!baseType.includes(providerAllowedMediaType))
		return refused(
			415,
			'UNSUPPORTED_MEDIA_TYPE',
			normalizedContentType === ''
				? `Content-Type is required. Allowed types: ${providerAllowedMediaType}`
				: `Content-Type "${contentType}" is not allowed. Allowed types: ${providerAllowedMediaType}`,
		);
	if (!jsonContentTypePattern.test(normalizedContentType)) return { kind: 'not-json' };
	try {
		return { kind: 'json', payload: await request.clone().json() };
	} catch (error) {
		// A stream fault is not client input; it stays a server failure.
		if (!(error instanceof SyntaxError)) throw error;
		return refused(400, 'BAD_REQUEST', 'Invalid JSON in request body');
	}
}

function refused(
	status: 400 | 415,
	code: 'BAD_REQUEST' | 'UNSUPPORTED_MEDIA_TYPE',
	message: string,
): ProviderRouterBody {
	return {
		kind: 'refused',
		response: Response.json(
			{ message, code },
			{ status, headers: { 'cache-control': 'no-store' } },
		),
	};
}
