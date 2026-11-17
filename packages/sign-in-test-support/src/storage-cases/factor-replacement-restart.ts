import { passkey, session, signInAudit, twoFactor, user } from '@agent-collaboration/sign-in-core';
import { and, eq } from 'drizzle-orm';
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
	resetStorageCase,
} from '#sign-in-test-support/storage-cases/storage-case-utilities';
import { storageProviderProperties } from '#sign-in-test-support/storage-cases/storage-provider-fixture';
import { controlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-sign-in-clock';
import { passkeyConfirmationOptionsSchema } from '#sign-in-test-support/test-fixtures/passkey-browser-ceremonies';

export const replacementCredentialSchema = z.strictObject({
	credentialId: z.string().min(1),
	publicKey: z.string().min(1),
});
export const factorReplacementStateSchema = z.strictObject({
	personId: z.uuidv7(),
	organizationId: z.uuidv7(),
	passkeyId: z.uuidv7(),
	removalRequestId: z.uuidv7(),
});
export const replacementChallengeSchema = factorReplacementStateSchema.extend({
	// Only a synthetic fixture cookie crosses this private test protocol, in memory.
	// Neither commands nor this response are written to evidence logs.
	cookie: z.string().min(1),
	challenge: passkeyConfirmationOptionsSchema,
});
export type FactorReplacementState = z.infer<typeof factorReplacementStateSchema>;

async function factorRequest(props: {
	readonly context: StorageCaseContext;
	readonly organizationId: string;
	readonly cookie: string;
	readonly path: string;
	readonly body: unknown;
}): Promise<Response> {
	const issuer = storageProviderProperties(props.context, props.organizationId).configuration
		.issuer;
	const provider = createOrganizationProofProvider(props);
	return provider.handler(
		new Request(issuer + '/api/auth/' + props.path, {
			method: 'POST',
			headers: { cookie: props.cookie, origin: issuer, 'content-type': 'application/json' },
			body: JSON.stringify(props.body),
		}),
	);
}

/** Setup establishes an enrolled person and real public key outside the claim.
 * The claim begins with the conditional app removal, loses its outcome, closes
 * the database owner, and later verifies a real signature using the retained key. */
export async function prepareFactorReplacement(props: {
	readonly context: StorageCaseContext;
	readonly credential: z.infer<typeof replacementCredentialSchema>;
}): Promise<FactorReplacementState> {
	const { context } = props;
	await resetStorageCase(context);
	context.setTime(controlledSignInClock.now());
	const personId = await createStoragePerson(context, storageCaseOwnerEmail);
	const organizationId = await createStorageMembership(context, personId);
	const passkeyId = context.platform.ids.nextId();
	await context.openDatabase().insert(twoFactor).values({
		id: context.platform.ids.nextId(),
		userId: personId,
		secret: 'test-only-enrolled-app-precondition',
		backupCodes: 'test-only-enrolled-recovery-precondition',
		verified: true,
	});
	await context
		.openDatabase()
		.update(user)
		.set({ twoFactorEnabled: true })
		.where(eq(user.id, personId));
	await context
		.openDatabase()
		.insert(passkey)
		.values({
			id: passkeyId,
			userId: personId,
			publicKey: props.credential.publicKey,
			credentialID: props.credential.credentialId,
			counter: 0,
			deviceType: 'singleDevice',
			backedUp: false,
			createdAt: new Date(context.platform.clock.now()),
		});
	const cookie = await nativeProofCookie({
		context,
		personId,
		organizationId,
		confirmation: 'app',
	});
	context.setFault({
		operation: 'insert',
		table: 'sign_in_audit',
		key: personId,
		additionalKeys: [],
		phase: 'outcome',
		changeKind: 'app-removed',
	});
	try {
		const removed = await factorRequest({
			context,
			organizationId,
			cookie,
			path: 'two-factor/remove-app',
			body: {},
		});
		if (removed.status !== 503)
			throw new Error('Replacement fixture did not lose the removal outcome');
	} finally {
		context.setFault(null);
	}
	const records = await context
		.openDatabase()
		.select({ requestId: signInAudit.requestId, phase: signInAudit.phase })
		.from(signInAudit)
		.where(and(eq(signInAudit.actorUserId, personId), eq(signInAudit.changeKind, 'app-removed')));
	const intent = z
		.array(z.object({ requestId: z.uuidv7(), phase: z.literal('intent') }))
		.length(1)
		.parse(records)[0];
	if (intent === undefined) throw new Error('Replacement intent absent');
	return { personId, organizationId, passkeyId, removalRequestId: intent.requestId };
}

export async function challengeAfterFactorRestart(props: {
	readonly context: StorageCaseContext;
	readonly state: FactorReplacementState;
}): Promise<z.infer<typeof replacementChallengeSchema>> {
	// Commands reopen their deterministic ID source too. A distinct injected
	// instant keeps new fixture IDs distinct from the rows written before restart.
	props.context.setTime(controlledSignInClock.now() + 1000);
	const cookie = await nativeProofCookie({ context: props.context, ...props.state });
	const response = await factorRequest({
		context: props.context,
		...props.state,
		cookie,
		path: 'passkey/confirm-options',
		body: {},
	});
	if (!response.ok) throw new Error('Retained passkey did not offer confirmation after restart');
	return {
		...props.state,
		cookie,
		challenge: passkeyConfirmationOptionsSchema.parse(await response.json()),
	};
}

export async function confirmAfterFactorRestart(props: {
	readonly context: StorageCaseContext;
	readonly challenge: z.infer<typeof replacementChallengeSchema>;
	readonly assertion: unknown;
}): Promise<unknown> {
	props.context.setTime(controlledSignInClock.now() + 2000);
	const response = await factorRequest({
		context: props.context,
		...props.challenge,
		path: 'passkey/confirm',
		body: { challengeId: props.challenge.challenge.challengeId, response: props.assertion },
	});
	const database = props.context.openDatabase();
	const keys = await database
		.select({ id: passkey.id, counter: passkey.counter })
		.from(passkey)
		.where(eq(passkey.userId, props.challenge.personId));
	const apps = await database
		.select({ id: twoFactor.id })
		.from(twoFactor)
		.where(eq(twoFactor.userId, props.challenge.personId));
	const records = await database
		.select({ phase: signInAudit.phase })
		.from(signInAudit)
		.where(eq(signInAudit.requestId, props.challenge.removalRequestId));
	const stamped = await database
		.select({ method: session.secondFactorMethod, at: session.secondFactorAt })
		.from(session)
		.where(
			and(eq(session.userId, props.challenge.personId), eq(session.secondFactorMethod, 'passkey')),
		);
	return {
		status: response.status,
		remainingSamePasskey: keys.length === 1 && keys[0]?.id === props.challenge.passkeyId,
		verifiedCounterAdvanced: keys[0]?.counter === 1,
		appStillRemoved: apps.length === 0,
		removalStillUnconfirmed: records.length === 1 && records[0]?.phase === 'intent',
		confirmedWithRetainedKey:
			stamped.length === 1 && stamped[0]?.at === props.context.platform.clock.now(),
	};
}
