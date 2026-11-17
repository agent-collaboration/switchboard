import { z } from 'zod';

/** The server decides each page's state; browser islands only render it. Each
 * island root is marked with this attribute and carries its state as JSON in
 * `data-island-state`, parsed at entry. */
export const signInIslandAttribute = 'data-sign-in-island';

const sameOriginPathSchema = z
	.string()
	.startsWith('/')
	.refine((path) => !path.startsWith('//'));

export const signInIslandStateSchema = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('passkey-sign-in'), continueLocation: sameOriginPathSchema }),
	z.strictObject({
		kind: z.literal('second-factor-enrollment'),
		ownerReadyLocation: sameOriginPathSchema,
	}),
	z.strictObject({
		kind: z.literal('second-factor-confirmation'),
		ownerReadyLocation: sameOriginPathSchema,
	}),
	z.strictObject({ kind: z.literal('passkey-management') }),
	z.strictObject({
		kind: z.literal('recovery-codes'),
		codes: z.array(z.string().min(1)).min(1),
		ownerReadyLocation: sameOriginPathSchema,
	}),
]);
export type SignInIslandState = z.infer<typeof signInIslandStateSchema>;
