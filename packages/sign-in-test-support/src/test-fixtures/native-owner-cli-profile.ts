import { readFile } from 'node:fs/promises';

import { epochMillisecondsSchema } from '@agent-collaboration/sign-in-core';
import { requirePrivateRuntimePath } from '@agent-collaboration/sign-in-owner-cli';
import { z } from 'zod';

const clockProfileSchema = z.strictObject({
	nowMilliseconds: epochMillisecondsSchema,
	authorization: z.enum(['force-auth', 'allow-cache']).default('force-auth'),
});
export const nativeOwnerCliProfileSchema = z.discriminatedUnion('kind', [
	clockProfileSchema.extend({ kind: z.literal('clock') }),
	clockProfileSchema.extend({
		kind: z.literal('token-response'),
		issuer: z.url(),
		accessToken: z.string().min(1),
	}),
]);
export type NativeOwnerCliProfile = z.infer<typeof nativeOwnerCliProfileSchema>;

export async function readNativeOwnerCliProfile(): Promise<NativeOwnerCliProfile | null> {
	const path = z.string().min(1).optional().parse(process.env.AUTH_PROOF_NATIVE_PROFILE_FILE);
	return path === undefined
		? null
		: nativeOwnerCliProfileSchema.parse(
				JSON.parse(await readFile(await requirePrivateRuntimePath(path, true), 'utf8')),
			);
}
