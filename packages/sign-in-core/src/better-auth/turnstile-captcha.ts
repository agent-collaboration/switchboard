import type { BetterAuthOptions } from 'better-auth';
import { captcha, type CloudflareTurnstileOptions } from 'better-auth/plugins/captcha';
import { z } from 'zod';

import type { SignInConfiguration } from '#sign-in-core/contracts/deployment-configuration';
import type {
	CaptchaRefusalReason,
	TurnstileAction,
} from '#sign-in-core/contracts/sign-in-observation';
import type { SignInPlatform } from '#sign-in-core/contracts/sign-in-platform';

export type TurnstileSecret =
	| { readonly kind: 'missing' }
	| { readonly kind: 'configured'; readonly secretKey: string };

type NativeCaptchaPlugin = ReturnType<typeof captcha>;
type NativeCaptchaHook = NativeCaptchaPlugin['onRequest'];
type NativeCaptchaResult = Awaited<ReturnType<NativeCaptchaHook>>;
type ProviderLogger = NonNullable<BetterAuthOptions['logger']>;
type ProviderLogLevel = Parameters<NonNullable<ProviderLogger['log']>>[0];
type CaptchaReasonProjection =
	| { readonly kind: 'none' }
	| { readonly kind: 'captured'; readonly reason: CaptchaRefusalReason };

const nativeRefusalSchema = z.object({
	code: z.enum(['MISSING_RESPONSE', 'VERIFICATION_FAILED', 'UNKNOWN_ERROR']),
});
const nativeWarningSchema = z.object({
	reason: z.enum(['siteverify_rejected', 'action_mismatch', 'hostname_mismatch']),
	errorCodes: z.array(z.string()).optional(),
});

interface TurnstileProviderOptions {
	readonly logger: ProviderLogger;
	readonly plugins: readonly [NativeCaptchaPlugin, NativeCaptchaPlugin];
}

/** The factory is request-owned, like the surrounding provider. Native captcha
 * does all verification; this adapter only projects its own refusal response. */
export function createTurnstileProviderOptions(props: {
	readonly configuration: SignInConfiguration;
	readonly secret: TurnstileSecret;
	readonly log: SignInPlatform['log'];
}): TurnstileProviderOptions {
	let projection: CaptchaReasonProjection = { kind: 'none' };
	function readProjection(): CaptchaReasonProjection {
		return projection;
	}
	const logger: ProviderLogger = {
		log(level: ProviderLogLevel, message: string, ...details: unknown[]): void {
			if (level === 'warn' && message === 'Cloudflare Turnstile verification failed') {
				const warning = nativeWarningSchema.safeParse(details[0]);
				if (!warning.success) return;
				switch (warning.data.reason) {
					case 'action_mismatch':
						projection = { kind: 'captured', reason: 'wrong-action' };
						return;
					case 'hostname_mismatch':
						projection = { kind: 'captured', reason: 'wrong-hostname' };
						return;
					case 'siteverify_rejected':
						projection = {
							kind: 'captured',
							reason: warning.data.errorCodes?.includes('timeout-or-duplicate')
								? 'duplicate'
								: 'rejected',
						};
				}
			}
			// Drop every native message and detail: neither can enter telemetry.
		},
	};
	const sharedOptions = {
		provider: 'cloudflare-turnstile',
		secretKey: props.secret.kind === 'configured' ? props.secret.secretKey : '',
		allowedHostnames: [new URL(props.configuration.issuer).hostname],
		...(props.configuration.turnstile.kind === 'local' &&
		props.configuration.turnstile.siteVerifyURLOverride !== undefined
			? { siteVerifyURLOverride: props.configuration.turnstile.siteVerifyURLOverride }
			: {}),
	} satisfies CloudflareTurnstileOptions;

	function observeNativeCaptcha(
		nativePlugin: NativeCaptchaPlugin,
		action: TurnstileAction,
	): NativeCaptchaPlugin {
		return {
			...nativePlugin,
			async onRequest(
				request: Parameters<NativeCaptchaHook>[0],
				context: Parameters<NativeCaptchaHook>[1],
			): Promise<NativeCaptchaResult> {
				projection = { kind: 'none' };
				const result = await nativePlugin.onRequest(request, context);
				if (result === undefined) return result;
				const body: unknown = await result.response
					.clone()
					.json()
					.catch((): null => null);
				const refusal = nativeRefusalSchema.safeParse(body);
				if (refusal.success) {
					let reason: CaptchaRefusalReason;
					switch (refusal.data.code) {
						case 'MISSING_RESPONSE':
							reason = 'missing';
							break;
						case 'UNKNOWN_ERROR':
							reason = 'unavailable';
							break;
						case 'VERIFICATION_FAILED':
							const captured = readProjection();
							reason = captured.kind === 'captured' ? captured.reason : 'rejected';
							break;
					}
					props.log({ kind: 'captcha-refused', action, reason });
				}
				return result;
			},
		};
	}

	return {
		logger,
		plugins: [
			observeNativeCaptcha(
				captcha({
					...sharedOptions,
					endpoints: ['/sign-in/social'],
					expectedAction: 'sign_in_social',
				}),
				'sign_in_social',
			),
			observeNativeCaptcha(
				captcha({
					...sharedOptions,
					endpoints: ['/passkey/generate-authenticate-options'],
					expectedAction: 'passkey_sign_in',
				}),
				'passkey_sign_in',
			),
		],
	};
}
