import { epochMillisecondsSchema, uuid7Schema } from '@agent-collaboration/sign-in-core';
import { z } from 'zod';

import type { PreparedDriverCall } from '#sign-in-test-support/test-fixtures/database-fault-identity';

export const personConfirmationProbeHeader = 'x-auth-proof-person-confirmation';
export const personConfirmationProbeSchema = z.strictObject({
	sessionId: uuid7Schema,
	advanceBeforeReadMilliseconds: z.number().int().min(0).max(60_000),
});
export const personConfirmationObservationSchema = z.strictObject({
	point: z.literal('first-person-session-read'),
	sessionId: uuid7Schema,
	checkedAt: epochMillisecondsSchema,
});
export type PersonConfirmationProbe = z.infer<typeof personConfirmationProbeSchema>;

export function readPersonConfirmationProbe(request: Request): PersonConfirmationProbe | null {
	if (new URL(request.url).pathname !== '/api/auth/oauth2/introspect') return null;
	const header = request.headers.get(personConfirmationProbeHeader);
	return header === null ? null : personConfirmationProbeSchema.parse(JSON.parse(header));
}

export function personSessionReadKind(
	call: PreparedDriverCall,
	sessionId: string,
): 'provider' | 'confirmation' | 'other' {
	if (
		!/^select\b/iu.test(call.query) ||
		!call.query.includes('from "session"') ||
		!call.parameters.includes(sessionId)
	)
		return 'other';
	return /where\b.*"session"\."userId"/iu.test(call.query) ? 'confirmation' : 'provider';
}
