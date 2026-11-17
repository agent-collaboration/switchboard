let backingUnavailable = false;
export function handleAuthProofLimiterControl(request: Request): Response | null {
	if (
		request.method !== 'POST' ||
		new URL(request.url).pathname !== '/__auth-proof/limiter-unavailable'
	)
		return null;
	backingUnavailable = true;
	return Response.json({ kind: 'armed' });
}

/** Miniflare's real rate-limit bindings count every request (S9). Only the one
 * armed backing-failure case replaces them, with a binding that rejects. The
 * unchanged production Worker still constructs its real adapter/core/DB path. */
export function authProofRateLimitBindings(bindings: AuthWorkerEnv): AuthWorkerEnv {
	if (backingUnavailable) {
		const rejectingBinding = {
			async limit(): Promise<never> {
				throw new Error('Injected binding rejection');
			},
		};
		return { ...bindings, SIGN_IN_ATTEMPTS: rejectingBinding, AUTH_REQUESTS: rejectingBinding };
	}
	return bindings;
}
