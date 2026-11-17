import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { parse, type ParseError, type ParseOptions } from 'jsonc-parser';
import { z } from 'zod';

const parseJsonc: (text: string, errors: ParseError[], options: ParseOptions) => unknown = parse;
const limitBindingSchema = z
	.object({
		name: z.enum(['SIGN_IN_ATTEMPTS', 'AUTH_REQUESTS']),
		namespace_id: z.string().min(1),
		simple: z.object({ limit: z.number().int().positive(), period: z.literal(60) }),
	})
	.transform((binding) => ({
		name: binding.name,
		options: {
			type: 'rate-limit' as const,
			namespace: binding.namespace_id,
			simple: binding.simple,
		},
	}));
type ProofLimitBinding = z.output<typeof limitBindingSchema>['options'];

/** Use the deployment example's real limits, not a second literal fixture
 * policy. A local runtime restart does not prove a vendor counter reset. */
export async function loadProofRateLimitBindings(repositoryRoot: string): Promise<{
	readonly SIGN_IN_ATTEMPTS: ProofLimitBinding;
	readonly AUTH_REQUESTS: ProofLimitBinding;
}> {
	const text = await readFile(
		path.join(repositoryRoot, 'packages/sign-in-host-cloudflare/wrangler.example.jsonc'),
		'utf8',
	);
	const errors: ParseError[] = [];
	const parsed = parseJsonc(text, errors, { allowTrailingComma: true, disallowComments: false });
	if (errors.length > 0)
		throw new Error('The proof rate-limit deployment example is invalid JSONC');
	const config = z.object({ ratelimits: z.array(limitBindingSchema).length(2) }).parse(parsed);
	const attempts = config.ratelimits.find((binding) => binding.name === 'SIGN_IN_ATTEMPTS');
	const auth = config.ratelimits.find((binding) => binding.name === 'AUTH_REQUESTS');
	if (attempts === undefined || auth === undefined)
		throw new Error('The deployment example must provide both rate-limit bindings');
	return { SIGN_IN_ATTEMPTS: attempts.options, AUTH_REQUESTS: auth.options };
}
