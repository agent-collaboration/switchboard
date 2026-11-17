import { z } from 'zod';

import { nodeHttpRequestIdentitySchema } from '#sign-in-test-support/test-fixtures/node-management-bridge-contracts';

const transportContextSchema = nodeHttpRequestIdentitySchema.extend({
	requestId: z.uuidv7(),
	nodeInvocationId: z.uuidv7().nullable(),
	host: z.enum(['node', 'cloudflare']),
});
export type AuthProofTransportContext = z.infer<typeof transportContextSchema>;
const transportEventSchema = z.discriminatedUnion('phase', [
	transportContextSchema.extend({ phase: z.literal('fetch-start') }),
	transportContextSchema.extend({ phase: z.literal('fetch-headers'), status: z.number().int() }),
	transportContextSchema.extend({ phase: z.literal('body-read'), status: z.number().int() }),
	transportContextSchema.extend({
		phase: z.literal('response-finished'),
		status: z.number().int(),
	}),
	transportContextSchema.extend({ phase: z.literal('response-closed'), finished: z.boolean() }),
]);
export type AuthProofTransportEvent = z.infer<typeof transportEventSchema>;

/** Private diagnostic records contain no query, headers, body or error message. */
export function recordAuthProofTransportEvent(event: AuthProofTransportEvent): void {
	try {
		process.stderr.write(
			`${JSON.stringify({ event: 'auth-proof-transport', ...transportEventSchema.parse(event) })}\n`,
		);
	} catch {
		// Diagnostic output never decides the transport result.
	}
}
import type { ServerResponse } from 'node:http';

export function observeAuthProofForwarder(
	context: AuthProofTransportContext,
	response: ServerResponse,
): {
	readonly headersReceived: (status: number) => void;
	readonly bodyRead: (status: number) => void;
} {
	recordAuthProofTransportEvent({ ...context, phase: 'fetch-start' });
	response.once('finish', () =>
		recordAuthProofTransportEvent({
			...context,
			phase: 'response-finished',
			status: response.statusCode,
		}),
	);
	response.once('close', () =>
		recordAuthProofTransportEvent({
			...context,
			phase: 'response-closed',
			finished: response.writableFinished,
		}),
	);
	return {
		headersReceived: (status: number): void =>
			recordAuthProofTransportEvent({ ...context, phase: 'fetch-headers', status }),
		bodyRead: (status: number): void =>
			recordAuthProofTransportEvent({ ...context, phase: 'body-read', status }),
	};
}
