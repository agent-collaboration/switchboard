import { signInSchema, type AtomicRunner } from '@agent-collaboration/sign-in-core';
import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1';

/** Opens a fresh primary read view. Host code must never use db.$client.exec,
 * db.$client.dump or db.$client.withSession to reach the root binding through it. */
export function openSignInDatabase(
	binding: AuthWorkerEnv['DB'],
): DrizzleD1Database<typeof signInSchema> {
	const session = binding.withSession('first-primary');
	// Drizzle 0.45.2 declares a full D1Database although its query and batch paths
	// use only prepare/batch. Remove this view when the pinned driver accepts sessions.
	const primaryView = {
		prepare: session.prepare.bind(session),
		batch: session.batch.bind(session),
		exec: binding.exec.bind(binding),
		dump: binding.dump.bind(binding),
		withSession: binding.withSession.bind(binding),
	} satisfies AuthWorkerEnv['DB'];
	return drizzle(primaryView, { schema: signInSchema });
}

export function createD1AtomicRunner(binding: AuthWorkerEnv['DB']): AtomicRunner {
	return async (group) => {
		try {
			const rows = await openSignInDatabase(binding).batch(group);
			return { kind: 'committed', rows };
		} catch {
			return { kind: 'failed', reason: 'database-error' };
		}
	};
}
