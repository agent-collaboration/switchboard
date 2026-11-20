import {
	organizationAuthorizationRevisions as organizationFence,
	personOrganizationAuthorizationRevisions as personFence,
	session,
} from '@agent-collaboration/sign-in-core';
import { expect } from 'vitest';

import type { startLocalAuthHarness } from '#sign-in-test-support/test-fixtures/local-auth-harness';
import {
	allSignInRowFingerprints,
	rowFingerprints,
} from '#sign-in-test-support/test-fixtures/stored-row-fingerprints';

type Harness = Awaited<ReturnType<typeof startLocalAuthHarness>>;
interface ExpiredSessionCleanupSnapshot {
	readonly fingerprints: Awaited<ReturnType<typeof allSignInRowFingerprints>>;
	readonly sessions: readonly (typeof session.$inferSelect)[];
	readonly personFences: readonly (typeof personFence.$inferSelect)[];
	readonly pushesBefore: number;
}

/** Start with settled, ACKed fences so the expiry's one native cleanup owns every later effect. */
export async function captureExpiredSessionCleanup(
	harness: Harness,
): Promise<ExpiredSessionCleanupSnapshot> {
	await harness.settleDeferredWork();
	harness.centralProvisioning.replyToPushesWith('acknowledge');
	const [sessions, personFences, organizationFences] = await Promise.all([
		harness.database.select().from(session),
		harness.database.select().from(personFence),
		harness.database.select().from(organizationFence),
	]);
	for (const row of [...personFences, ...organizationFences])
		expect(row.acknowledgedRevision).toBe(row.revision);
	return {
		fingerprints: await allSignInRowFingerprints(harness),
		sessions,
		personFences,
		pushesBefore: harness.centralProvisioning.pushes.length,
	};
}

/** Native session deletion bumps every retained pair; the existing queued drain records its ACK. */
export async function expectExpiredSessionCleanup(props: {
	readonly harness: Harness;
	readonly before: ExpiredSessionCleanupSnapshot;
	readonly response: Response;
	readonly sessionId: string;
	readonly personId: string;
	readonly now: number;
}): Promise<void> {
	const { harness, before, personId, now } = props;
	expect(before.sessions.filter((stored) => stored.id === props.sessionId)).toHaveLength(1);
	expect(before.personFences.some((row) => row.personId === personId)).toBe(true);
	expect(
		props.response.headers
			.getSetCookie()
			.some((cookie) => cookie.includes('session_token=') && /Max-Age=0/iu.test(cookie)),
	).toBe(true);
	await harness.settleDeferredWork();
	const expectedPersonFences = before.personFences.map((row) =>
		row.personId === personId
			? {
					...row,
					revision: row.revision + 1,
					nextAttemptAt: now,
					updatedAt: now,
					acknowledgedRevision: row.revision + 1,
					acknowledgedAt: now,
				}
			: row,
	);
	const expectedPushes = expectedPersonFences
		.filter((row) => row.personId === personId)
		.map((row) => ({
			kind: 'person',
			organizationId: row.organizationId,
			personId: row.personId,
			subjectId: row.id,
			revision: row.revision,
			state: row.state,
		}));
	expect(
		harness.centralProvisioning.pushes
			.slice(before.pushesBefore)
			.toSorted((left, right) => left.organizationId.localeCompare(right.organizationId)),
	).toEqual(
		expectedPushes.toSorted((left, right) =>
			left.organizationId.localeCompare(right.organizationId),
		),
	);
	expect(await allSignInRowFingerprints(harness)).toEqual({
		...before.fingerprints,
		session: rowFingerprints(before.sessions.filter((stored) => stored.id !== props.sessionId)),
		personOrganizationAuthorizationRevisions: rowFingerprints(expectedPersonFences),
	});
}
