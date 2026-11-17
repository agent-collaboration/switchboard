import { z } from 'zod';

import type { NodeHttpRequestIdentity } from '#sign-in-test-support/test-fixtures/node-management-bridge-contracts';

const errorNameSchema = z.enum([
	'Error',
	'TypeError',
	'SyntaxError',
	'ZodError',
	'APIError',
	'SqliteError',
]);
const causeCodeSchema = z.enum([
	'SQLITE_BUSY',
	'SQLITE_BUSY_SNAPSHOT',
	'SQLITE_LOCKED',
	'SQLITE_ERROR',
	'SQLITE_IOERR',
	'SQLITE_CORRUPT',
	'SQLITE_CONSTRAINT',
	'SQLITE_READONLY',
	'ECONNRESET',
	'ECONNREFUSED',
	'EMFILE',
	'ENFILE',
]);
const apiStatusSchema = z.enum(['SERVICE_UNAVAILABLE', 'FORBIDDEN', 'TOO_MANY_REQUESTS']);
const errorShapeSchema = z.object({
	name: z.unknown().optional(),
	code: z.unknown().optional(),
	status: z.unknown().optional(),
	body: z.unknown().optional(),
	cause: z.unknown().optional(),
});

/** Diagnostic-only closed labels. Never retain messages, SQL, parameters or request bodies. */
export function nodeProofFailureLabels(error: unknown): {
	readonly names: readonly z.infer<typeof errorNameSchema>[];
	readonly codes: readonly z.infer<typeof causeCodeSchema>[];
	readonly statuses: readonly z.infer<typeof apiStatusSchema>[];
	readonly storageUnavailable: boolean;
} {
	const names: z.infer<typeof errorNameSchema>[] = [];
	const codes: z.infer<typeof causeCodeSchema>[] = [];
	const statuses: z.infer<typeof apiStatusSchema>[] = [];
	let storageUnavailable = false;
	let candidate = error;
	const visited = new Set<unknown>();
	while (candidate !== undefined && !visited.has(candidate)) {
		visited.add(candidate);
		const shape = errorShapeSchema.safeParse(candidate);
		if (!shape.success) break;
		const name = errorNameSchema.safeParse(shape.data.name);
		const code = causeCodeSchema.safeParse(shape.data.code);
		const status = apiStatusSchema.safeParse(shape.data.status);
		if (name.success) names.push(name.data);
		if (code.success) codes.push(code.data);
		if (status.success) statuses.push(status.data);
		storageUnavailable ||= z
			.object({ message: z.literal('sign-in-storage-unavailable') })
			.safeParse(shape.data.body).success;
		candidate = shape.data.cause;
	}
	return { names, codes, statuses, storageUnavailable };
}

export function recordNodeProofInvocationFailure(
	error: unknown,
	request: NodeHttpRequestIdentity & { readonly invocationId: string },
): void {
	process.stderr.write(
		`${JSON.stringify({ event: 'node-proof-invocation-failed', ...request, ...nodeProofFailureLabels(error) })}\n`,
	);
}
