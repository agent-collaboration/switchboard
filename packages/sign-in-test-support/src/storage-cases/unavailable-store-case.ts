import { createSignInStore, type SignInDatabase } from '@agent-collaboration/sign-in-core';

import {
	storageCaseOwnerEmail,
	type StorageCaseContext,
} from '#sign-in-test-support/storage-cases/storage-case-context';

/** Controlled unavailable capability, on both runtimes. The separate closed-file
 * case proves the actual SQLite driver exception rather than substituting for it. */
export async function unavailableFactoryIsClosedResult(
	context: StorageCaseContext,
): Promise<unknown> {
	const store = createSignInStore({
		openDatabase: (): SignInDatabase => {
			throw new Error('Controlled unavailable database factory');
		},
		platform: context.platform,
		ownerEmail: storageCaseOwnerEmail,
	});
	return {
		resource: await store.resources.read('https://storage-portal.invalid/missing'),
		owner: await store.persons.readOwnerSession(
			context.platform.ids.nextId(),
			context.platform.ids.nextId(),
		),
	};
}
