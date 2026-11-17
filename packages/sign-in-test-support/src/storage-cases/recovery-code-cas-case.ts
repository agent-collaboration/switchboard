import { session } from '@agent-collaboration/sign-in-core';
import { createSignInProvider } from '@agent-collaboration/sign-in-core/better-auth';
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
import { readCurrentBrowserSession } from '#sign-in-test-support/test-fixtures/current-browser-session';
import { createSoftwareTotpAuthenticator } from '#sign-in-test-support/test-fixtures/software-totp-authenticator';

/** Holds Better Auth's adapter CAS boundary, not an interleaving inside SQL.
 * Native authentication, validation, adapter updates and both database engines
 * remain real. Only the two matching adapter calls wait on the fixture event. */
export async function recoveryCodeCompareAndSwap(context: StorageCaseContext): Promise<unknown> {
	const previousTime = context.platform.clock.now();
	context.setTime(controlledSignInClock.now());
	try {
		const personId = await createStoragePerson(context, storageCaseOwnerEmail);
		const organizationId = await createStorageMembership(context, personId);
		const properties = storageProviderProperties(context, organizationId);
		let setupCookie = await nativeProofCookie({ context, personId, organizationId });
		const authenticator = createSoftwareTotpAuthenticator(context.platform.clock);
		const setupRequest = async (pathname: string, init: RequestInit = {}): Promise<Response> => {
			const headers = new Headers(init.headers);
			headers.set('cookie', setupCookie);
			headers.set('origin', properties.configuration.issuer);
			const provider = createOrganizationProofProvider({ context, organizationId });
			const response = await provider.handler(
				new Request(properties.configuration.issuer + pathname, { ...init, headers }),
			);
			const returnedCookies = response.headers.getSetCookie();
			if (returnedCookies.length > 0)
				setupCookie = returnedCookies.map((value) => value.split(';')[0]).join('; ');
			return response;
		};
		await authenticator.ensureConfirmed(storageCaseOwnerEmail, setupRequest);
		const code = authenticator.recoveryCode(storageCaseOwnerEmail);
		const nativeReader = createSignInProvider({ ...properties, authority: { kind: 'public' } });
		const readCodes = async (): Promise<readonly string[]> => {
			const result = await nativeReader.api.viewBackupCodes({ body: { userId: personId } });
			return z.object({ backupCodes: z.array(z.string()) }).parse(result).backupCodes;
		};
		const beforeCodes = await readCodes();
		const cookies = await Promise.all(
			[0, 1].map(() => nativeProofCookie({ context, personId, organizationId })),
		);
		const beforeSessions = await Promise.all(
			cookies.map((cookie) =>
				readCurrentBrowserSession({ cookie, database: context.openDatabase() }),
			),
		);
		const at = context.platform.clock.now() + 1000;
		context.setTime(at);
		const bothArrived = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let arrivalCount = 0;
		const requests = cookies.map(async (cookie): Promise<Response> => {
			const provider = createOrganizationProofProvider({ context, organizationId });
			const nativeContext = await provider.$context;
			const original = nativeContext.adapter.incrementOne.bind(nativeContext.adapter);
			nativeContext.adapter.incrementOne = async <TRecord>(
				input: Parameters<typeof original>[0],
			): Promise<TRecord | null> => {
				if (input.model === 'twoFactor' && typeof input.set?.backupCodes === 'string') {
					arrivalCount += 1;
					if (arrivalCount === 2) bothArrived.resolve();
					await release.promise;
				}
				return original<TRecord>(input);
			};
			return provider.handler(
				new Request(properties.configuration.issuer + '/api/auth/two-factor/verify-backup-code', {
					method: 'POST',
					headers: {
						cookie,
						origin: properties.configuration.issuer,
						'content-type': 'application/json',
					},
					body: JSON.stringify({ code }),
				}),
			);
		});
		const reachedBoth = await Promise.race([
			bothArrived.promise.then(() => true),
			Promise.race(requests).then(() => false),
		]);
		release.resolve();
		const responses = await Promise.all(requests);
		const afterCodes = await readCodes();
		const outcomes = await Promise.all(
			responses.map(async (response, index) => {
				const before = beforeSessions[index];
				if (before === undefined) throw new Error('Concurrent recovery fixture has no session');
				const stored = z
					.array(
						z.object({
							secondFactorAt: z.number().nullable(),
							secondFactorMethod: z.string().nullable(),
						}),
					)
					.length(1)
					.parse(
						await context
							.openDatabase()
							.select({
								secondFactorAt: session.secondFactorAt,
								secondFactorMethod: session.secondFactorMethod,
							})
							.from(session)
							.where(eq(session.id, before.id)),
					)[0];
				if (stored === undefined) throw new Error('Concurrent recovery session disappeared');
				const body: unknown = await response.json();
				return {
					status: response.status,
					nativeConflict:
						response.status === 409 &&
						z
							.object({
								message: z.literal('Failed to verify backup code. Please try again.'),
							})
							.safeParse(body).success,
					stampCorrect:
						response.status === 200
							? stored.secondFactorAt === at && stored.secondFactorMethod === 'recoveryCode'
							: stored.secondFactorAt === before.secondFactorAt &&
								stored.secondFactorMethod === before.secondFactorMethod,
				};
			}),
		);
		return {
			reachedBoth,
			arrivalCount,
			successes: outcomes.filter((outcome) => outcome.status === 200).length,
			nativeConflicts: outcomes.filter((outcome) => outcome.nativeConflict).length,
			onlyWinnerStamped: outcomes.every((outcome) => outcome.stampCorrect),
			distinctSessionsInitiallyUnconfirmed:
				beforeSessions.length === 2 &&
				new Set(beforeSessions.map((stored) => stored.id)).size === 2 &&
				beforeSessions.every(
					(stored) => stored.secondFactorAt === null && stored.secondFactorMethod === null,
				),
			usedCodeInitiallyPresentOnce: beforeCodes.filter((stored) => stored === code).length === 1,
			exactlyUsedCodeRemoved:
				JSON.stringify(afterCodes) ===
				JSON.stringify(beforeCodes.filter((stored) => stored !== code)),
		};
	} finally {
		context.setTime(previousTime);
	}
}
