import {
	signInConfigurationSchema,
	type SignInObservation,
} from '@agent-collaboration/sign-in-core';
import {
	createSignInProvider,
	createProviderRequestState,
	type SignInHttpConfiguration,
} from '@agent-collaboration/sign-in-core/better-auth';
import {
	signInWorkerConfiguration,
	workerClientAddressHeaders,
} from '@agent-collaboration/sign-in-host-cloudflare/configuration';
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { captcha, type CloudflareTurnstileOptions } from 'better-auth/plugins/captcha';
import { z } from 'zod';

const captchaControlFields = {
	mode: z.enum(['provider', 'native-hook', 'observed-hook', 'configuration']).default('provider'),
	provider: z.enum(['google', 'unconfigured']).default('google'),
};
const providerControlSchema = z.discriminatedUnion('endpoint', [
	z.strictObject({ endpoint: z.literal('social'), ...captchaControlFields }),
	z.strictObject({ endpoint: z.literal('passkey'), ...captchaControlFields }),
	z.strictObject({
		endpoint: z.literal('passkey-verification'),
		mode: z.literal('provider').default('provider'),
		assertion: z.record(z.string(), z.unknown()),
	}),
]);

const nativeCaptchaOptionsSchema = z.object({
	provider: z.literal('cloudflare-turnstile'),
	secretKey: z.string(),
	endpoints: z.array(z.string()),
	expectedAction: z.string(),
	allowedHostnames: z.array(z.string()),
	siteVerifyURLOverride: z.url().optional(),
});
type ProviderPlugin = NonNullable<BetterAuthOptions['plugins']>[number];
interface ConfiguredCaptcha {
	readonly options: z.infer<typeof nativeCaptchaOptionsSchema>;
	readonly onRequest: NonNullable<ProviderPlugin['onRequest']>;
}

type NativeCaptchaOutcome =
	| { readonly kind: 'allowed' }
	| { readonly kind: 'response'; readonly status: number; readonly body: string };

async function describeCaptchaResponse(
	response: Response | undefined,
): Promise<NativeCaptchaOutcome> {
	return response === undefined
		? { kind: 'allowed' }
		: { kind: 'response', status: response.status, body: await response.text() };
}

/** Provider-level only. Public passkey routes remain refused by production.
 * Requests still traverse Better Auth's actual handler and captcha hooks. */
export async function handleCaptchaProviderProof(
	request: Request,
	bindings: AuthWorkerEnv,
): Promise<Response | null> {
	return handleConfiguredCaptchaProviderProof(
		new Request(request, { headers: workerClientAddressHeaders(request.headers) }),
		() => signInWorkerConfiguration(bindings),
	);
}

export async function handleConfiguredCaptchaProviderProof(
	request: Request,
	hostConfiguration: () => SignInHttpConfiguration,
): Promise<Response | null> {
	if (new URL(request.url).pathname !== '/__auth-proof/captcha-provider') return null;
	const control = providerControlSchema.parse(await request.json());
	const host = hostConfiguration();
	const configuration =
		control.mode === 'configuration'
			? signInConfigurationSchema.parse({
					...host.configuration,
					issuer: 'https://deployed-sign-in.example.invalid',
					turnstile: { kind: 'deployed', siteKey: host.configuration.turnstile.siteKey },
				})
			: host.configuration;
	const observations: SignInObservation[] = [];
	const auth = createSignInProvider({
		...host,
		configuration,
		platform: {
			...host.platform,
			log(observation: SignInObservation): void {
				observations.push(observation);
				host.platform.log(observation);
			},
		},
		authority: { kind: 'public' },
		requestState: createProviderRequestState(),
	});
	const captchaPlugins = auth.options.plugins.flatMap(
		(plugin: ProviderPlugin): readonly ConfiguredCaptcha[] => {
			if (plugin.id !== 'captcha' || plugin.onRequest === undefined) return [];
			const options = nativeCaptchaOptionsSchema.safeParse(plugin.options);
			return options.success ? [{ options: options.data, onRequest: plugin.onRequest }] : [];
		},
	);
	if (control.mode === 'configuration') {
		const configured: Pick<
			CloudflareTurnstileOptions,
			'endpoints' | 'expectedAction' | 'allowedHostnames'
		>[] = [];
		for (const plugin of captchaPlugins)
			configured.push({
				endpoints: plugin.options.endpoints,
				expectedAction: plugin.options.expectedAction,
				allowedHostnames: plugin.options.allowedHostnames,
			});
		return Response.json({
			response: { kind: 'response', status: 200, body: JSON.stringify(configured) },
			observations,
		});
	}
	const endpoint =
		control.endpoint === 'social'
			? '/sign-in/social'
			: control.endpoint === 'passkey'
				? '/passkey/generate-authenticate-options'
				: '/passkey/verify-authentication';
	const headers = new Headers(request.headers);
	headers.delete('content-length');
	const providerRequest =
		control.endpoint === 'social'
			? new Request(new URL('/api/auth' + endpoint, host.configuration.issuer), {
					method: 'POST',
					headers,
					body: JSON.stringify({
						provider: control.provider,
						callbackURL: new URL('/owner-ready', host.configuration.issuer).toString(),
					}),
				})
			: control.endpoint === 'passkey'
				? new Request(new URL('/api/auth' + endpoint, host.configuration.issuer), {
						method: 'GET',
						headers,
					})
				: new Request(new URL('/api/auth' + endpoint, host.configuration.issuer), {
						method: 'POST',
						headers,
						body: JSON.stringify(control.assertion),
					});
	if (control.mode === 'provider') {
		const response = await auth.handler(providerRequest);
		// This route deliberately bypasses the outer handler: an actual native 429
		// can therefore only come from the provider, never the outer class counter.
		if (response.status === 429) {
			const observation = {
				kind: 'request-limited',
				requestClass: control.endpoint === 'social' ? 'sign-in' : 'callback-passkey',
				layer: 'provider',
			} as const satisfies SignInObservation;
			observations.push(observation);
			host.platform.log(observation);
		}
		return Response.json({
			response: await describeCaptchaResponse(response),
			observations,
		});
	}
	const plugin = captchaPlugins.find((candidate: ConfiguredCaptcha): boolean =>
		candidate.options.endpoints.includes(endpoint),
	);
	if (plugin === undefined)
		throw new Error('Provider proof has no captcha plugin for its protected endpoint');
	const selected =
		control.mode === 'native-hook' ? captcha(plugin.options).onRequest : plugin.onRequest;
	// The standalone public hook accepts the framework's default context generic.
	// Widen its constructor options, preserving the actual configured values.
	const nativeContext = await betterAuth<BetterAuthOptions>(auth.options).$context;
	const result = await selected(providerRequest, nativeContext);
	if (result !== undefined && !('response' in result))
		throw new Error('Captcha proof hook replaced the request instead of returning a decision');
	return Response.json({
		response: await describeCaptchaResponse(result?.response),
		observations,
	});
}
