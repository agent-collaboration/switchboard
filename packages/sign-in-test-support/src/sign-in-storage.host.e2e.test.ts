import * as hegel from '@hegeldev/hegel';
import * as generators from '@hegeldev/hegel/generators';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
	createStorageTestHost,
	type StorageTestHost,
} from '#sign-in-test-support/storage-cases/dual-storage-test-host';
import {
	factorReplacementStateSchema,
	replacementChallengeSchema,
} from '#sign-in-test-support/storage-cases/factor-replacement-restart';
import {
	modelRecordHistory,
	type RecordHistoryStep,
} from '#sign-in-test-support/storage-cases/organization-record-history';
import { stampRestartStateSchema } from '#sign-in-test-support/storage-cases/organization-stamp-restart';
import { storageCaseDefinitions } from '#sign-in-test-support/storage-cases/storage-case-registry';
import { restartStateSchema } from '#sign-in-test-support/storage-cases/storage-commands';
import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import { createSoftwarePasskeyAuthenticator } from '#sign-in-test-support/test-fixtures/software-passkey-authenticator';

useControlledSignInClock();
describe.each(['d1-workerd', 'better-sqlite3'] as const)('sign-in storage on %s', (leg) => {
	let host: StorageTestHost;
	beforeAll(async () => {
		host = await createStorageTestHost(leg);
	});
	afterAll(async () => {
		await host?.close();
	});
	for (const definition of storageCaseDefinitions) {
		it(definition.name, async () => {
			expect(await host.runCase(definition.name)).toEqual(definition.expected);
		});
	}
	for (const phase of ['intent', 'outcome'] as const) {
		it(`people: preserves exact ${phase} records across a real storage restart without settlement`, async () => {
			// Arrange: the fixture writes through the production record store, then closes the real database owner.
			const state = restartStateSchema.parse(
				await host.runCommand({ kind: 'prepare-restart', phase }),
			);
			expect(state.rows).toHaveLength(phase === 'intent' ? 1 : 2);
			// Act
			await host.restart();
			// Assert: IDs, timestamps, actor, target and organization are preserved, not just the row count.
			expect(await host.runCommand({ kind: 'read-restart', state })).toEqual({
				rows: state.rows,
				personRows: { users: 1, accounts: 1 },
			});
		});
	}
	it('organization stamp: a stamp in doubt keeps its exact bytes and counters across a real storage restart, and the next use re-sends exactly those bytes', async () => {
		// Arrange: the production guard leaves one stamp in doubt, then the database owner closes.
		const state = stampRestartStateSchema.parse(
			await host.runCommand({ kind: 'prepare-stamp-restart' }),
		);
		// Act
		await host.restart();
		const after = await host.runCommand({ kind: 'read-stamp-restart', state });
		// Assert: only the reopened database carries the sent statement into the next use.
		expect(after).toEqual({
			reopened: {
				sent: 'the bytes sent before restart',
				digest: 'the held stamp',
				unanswered: 1,
				refused: 0,
				lastTryOutcome: 'unanswered-timeout',
			},
			readiness: 'ready',
			renewal: 'renewed',
			resent: ['the bytes sent before restart'],
			confirmed: {
				sent: null,
				digest: 'the re-sent stamp',
				unanswered: 1,
				refused: 0,
				lastTryOutcome: 'unanswered-timeout',
			},
		});
	});
	it('people: interrupted app replacement retains a working passkey across a real storage restart without settling its lost outcome', async () => {
		// Arrange: private key stays with the external authenticator while storage closes.
		const authenticator = await createSoftwarePasskeyAuthenticator();
		const state = factorReplacementStateSchema.parse(
			await host.runCommand({
				kind: 'prepare-factor-replacement',
				credential: {
					credentialId: authenticator.credentialId,
					publicKey: authenticator.storedPublicKey,
				},
			}),
		);
		// Act
		await host.restart();
		const challenge = replacementChallengeSchema.parse(
			await host.runCommand({ kind: 'factor-replacement-challenge', state }),
		);
		const assertion = authenticator.authenticationResponse({
			challenge: challenge.challenge.options.challenge,
			rpId: challenge.challenge.options.rpId,
			origin: 'https://storage-sign-in.invalid',
		});
		// Assert: a real UV signature verifies, rather than merely counting retained rows.
		expect(
			await host.runCommand({ kind: 'confirm-factor-replacement', challenge, assertion }),
		).toEqual({
			status: 200,
			remainingSamePasskey: true,
			verifiedCounterAdvanced: true,
			appStillRemoved: true,
			removalStillUnconfirmed: true,
			confirmedWithRetainedKey: true,
		});
	});
	it('an unmigrated database returns migration-incomplete rather than serving an absent row', async () => {
		const cold = await createStorageTestHost(leg, 'unmigrated');
		try {
			expect(await cold.runCommand({ kind: 'unmigrated-read' })).toEqual({
				kind: 'store-unavailable',
				reason: 'migration-incomplete',
			});
		} finally {
			await cold.close();
		}
	});
	if (leg === 'better-sqlite3')
		it('a real closed SQLite file returns database-error instead of throwing or serving an absent row', async () => {
			const closed = await createStorageTestHost(leg);
			await closed.close();
			expect(await closed.runCommand({ kind: 'unmigrated-read' })).toEqual({
				kind: 'store-unavailable',
				reason: 'database-error',
			});
		});
	it('people: Hegel record histories keep unknown effects unconfirmed until an actual outcome write', async () => {
		await hegel.testAsync(
			async (testCase) => {
				const choices = ['intent', 'effect', 'outcome', 'unknown', 'read'] as const;
				const count = testCase.draw(generators.integers({ minValue: 0, maxValue: 20 }));
				const rest = Array.from({ length: count }, () => {
					const step =
						choices[
							testCase.draw(generators.integers({ minValue: 0, maxValue: choices.length - 1 }))
						];
					if (step === undefined) throw new Error('Generated record step is invalid');
					return step;
				});
				const steps: readonly RecordHistoryStep[] = [
					'intent',
					'effect',
					'unknown',
					'read',
					...rest,
				];
				expect(await host.runCommand({ kind: 'record-history', steps: [...steps] })).toEqual(
					modelRecordHistory(steps),
				);
			},
			{ testCases: 100, derandomize: true, database: hegel.Database.disabled },
		);
	});
});
