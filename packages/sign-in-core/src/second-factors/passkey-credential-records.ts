import { z } from 'zod';

import {
	uuid7Schema,
	type EpochMilliseconds,
	type Uuid7,
} from '#sign-in-core/contracts/sign-in-platform';
import type { SignInStoreResult } from '#sign-in-core/storage/models/sign-in-database';
import { personIdSchema, type PersonId } from '#sign-in-core/storage/models/sign-in-store';

export const storedPasskeyCredentialSchema = z.strictObject({
	id: uuid7Schema,
	personId: personIdSchema,
	credentialId: z.string().min(1),
	publicKey: z.base64(),
	counter: z.number().int().nonnegative(),
});
export type StoredPasskeyCredential = z.infer<typeof storedPasskeyCredentialSchema>;
export interface PasskeyCredentialRecords {
	readonly listForPerson: (
		personId: PersonId,
	) => Promise<SignInStoreResult<readonly StoredPasskeyCredential[]>>;
	readonly readForPerson: (
		personId: PersonId,
		credentialId: string,
	) => Promise<SignInStoreResult<StoredPasskeyCredential | null>>;
	readonly confirmSession: (request: {
		readonly personId: PersonId;
		readonly sessionId: Uuid7;
		readonly passkeyId: Uuid7;
		readonly verifiedCounter: number;
	}) => Promise<
		SignInStoreResult<
			| { readonly kind: 'confirmed'; readonly at: EpochMilliseconds }
			| { readonly kind: 'credential-or-session-not-live' }
		>
	>;
}
