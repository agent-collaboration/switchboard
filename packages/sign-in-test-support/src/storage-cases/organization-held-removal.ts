import { member, signInAudit } from '@agent-collaboration/sign-in-core';
import { eq } from 'drizzle-orm';

import {
	createOrganizationProofProvider,
	nativeProofCookie,
} from '#sign-in-test-support/storage-cases/organization-provider-proof';
import type { StorageCaseContext } from '#sign-in-test-support/storage-cases/storage-case-context';
import { storageCaseOwnerEmail } from '#sign-in-test-support/storage-cases/storage-case-context';
import {
	createStoragePerson,
	createStorageMembership,
} from '#sign-in-test-support/storage-cases/storage-case-utilities';
import { storageProviderProperties } from '#sign-in-test-support/storage-cases/storage-provider-fixture';
import { controlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-sign-in-clock';

/** Lead-approved fixture-only TWO-owner state. Product routes create one owner.
 * This holds the documented native hook, never the adapter's internal delete. */
export async function heldOwnerRemoval(context: StorageCaseContext): Promise<unknown> {
	const previousTime = context.platform.clock.now();
	context.setTime(controlledSignInClock.now());
	try {
		const actorId = await createStoragePerson(context, storageCaseOwnerEmail);
		const organizationId = await createStorageMembership(context, actorId);
		const targetId = await createStoragePerson(context, 'second-owner@example.invalid');
		const targetMembershipId = context.platform.ids.nextId();
		await context
			.openDatabase()
			.insert(member)
			.values({
				id: targetMembershipId,
				organizationId,
				userId: targetId,
				role: 'owner',
				createdAt: new Date(context.platform.clock.now()),
			});
		const cookie = await nativeProofCookie({
			context,
			personId: actorId,
			organizationId,
			confirmation: 'app',
		});
		const before = await context.openDatabase().select().from(member).orderBy(member.id);
		const bothArrived = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const payloads: { readonly userId: string; readonly role: string }[] = [];
		const issuer = storageProviderProperties(context, organizationId).configuration.issuer;
		const requests = [0, 1].map(() => {
			// The production factory is request-scoped; each concurrent request gets its
			// own actor/record state, while the fixture barrier alone is shared.
			const provider = createOrganizationProofProvider({
				context,
				organizationId,
				wrapBeforeRemove: (productionHook) => async (data) => {
					payloads.push({ userId: data.member.userId, role: data.member.role });
					if (payloads.length === 2) bothArrived.resolve();
					await release.promise;
					return productionHook(data);
				},
			});
			return provider.handler(
				new Request(issuer + '/api/auth/organization/remove-member', {
					method: 'POST',
					headers: { cookie, origin: issuer, 'content-type': 'application/json' },
					body: JSON.stringify({ organizationId, memberIdOrEmail: targetMembershipId }),
				}),
			);
		});
		// If a request refuses before reaching the intended hook, surface the wrong
		// seam as a failure instead of hanging for the test timeout.
		const reached = await Promise.race([
			bothArrived.promise.then(() => true),
			Promise.race(requests).then(() => false),
		]);
		release.resolve();
		const responses = await Promise.all(requests);
		const after = await context.openDatabase().select().from(member).orderBy(member.id);
		return {
			reachedBothHooks: reached,
			nativeOwnerPayloads:
				payloads.length === 2 &&
				payloads.every((payload) => payload.userId === targetId && payload.role === 'owner'),
			statuses: responses.map((response) => response.status),
			bothOwnersUnchanged: JSON.stringify(after) === JSON.stringify(before),
			ownerCount: after.filter((row) => row.role === 'owner').length,
			removalRecords: (
				await context
					.openDatabase()
					.select()
					.from(signInAudit)
					.where(eq(signInAudit.changeKind, 'member-removed'))
			).length,
		};
	} finally {
		context.setTime(previousTime);
	}
}
