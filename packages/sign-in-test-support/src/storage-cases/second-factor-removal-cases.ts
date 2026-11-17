import {
	passkey,
	session,
	twoFactor,
	user,
	type Uuid7,
	type PersonId,
} from '@agent-collaboration/sign-in-core';
import { eq } from 'drizzle-orm';

import type { StorageCaseContext } from '#sign-in-test-support/storage-cases/storage-case-context';
import type { StorageCaseDefinition } from '#sign-in-test-support/storage-cases/storage-case-registry';
import { createStoragePerson } from '#sign-in-test-support/storage-cases/storage-case-utilities';

/** Storage fixtures only: crypto strings are not passed to a verifier. Native
 * enrollment and WebAuthn verification have their own public-host cases. */
async function addApp(
	context: StorageCaseContext,
	personId: PersonId,
	verified: boolean,
): Promise<void> {
	await context.openDatabase().insert(twoFactor).values({
		id: context.platform.ids.nextId(),
		userId: personId,
		secret: 'test-only-encrypted-secret',
		backupCodes: 'test-only-encrypted-recovery-codes',
		verified,
	});
	await context
		.openDatabase()
		.update(user)
		.set({ twoFactorEnabled: verified, secondFactorSetAt: context.platform.clock.now() })
		.where(eq(user.id, personId));
}
async function addPasskey(context: StorageCaseContext, personId: PersonId): Promise<Uuid7> {
	const id = context.platform.ids.nextId();
	await context
		.openDatabase()
		.insert(passkey)
		.values({
			id,
			userId: personId,
			publicKey: 'test-only-public-key',
			credentialID: context.platform.ids.nextId(),
			counter: 0,
			deviceType: 'singleDevice',
			backedUp: false,
			createdAt: new Date(context.platform.clock.now()),
		});
	return id;
}
async function factorCounts(
	context: StorageCaseContext,
	personId: PersonId,
): Promise<{
	readonly apps: number;
	readonly verifiedApps: number;
	readonly passkeys: number;
	readonly enabled: boolean | null;
}> {
	const apps = await context
		.openDatabase()
		.select({ verified: twoFactor.verified })
		.from(twoFactor)
		.where(eq(twoFactor.userId, personId));
	const keys = await context
		.openDatabase()
		.select({ id: passkey.id })
		.from(passkey)
		.where(eq(passkey.userId, personId));
	const person = (
		await context
			.openDatabase()
			.select({ enabled: user.twoFactorEnabled })
			.from(user)
			.where(eq(user.id, personId))
	)[0];
	if (person === undefined) throw new Error('Factor fixture person absent');
	return {
		apps: apps.length,
		verifiedApps: apps.filter((row) => row.verified === true).length,
		passkeys: keys.length,
		enabled: person.enabled,
	};
}
async function concurrentLastFactorRemovals(context: StorageCaseContext): Promise<unknown> {
	const personId = await createStoragePerson(context);
	await addApp(context, personId, true);
	const passkeyId = await addPasskey(context, personId);
	const bothArrived = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let arrivals = 0;
	context.beforeAtomic(async () => {
		arrivals += 1;
		if (arrivals === 2) bothArrived.resolve();
		await release.promise;
	});
	const attempts = [
		context.store.factors.removeAuthenticatorApp(personId),
		context.store.factors.removePasskey({ personId, passkeyId }),
	];
	await bothArrived.promise;
	context.beforeAtomic(null);
	release.resolve();
	const results = await Promise.all(attempts);
	const kinds = results
		.map((result) => (result.kind === 'available' ? result.value.kind : result.kind))
		.toSorted();
	const remaining = await factorCounts(context, personId);
	return {
		arrivals,
		kinds,
		usableFactors: remaining.verifiedApps + remaining.passkeys,
		flagMatchesApp: remaining.enabled === remaining.verifiedApps > 0,
	};
}
async function unverifiedAppIsNotSpare(context: StorageCaseContext): Promise<unknown> {
	const personId = await createStoragePerson(context);
	await addApp(context, personId, false);
	const passkeyId = await addPasskey(context, personId);
	const result = await context.store.factors.removePasskey({ personId, passkeyId });
	return { result, remaining: await factorCounts(context, personId) };
}
async function appOnlyRemoval(context: StorageCaseContext): Promise<unknown> {
	const personId = await createStoragePerson(context);
	await addApp(context, personId, true);
	const before = await context.openDatabase().select().from(twoFactor);
	const result = await context.store.factors.removeAuthenticatorApp(personId);
	return {
		result,
		appAndCodesUnchanged:
			JSON.stringify(await context.openDatabase().select().from(twoFactor)) ===
			JSON.stringify(before),
		remaining: await factorCounts(context, personId),
	};
}
async function twoPasskeyRemoval(context: StorageCaseContext): Promise<unknown> {
	const personId = await createStoragePerson(context);
	const first = await addPasskey(context, personId);
	const last = await addPasskey(context, personId);
	const removed = await context.store.factors.removePasskey({ personId, passkeyId: first });
	const refused = await context.store.factors.removePasskey({ personId, passkeyId: last });
	return { removed, refused, remaining: await factorCounts(context, personId) };
}
async function sessionStampsStayExact(context: StorageCaseContext): Promise<unknown> {
	const personId = await createStoragePerson(context);
	const first = context.platform.ids.nextId();
	const second = context.platform.ids.nextId();
	const initial = context.platform.clock.now();
	await context
		.openDatabase()
		.insert(session)
		.values(
			[first, second].map((id) => ({
				id,
				userId: personId,
				token: id,
				createdAt: new Date(initial),
				updatedAt: new Date(initial),
				expiresAt: new Date(initial + 300_000),
			})),
		);
	const stamped = await context.store.factors.stampSession({
		personId,
		sessionId: first,
		method: 'app',
	});
	const untouched = await context.store.factors.readSession(personId, second);
	context.setTime(initial + 100);
	const secondStamp = await context.store.factors.stampSession({
		personId,
		sessionId: second,
		method: 'recoveryCode',
	});
	const firstState = await context.store.factors.readSession(personId, first);
	const secondState = await context.store.factors.readSession(personId, second);
	context.setTime(initial);
	return {
		firstStamped:
			stamped.kind === 'available' &&
			stamped.value.kind === 'stamped' &&
			stamped.value.at === initial,
		secondUnconfirmed:
			untouched.kind === 'available' && untouched.value?.confirmation.kind === 'unconfirmed',
		secondStamped:
			secondStamp.kind === 'available' &&
			secondStamp.value.kind === 'stamped' &&
			secondStamp.value.at === initial + 100,
		firstTimeUnchanged:
			firstState.kind === 'available' &&
			firstState.value?.confirmation.kind === 'confirmed' &&
			firstState.value.confirmation.at === initial,
		firstEnrollmentUnchanged:
			secondState.kind === 'available' &&
			secondState.value?.enrollment.kind === 'enrolled' &&
			secondState.value.enrollment.setAt === initial,
	};
}
export const secondFactorRemovalCases: readonly StorageCaseDefinition[] = [
	{
		name: 'people: concurrent app and last-passkey removals leave exactly one usable factor',
		expected: {
			arrivals: 2,
			kinds: ['not-removed', 'removed'],
			usableFactors: 1,
			flagMatchesApp: true,
		},
		run: concurrentLastFactorRemovals,
	},
	{
		name: 'people: an unverified app never permits deleting the last passkey',
		expected: {
			result: { kind: 'available', value: { kind: 'not-removed' } },
			remaining: { apps: 1, verifiedApps: 0, passkeys: 1, enabled: false },
		},
		run: unverifiedAppIsNotSpare,
	},
	{
		name: 'people: removing the only app preserves its secret and recovery codes',
		expected: {
			result: { kind: 'available', value: { kind: 'not-removed' } },
			appAndCodesUnchanged: true,
			remaining: { apps: 1, verifiedApps: 1, passkeys: 0, enabled: true },
		},
		run: appOnlyRemoval,
	},
	{
		name: 'people: one of two passkeys can be removed but the final key cannot',
		expected: {
			removed: { kind: 'available', value: { kind: 'removed' } },
			refused: { kind: 'available', value: { kind: 'not-removed' } },
			remaining: { apps: 0, verifiedApps: 0, passkeys: 1, enabled: false },
		},
		run: twoPasskeyRemoval,
	},
	{
		name: 'people: confirmation stamps the exact live session and keeps first enrollment time',
		expected: {
			firstStamped: true,
			secondUnconfirmed: true,
			secondStamped: true,
			firstTimeUnchanged: true,
			firstEnrollmentUnchanged: true,
		},
		run: sessionStampsStayExact,
	},
];
