import { z } from 'zod';

import type { NodeHttpRequestIdentity } from '#sign-in-test-support/test-fixtures/node-management-bridge-contracts';

const transportCodeSchema = z.enum([
	'ECONNRESET',
	'ECONNREFUSED',
	'ECONNABORTED',
	'EPIPE',
	'EMFILE',
	'ENFILE',
	'ETIMEDOUT',
	'UND_ERR_SOCKET',
	'UND_ERR_CONNECT_TIMEOUT',
	'UND_ERR_HEADERS_TIMEOUT',
	'UND_ERR_BODY_TIMEOUT',
	'ERR_STREAM_PREMATURE_CLOSE',
	'ABORT_ERR',
]);
const errorCauseSchema = z.object({ code: z.unknown().optional(), cause: z.unknown().optional() });

/** Only bounded protocol codes reach diagnostics; messages and request values do not. */
export function recordLocalAuthTransportFailure(
	at: 'browser' | 'forwarder',
	error: unknown,
	request?: NodeHttpRequestIdentity & {
		readonly requestId: string;
		readonly nodeInvocationId: string | null;
	},
): void {
	const codes: z.infer<typeof transportCodeSchema>[] = [];
	const visited = new Set<unknown>();
	let candidate = error;
	while (candidate !== undefined && !visited.has(candidate)) {
		visited.add(candidate);
		const parsed = errorCauseSchema.safeParse(candidate);
		if (!parsed.success) break;
		const code = transportCodeSchema.safeParse(parsed.data.code);
		if (code.success) codes.push(code.data);
		candidate = parsed.data.cause;
	}
	process.stderr.write(
		`${JSON.stringify({ event: 'auth-harness-transport-failed', at, codes, ...request })}\n`,
	);
}
