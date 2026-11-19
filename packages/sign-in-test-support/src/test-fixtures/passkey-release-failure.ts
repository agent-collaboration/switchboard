import { z } from 'zod';

import type { PreparedDriverCall } from '#sign-in-test-support/test-fixtures/database-fault-identity';

export const passkeyReleaseFailureStateSchema = z.enum([
	'idle',
	'armed',
	'inserted',
	'release-read-failed',
	'cleanup-failed',
]);

/** Faults the real release read, then its first cleanup; later cleanup and audit stay writable. */
export function createPasskeyReleaseFailure(): {
	readonly control: (request: Request) => Response | null;
	readonly beforeDriverCall: (call: PreparedDriverCall) => void;
} {
	let state: z.infer<typeof passkeyReleaseFailureStateSchema> = 'idle';
	return {
		control(request: Request): Response | null {
			if (new URL(request.url).pathname !== '/__auth-proof/passkey-release-failure') return null;
			if (request.method === 'POST') state = 'armed';
			return Response.json({ state });
		},
		beforeDriverCall(call: PreparedDriverCall): void {
			if (state === 'armed' && /^\s*insert into "session"/iu.test(call.query)) {
				state = 'inserted';
			} else if (
				state === 'inserted' &&
				/^\s*select\b/iu.test(call.query) &&
				call.query.includes('from "session"') &&
				call.query.includes('"session"."id" =') &&
				call.query.includes('"session"."userId" =')
			) {
				state = 'release-read-failed';
				throw new Error('Injected passkey release session read failure');
			} else if (
				state === 'release-read-failed' &&
				/^\s*delete from "session"/iu.test(call.query)
			) {
				state = 'cleanup-failed';
				throw new Error('Injected first passkey release cleanup failure');
			}
		},
	};
}
