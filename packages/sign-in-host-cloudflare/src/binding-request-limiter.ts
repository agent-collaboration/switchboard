import {
	signInRequestPolicies,
	type SignInRequestLimiter,
} from '@agent-collaboration/sign-in-core';
import { z } from 'zod';

interface WorkerRateLimitBinding {
	readonly limit: (options: Parameters<RateLimit['limit']>[0]) => Promise<unknown>;
}
const bindingOutcomeSchema = z.object({ success: z.boolean() });

/** Cloudflare owns the approximate per-location count. No request, response or
 * address is persisted by this adapter, and an unavailable binding fails closed. */
export function createBindingRequestLimiter(props: {
	readonly signInAttempts: WorkerRateLimitBinding;
	readonly authRequests: WorkerRateLimitBinding;
}): SignInRequestLimiter {
	return {
		async allow(request) {
			try {
				const policy = signInRequestPolicies[request.requestClass];
				const binding =
					policy.binding === 'SIGN_IN_ATTEMPTS' ? props.signInAttempts : props.authRequests;
				const outcome = bindingOutcomeSchema.safeParse(
					await binding.limit({ key: `${request.requestClass}:${request.address}` }),
				);
				if (!outcome.success) return { kind: 'unavailable' };
				return outcome.data.success
					? { kind: 'allowed' }
					: { kind: 'limited', retryAfterSeconds: policy.outer.windowSeconds };
			} catch {
				return { kind: 'unavailable' };
			}
		},
	};
}
