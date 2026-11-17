import {
	epochMillisecondsSchema,
	uuid7Schema,
	type SignInClock,
	type SignInCrypto,
	type SignInDeadlines,
	type SignInPlatform,
} from '@agent-collaboration/sign-in-core';
import { v7 as uuid7 } from 'uuid';

const webClock: SignInClock = {
	now: () => epochMillisecondsSchema.parse(Date.now()),
};

/** The runtime's own timer; a fired deadline aborts with a `TimeoutError`, as fetch timeouts do. */
const webDeadlines: SignInDeadlines = {
	start(milliseconds) {
		const controller = new AbortController();
		const timer = setTimeout(
			() => controller.abort(new DOMException('Deadline reached', 'TimeoutError')),
			milliseconds,
		);
		return { signal: controller.signal, cancel: () => clearTimeout(timer) };
	},
};

/** The runtime's own Web Crypto: the one place a sign-in host reads it (R30). */
const webCrypto: SignInCrypto = globalThis.crypto;

export function createWebSignInCapabilities(
	clock: SignInClock = webClock,
	deadlines: SignInDeadlines = webDeadlines,
	crypto: SignInCrypto = webCrypto,
): Pick<SignInPlatform, 'clock' | 'crypto' | 'deadlines' | 'ids'> {
	return {
		clock,
		crypto,
		deadlines,
		ids: { nextId: () => uuid7Schema.parse(uuid7({ msecs: clock.now() })) },
	};
}
