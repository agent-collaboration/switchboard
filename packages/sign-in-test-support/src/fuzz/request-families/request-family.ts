import type { TestCase } from '@hegeldev/hegel';
import * as generators from '@hegeldev/hegel/generators';

export interface RequestFamilyContext {
	readonly issuer: string;
	readonly personId: string;
	readonly organizationId: string;
	readonly memberId: string;
	readonly invitationId: string;
	readonly passkeyId: string;
	readonly challengeId: string;
	readonly passkeyRegistrationResponse: Readonly<Record<string, unknown>>;
	readonly passkeyAuthenticationResponse: Readonly<Record<string, unknown>>;
	readonly totpCode: string;
	readonly backupCode: string;
	readonly captchaToken: string;
	readonly callbackQuery: Readonly<Record<string, string>>;
	readonly oauthClientId: string;
	readonly oauthClientSecret: string;
	readonly oauthCode: string;
	readonly oauthToken: string;
	readonly oauthCodeVerifier: string;
	readonly oauthCodeChallenge: string;
	readonly oauthRedirectUri: string;
	readonly oauthResource: string;
}

export interface GeneratedRequest {
	readonly pathname: string;
	readonly init: RequestInit;
	readonly label: string;
	readonly expectation: 'success-or-refusal';
}

export interface RequestFamily {
	readonly route: { readonly method: 'GET' | 'POST'; readonly path: string };
	readonly callers: readonly ('signed-out' | 'member' | 'owner')[];
	readonly generate: (testCase: TestCase, context: RequestFamilyContext) => GeneratedRequest;
}

type Fields = Readonly<Record<string, unknown>>;
type FieldsForContext = (context: RequestFamilyContext) => Fields;

const callers = ['signed-out', 'member', 'owner'] as const;

function drawFields(testCase: TestCase, valid: Fields): { fields: Fields; label: string } {
	const variant = testCase.draw(
		generators.sampledFrom(['valid', 'near-valid', 'boundary', 'wrong-type'] as const),
	);
	const keys = Object.keys(valid);
	if (variant === 'valid') return { fields: valid, label: variant };
	if (keys.length === 0)
		return { fields: { unexpected: variant === 'wrong-type' ? null : '' }, label: variant };
	const key = testCase.draw(generators.sampledFrom(keys));
	const originalValue = valid[key];
	const value =
		variant === 'wrong-type'
			? null
			: typeof originalValue === 'number'
				? variant === 'near-valid'
					? -1
					: testCase.draw(generators.sampledFrom([0, 1, 100, 101, 2_147_483_647]))
				: typeof originalValue === 'boolean'
					? variant === 'near-valid'
						? 'false'
						: !originalValue
					: variant === 'near-valid'
						? 'invalid'
						: 'x'.repeat(testCase.draw(generators.integers({ minValue: 0, maxValue: 4096 })));
	return { fields: { ...valid, [key]: value }, label: `${variant}:${key}` };
}

export function jsonFamily(
	path: string,
	validFields: FieldsForContext,
	headersForContext: (
		context: RequestFamilyContext,
	) => Readonly<Record<string, string>> = () => ({}),
): RequestFamily {
	return {
		route: { method: 'POST', path },
		callers,
		generate(testCase: TestCase, context: RequestFamilyContext): GeneratedRequest {
			const encoding = testCase.draw(
				generators.sampledFrom(['json', 'json', 'malformed', 'wrong-content-type'] as const),
			);
			const { fields, label } = drawFields(testCase, validFields(context));
			return {
				pathname: path,
				init: {
					method: 'POST',
					headers: {
						'content-type': encoding === 'wrong-content-type' ? 'text/plain' : 'application/json',
						origin: new URL(context.issuer).origin,
						...headersForContext(context),
					},
					body: encoding === 'malformed' ? '{' : JSON.stringify(fields),
				},
				label: `${encoding}:${label}`,
				expectation: 'success-or-refusal',
			};
		},
	};
}

export function queryFamily(path: string, validFields: FieldsForContext): RequestFamily {
	return {
		route: { method: 'GET', path },
		callers,
		generate(testCase: TestCase, context: RequestFamilyContext): GeneratedRequest {
			const { fields, label } = drawFields(testCase, validFields(context));
			const query = new URLSearchParams();
			for (const [key, value] of Object.entries(fields)) {
				if (value === null || value === undefined) continue;
				if (typeof value === 'string') query.set(key, value);
				else if (typeof value === 'number' || typeof value === 'boolean')
					query.set(key, String(value));
				else query.set(key, JSON.stringify(value) ?? '');
			}
			const suffix = query.toString();
			return {
				pathname: suffix ? `${path}?${suffix}` : path,
				init: { method: 'GET' },
				label,
				expectation: 'success-or-refusal',
			};
		},
	};
}

export function formFamily(
	path: string,
	validFields: (context: RequestFamilyContext) => Readonly<Record<string, string>>,
	allowJson: boolean,
): RequestFamily {
	return {
		route: { method: 'POST', path },
		callers,
		generate(testCase: TestCase, context: RequestFamilyContext): GeneratedRequest {
			const encoding = testCase.draw(
				generators.sampledFrom(
					allowJson
						? ['form', 'json', 'malformed', 'wrong-content-type']
						: ['form', 'wrong-content-type'],
				),
			);
			const { fields, label } = drawFields(testCase, validFields(context));
			const form = new URLSearchParams();
			for (const [key, value] of Object.entries(fields)) {
				if (typeof value === 'string') form.set(key, value);
				else if (value !== null && value !== undefined) form.set(key, JSON.stringify(value) ?? '');
			}
			const isJson = encoding === 'json' || encoding === 'malformed';
			return {
				pathname: path,
				init: {
					method: 'POST',
					headers: {
						'content-type':
							encoding === 'wrong-content-type'
								? 'text/plain'
								: isJson
									? 'application/json'
									: 'application/x-www-form-urlencoded',
					},
					body: encoding === 'malformed' ? '{' : isJson ? JSON.stringify(fields) : form.toString(),
				},
				label: `${encoding}:${label}`,
				expectation: 'success-or-refusal',
			};
		},
	};
}

export function tokenFamily(path: string): RequestFamily {
	return {
		route: { method: 'POST', path },
		callers,
		generate(testCase: TestCase, context: RequestFamilyContext): GeneratedRequest {
			const variant = testCase.draw(
				generators.sampledFrom([
					'valid',
					'near-valid',
					'boundary',
					'unsupported',
					'wrong-content-type',
				] as const),
			);
			const fields: Record<string, string> = {
				grant_type: 'authorization_code',
				client_id: context.oauthClientId,
				code: context.oauthCode,
				code_verifier: context.oauthCodeVerifier,
				redirect_uri: context.oauthRedirectUri,
				resource: context.oauthResource,
			};
			if (variant === 'unsupported') fields.grant_type = 'client_credentials';
			if (variant === 'near-valid' || variant === 'boundary') {
				const key = testCase.draw(
					generators.sampledFrom([
						'client_id',
						'code',
						'code_verifier',
						'redirect_uri',
						'resource',
					]),
				);
				fields[key] = variant === 'boundary' ? '' : 'invalid';
			}
			return {
				pathname: path,
				init: {
					method: 'POST',
					headers: {
						'content-type':
							variant === 'wrong-content-type' ? 'text/plain' : 'application/x-www-form-urlencoded',
					},
					body: new URLSearchParams(fields).toString(),
				},
				label: variant,
				expectation: 'success-or-refusal',
			};
		},
	};
}

export function introspectionFamily(path: string): RequestFamily {
	return {
		route: { method: 'POST', path },
		callers,
		generate(testCase: TestCase, context: RequestFamilyContext): GeneratedRequest {
			const variant = testCase.draw(
				generators.sampledFrom(['valid', 'near-valid', 'boundary', 'wrong-content-type'] as const),
			);
			const fields = new URLSearchParams({
				token:
					variant === 'boundary' ? '' : variant === 'near-valid' ? 'invalid' : context.oauthToken,
				client_id: context.oauthClientId,
			});
			return {
				pathname: path,
				init: {
					method: 'POST',
					headers: {
						'content-type':
							variant === 'wrong-content-type' ? 'text/plain' : 'application/x-www-form-urlencoded',
						authorization: `Basic ${btoa(`${context.oauthClientId}:${context.oauthClientSecret}`)}`,
					},
					body: fields.toString(),
				},
				label: variant,
				expectation: 'success-or-refusal',
			};
		},
	};
}
