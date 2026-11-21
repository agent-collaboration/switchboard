/** Normalize transport errors before Better Auth can echo a supplied request field. */
export async function organizationRequestErrorResponse(request: Request): Promise<Response | null> {
	if (
		request.method !== 'POST' ||
		new URL(request.url).pathname !== '/api/auth/organization/person-membership'
	)
		return null;
	try {
		if (!/^application\/json(?:\s*;|$)/iu.test(request.headers.get('content-type') ?? ''))
			throw new Error('Invalid content type');
		await request.clone().json();
		return null;
	} catch {
		return Response.json(
			{ error: 'invalid-request' },
			{ status: 400, headers: { 'cache-control': 'no-store' } },
		);
	}
}

/** Hook failures happen before an endpoint can publish its closed reply. */
export function organizationReadResponse(request: Request, response: Response): Response {
	const path = new URL(request.url).pathname;
	if (
		!['self-context', 'person-membership', 'people-list', 'people'].some(
			(route) => path === `/api/auth/organization/${route}`,
		)
	)
		return response;
	const headers = new Headers(response.headers);
	headers.set('cache-control', 'no-store');
	if (response.status === 503) {
		headers.delete('content-length');
		return Response.json({ kind: 'unavailable' }, { status: 503, headers });
	}
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}
