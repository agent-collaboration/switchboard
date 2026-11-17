import { z } from 'zod';

import { trustedSignInClientAddressHeader } from '#sign-in-core/contracts/sign-in-client-address';
import type { SignInPlatform } from '#sign-in-core/contracts/sign-in-platform';
import {
	classifySignInRequest,
	requestLimitAddressKey,
	signInRequestPolicies,
	type SignInRequestClass,
	type RequestLimitResult,
} from '#sign-in-core/request-limits/request-limit-policy';

type RequestAdmission =
	| {
			readonly kind: 'allowed';
			readonly request: Request;
			readonly requestClass: SignInRequestClass;
	  }
	| { readonly kind: 'refused'; readonly response: Response };

/** Runs before public route selection or any provider/store effect. The
 * normalized trusted header is also the native provider's only IP source. */
export async function admitSignInRequest(props: {
	readonly request: Request;
	readonly platform: Pick<SignInPlatform, 'requestLimiter' | 'log'>;
}): Promise<RequestAdmission> {
	const requestClass = classifySignInRequest(new URL(props.request.url).pathname);
	const address = requestLimitAddressKey(
		props.request.headers.get(trustedSignInClientAddressHeader),
	);
	let decision: RequestLimitResult;
	try {
		decision = await props.platform.requestLimiter.allow({ requestClass, address });
	} catch {
		decision = { kind: 'unavailable' };
	}
	switch (decision.kind) {
		case 'allowed': {
			const headers = new Headers(props.request.headers);
			if (address === 'no-trusted-address') headers.delete(trustedSignInClientAddressHeader);
			else headers.set(trustedSignInClientAddressHeader, address);
			return { kind: 'allowed', requestClass, request: new Request(props.request, { headers }) };
		}
		case 'limited':
			props.platform.log({ kind: 'request-limited', requestClass, layer: 'outer' });
			return {
				kind: 'refused',
				response: Response.json(
					{ error: 'rate-limited' },
					{
						status: 429,
						headers: {
							'retry-after': String(decision.retryAfterSeconds),
							'cache-control': 'no-store',
						},
					},
				),
			};
		case 'unavailable':
			props.platform.log({ kind: 'request-limit-unavailable', requestClass });
			return {
				kind: 'refused',
				response: Response.json(
					{ error: 'sign-in-unavailable' },
					{ status: 503, headers: { 'cache-control': 'no-store' } },
				),
			};
		default:
			return decision satisfies never;
	}
}

/** Native 1.7.11 names its header X-Retry-After. Publish the standard header
 * without changing its status/body or allowing a callback audit after a limit. */
export function providerLimitedResponse(props: {
	readonly response: Response;
	readonly requestClass: SignInRequestClass;
	readonly log: SignInPlatform['log'];
}): Response {
	const headers = new Headers(props.response.headers);
	const parsed = z.coerce
		.number()
		.int()
		.positive()
		.safeParse(headers.get('retry-after') ?? headers.get('x-retry-after'));
	headers.set(
		'retry-after',
		String(
			parsed.success
				? parsed.data
				: signInRequestPolicies[props.requestClass].provider.windowSeconds,
		),
	);
	headers.set('cache-control', 'no-store');
	props.log({ kind: 'request-limited', requestClass: props.requestClass, layer: 'provider' });
	return new Response(props.response.body, {
		status: props.response.status,
		statusText: props.response.statusText,
		headers,
	});
}
