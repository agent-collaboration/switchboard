import { expect, it } from 'vitest';

import {
	readProviderRouterBody,
	type ProviderRouterBody,
} from '#sign-in-core/better-auth/provider-router-body';

const linkSocial = 'https://sign-in.example.invalid/api/auth/link-social';

async function observe(body: ProviderRouterBody): Promise<unknown> {
	return body.kind === 'refused'
		? {
				kind: 'refused',
				status: body.response.status,
				body: await body.response.json(),
				cacheControl: body.response.headers.get('cache-control'),
			}
		: body;
}

it.each([
	{
		name: 'a null body parses nothing, whatever its type',
		request: new Request(linkSocial, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
		}),
		expected: { kind: 'absent' },
	},
	{
		name: 'an empty non-null JSON body is malformed JSON',
		request: new Request(linkSocial, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: new Uint8Array(),
		}),
		expected: {
			kind: 'refused',
			status: 400,
			body: { code: 'BAD_REQUEST', message: 'Invalid JSON in request body' },
			cacheControl: 'no-store',
		},
	},
	{
		name: 'a JSON body with parameters parses',
		request: new Request(linkSocial, {
			method: 'POST',
			headers: { 'content-type': 'Application/JSON; charset=utf-8' },
			body: '{"provider":"github"}',
		}),
		expected: { kind: 'json', payload: { provider: 'github' } },
	},
	{
		name: 'a structured +json type fails the media gate before the JSON pattern',
		request: new Request(linkSocial, {
			method: 'POST',
			headers: { 'content-type': 'application/vnd.example+json' },
			body: '{"idToken":{}}',
		}),
		expected: {
			kind: 'refused',
			status: 415,
			body: {
				code: 'UNSUPPORTED_MEDIA_TYPE',
				message:
					'Content-Type "application/vnd.example+json" is not allowed. Allowed types: application/json',
			},
			cacheControl: 'no-store',
		},
	},
	{
		name: 'a body without a type is refused as missing one',
		request: new Request(linkSocial, { method: 'POST', body: new Uint8Array([123]) }),
		expected: {
			kind: 'refused',
			status: 415,
			body: {
				code: 'UNSUPPORTED_MEDIA_TYPE',
				message: 'Content-Type is required. Allowed types: application/json',
			},
			cacheControl: 'no-store',
		},
	},
	{
		name: 'an allowed type outside the JSON pattern is read as no JSON at all',
		request: new Request(linkSocial, {
			method: 'POST',
			headers: { 'content-type': 'text/application/json' },
			body: '{"idToken":{}}',
		}),
		expected: { kind: 'not-json' },
	},
])('$name, as Better Call 1.4.2 getBody decides', async ({ request, expected }) => {
	// Act
	const body = await readProviderRouterBody(request);
	// Assert
	expect(await observe(body)).toEqual(expected);
	expect(request.bodyUsed).toBe(false);
});
