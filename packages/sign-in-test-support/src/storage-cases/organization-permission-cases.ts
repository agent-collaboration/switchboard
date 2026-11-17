import { member, session, type SignInStore } from '@agent-collaboration/sign-in-core';
import {
	organizationPersonTokenClaimsSchema,
	personSessionConfirmationSchema,
} from '@agent-collaboration/sign-in-core/person-identity';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import {
	createOrganizationProofProvider,
	nativeProofCookie,
} from '#sign-in-test-support/storage-cases/organization-provider-proof';
import {
	storageCaseOwnerEmail,
	type StorageCaseContext,
} from '#sign-in-test-support/storage-cases/storage-case-context';
import {
	createStorageMembership,
	createStoragePerson,
} from '#sign-in-test-support/storage-cases/storage-case-utilities';
import { storageProviderProperties } from '#sign-in-test-support/storage-cases/storage-provider-fixture';
import { controlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-sign-in-clock';

/** Real native endpoint context + live database + native permission helper.
 * Signature verification is the producer caller's precondition, outside this
 * storage/provider case; signed K6 issuance is covered by the public host cases. */
export async function organizationPermissionConfirmations(
	context: StorageCaseContext,
): Promise<unknown> {
	const previousTime = context.platform.clock.now();
	context.setTime(controlledSignInClock.now());
	try {
		const personId = await createStoragePerson(context, storageCaseOwnerEmail);
		const organizationId = await createStorageMembership(context, personId);
		await nativeProofCookie({ context, personId, organizationId });
		const current = z
			.object({ id: z.uuidv7() })
			.parse(
				(
					await context
						.openDatabase()
						.select({ id: session.id })
						.from(session)
						.where(eq(session.userId, personId))
				)[0],
			);
		const properties = storageProviderProperties(context, organizationId);
		const initialTime = context.platform.clock.now();
		const claims = organizationPersonTokenClaimsSchema.parse({
			iss: properties.configuration.issuer,
			sub: personId,
			sid: current.id,
			aud: properties.configuration.managementAudience,
			iat: Math.floor(initialTime / 1000),
			exp: Math.floor(initialTime / 1000) + 300,
			client_id: properties.configuration.ownerCliClientId,
			azp: properties.configuration.ownerCliClientId,
			scope: 'tool-portal:management',
			jti: 'native-confirmation-fixture',
			organization_id: organizationId,
		});
		let sessionReads = 0;
		const store: SignInStore = {
			...context.store,
			persons: {
				...context.store.persons,
				async readPersonSession(requestPersonId, sessionId) {
					sessionReads += 1;
					const result = await context.store.persons.readPersonSession(requestPersonId, sessionId);
					// Existing injected store-method seam; the DB read stays real. Later awaited
					// work must not move the K5 timestamp to the end of the operation.
					context.setTime(context.platform.clock.now() + 60_000);
					return result;
				},
			},
		};
		const provider = createOrganizationProofProvider({ context, organizationId, store });
		const permissions = personSessionConfirmationSchema.options[1].shape.permission.options;
		const samplePermission = permissions[0];
		if (samplePermission === undefined) throw new Error('Permission contract is empty');
		async function confirm(
			permission: (typeof permissions)[number],
			requestOrganizationId: string = organizationId,
		): Promise<unknown> {
			const response = await provider.handler(
				new Request(properties.configuration.issuer + '/api/auth/__storage-proof/confirmation', {
					method: 'POST',
					headers: { 'content-type': 'application/json', origin: properties.configuration.issuer },
					body: JSON.stringify({ claims, permission, organizationId: requestOrganizationId }),
				}),
			);
			if (!response.ok) throw new Error('Native confirmation probe refused');
			return response.json();
		}
		let exactOwnerAnswers = true;
		await permissions.reduce<Promise<void>>(async (previous, permission) => {
			await previous;
			context.setTime(initialTime);
			const answer = personSessionConfirmationSchema.parse(await confirm(permission));
			exactOwnerAnswers &&=
				answer.active &&
				answer.permission === permission &&
				answer.organization_id === organizationId &&
				answer.sub === personId &&
				answer.sid === current.id &&
				answer.checkedAt === initialTime;
		}, Promise.resolve());
		const beforeWrongOrganization = sessionReads;
		const wrongOrganization = await confirm(samplePermission, context.platform.ids.nextId());
		const mismatchReadsNoSession = sessionReads === beforeWrongOrganization;
		await context
			.openDatabase()
			.update(member)
			.set({ role: 'member' })
			.where(eq(member.userId, personId));
		let allMemberAnswersInactive = true;
		await permissions.reduce<Promise<void>>(async (previous, permission) => {
			await previous;
			context.setTime(initialTime);
			const answer = await confirm(permission);
			allMemberAnswersInactive &&= JSON.stringify(answer) === JSON.stringify({ active: false });
		}, Promise.resolve());
		await context
			.openDatabase()
			.update(member)
			.set({ role: 'owner' })
			.where(eq(member.userId, personId));
		context.setTime(initialTime);
		const ownerAgain = personSessionConfirmationSchema.parse(await confirm(samplePermission));
		await context.openDatabase().delete(member).where(eq(member.userId, personId));
		context.setTime(initialTime);
		const removed = await confirm(samplePermission);
		await context.openDatabase().delete(session).where(eq(session.id, current.id));
		context.setTime(initialTime);
		const revoked = await confirm(samplePermission);
		return {
			permissionCount: permissions.length,
			exactOwnerAnswers,
			allMemberAnswersInactive,
			wrongOrganization,
			mismatchReadsNoSession,
			ownerAgain: ownerAgain.active,
			removed,
			revoked,
		};
	} finally {
		context.setTime(previousTime);
	}
}
