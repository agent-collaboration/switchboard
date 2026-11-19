import { signInRequestPolicies, type SignInClock } from '@agent-collaboration/sign-in-core';

import { handlePasskeySessionProofControl } from '#sign-in-test-support/test-fixtures/recording-d1-database';

type LimiterProofMode =
	| { readonly kind: 'real' }
	| { readonly kind: 'unavailable' }
	| {
			readonly kind: 'controlled-passkey-window';
			readonly signInAttempts: AuthWorkerEnv['SIGN_IN_ATTEMPTS'];
	  }
	| { readonly kind: 'controlled-window'; readonly authRequests: AuthWorkerEnv['AUTH_REQUESTS'] };
let limiterMode: LimiterProofMode = { kind: 'real' };

/** Only service-page counting stands in; other keys keep the supplied real binding. */
export function createControlledServicePageBinding(props: {
	readonly actualBinding: AuthWorkerEnv['AUTH_REQUESTS'];
	readonly clock: SignInClock;
}): AuthWorkerEnv['AUTH_REQUESTS'] {
	return createControlledRequestClassBinding({ ...props, requestClass: 'service-page' });
}

export function createControlledPasskeyBinding(props: {
	readonly actualBinding: AuthWorkerEnv['SIGN_IN_ATTEMPTS'];
	readonly clock: SignInClock;
}): AuthWorkerEnv['SIGN_IN_ATTEMPTS'] {
	return createControlledRequestClassBinding({ ...props, requestClass: 'callback-passkey' });
}

function createControlledRequestClassBinding(props: {
	readonly actualBinding: AuthWorkerEnv['AUTH_REQUESTS'];
	readonly clock: SignInClock;
	readonly requestClass: 'service-page' | 'callback-passkey';
}): AuthWorkerEnv['AUTH_REQUESTS'] {
	const windows = new Map<string, { readonly expiresAt: number; count: number }>();
	return {
		async limit(options): Promise<{ readonly success: boolean }> {
			if (!options.key.startsWith(`${props.requestClass}:`))
				return props.actualBinding.limit(options);
			const policy = signInRequestPolicies[props.requestClass].outer;
			const now = props.clock.now();
			const window = windows.get(options.key);
			if (window === undefined || now >= window.expiresAt) {
				windows.set(options.key, { expiresAt: now + policy.windowSeconds * 1000, count: 1 });
				return { success: true };
			}
			if (window.count >= policy.max) return { success: false };
			window.count += 1;
			return { success: true };
		},
	};
}

export function handleAuthProofLimiterControl(
	request: Request,
	bindings: AuthWorkerEnv,
	clock: SignInClock,
): Response | null {
	const passkeyControl = handlePasskeySessionProofControl(request);
	if (passkeyControl !== null) return passkeyControl;
	if (request.method !== 'POST') return null;
	const pathname = new URL(request.url).pathname;
	if (pathname === '/__auth-proof/limiter-unavailable') {
		limiterMode = { kind: 'unavailable' };
		return Response.json({ kind: 'armed' });
	}
	if (pathname === '/__auth-proof/limiter-controlled-window') {
		limiterMode = {
			kind: 'controlled-window',
			authRequests: createControlledServicePageBinding({
				actualBinding: bindings.AUTH_REQUESTS,
				clock,
			}),
		};
		return Response.json({ kind: 'controlled-window' });
	}
	if (pathname === '/__auth-proof/limiter-controlled-passkey-window') {
		limiterMode = {
			kind: 'controlled-passkey-window',
			signInAttempts: createControlledPasskeyBinding({
				actualBinding: bindings.SIGN_IN_ATTEMPTS,
				clock,
			}),
		};
		return Response.json({ kind: 'controlled-passkey-window' });
	}
	return null;
}

/** Default proof uses real bindings. Explicit controls name the unavailable or
 * clock-controlled stand-in; production still constructs its unchanged adapter. */
export function authProofRateLimitBindings(bindings: AuthWorkerEnv): AuthWorkerEnv {
	switch (limiterMode.kind) {
		case 'real':
			return bindings;
		case 'controlled-window':
			return { ...bindings, AUTH_REQUESTS: limiterMode.authRequests };
		case 'controlled-passkey-window':
			return { ...bindings, SIGN_IN_ATTEMPTS: limiterMode.signInAttempts };
		case 'unavailable': {
			const rejectingBinding = {
				async limit(): Promise<never> {
					throw new Error('Injected binding rejection');
				},
			};
			return { ...bindings, SIGN_IN_ATTEMPTS: rejectingBinding, AUTH_REQUESTS: rejectingBinding };
		}
		default:
			return limiterMode satisfies never;
	}
}
