import {
	signInRequestPolicies,
	type SignInClock,
	type SignInRequestLimiter,
} from '@agent-collaboration/sign-in-core';

interface AddressWindow {
	readonly expiresAt: number;
	count: number;
}

/** One process owns this map. Each class/address's fixed window starts at its
 * first request, never moves on later requests, and is pruned after expiry. */
export function createFixedWindowRequestLimiter(clock: SignInClock): SignInRequestLimiter {
	const windows = new Map<string, AddressWindow>();
	return {
		allow(request) {
			const now = clock.now();
			for (const [key, window] of windows) if (now >= window.expiresAt) windows.delete(key);
			const policy = signInRequestPolicies[request.requestClass].outer;
			const key = `${request.requestClass}:${request.address}`;
			const current = windows.get(key);
			if (current === undefined) {
				windows.set(key, { count: 1, expiresAt: now + policy.windowSeconds * 1000 });
				return Promise.resolve({ kind: 'allowed' });
			}
			if (current.count >= policy.max)
				return Promise.resolve({
					kind: 'limited',
					retryAfterSeconds: Math.max(1, Math.ceil((current.expiresAt - now) / 1000)),
				});
			current.count += 1;
			return Promise.resolve({ kind: 'allowed' });
		},
	};
}
