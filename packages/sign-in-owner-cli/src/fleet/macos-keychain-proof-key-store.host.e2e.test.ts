import {
	epochMillisecondsSchema,
	fleetAdminProofKeyThumbprint,
} from '@agent-collaboration/sign-in-core';
import { createWebSignInCapabilities } from '@agent-collaboration/sign-in-platform-web';
import { expect, it } from 'vitest';

import {
	createMacosKeychainProofKeyStore,
	nodeSecurityCommandRunner,
} from '#sign-in-owner-cli/fleet/proof-key-store';

// One bounded test against the real `/usr/bin/security` and the user's default Keychain
// It touches only its own uniquely named item and removes it.

/** A fixed time: the builder's default clock reads the real time, which tests never do (R33). */
const keychainTestClock = { now: () => epochMillisecondsSchema.parse(1_763_164_800_000) };
// The service name's UUIDv7 keeps its random part, so each run's item is still its own.
const keychainTestCapabilities = createWebSignInCapabilities(keychainTestClock);
it.skipIf(process.platform !== 'darwin')(
	'the real Keychain stores, overwrites, re-saves a loaded key with its rotated credential, and deletes exactly its own namespaced item',
	async (): Promise<void> => {
		// Arrange
		const service = `dev.switchboard.fleet-cli.test.${keychainTestCapabilities.ids.nextId()}`;
		const store = createMacosKeychainProofKeyStore({
			runner: nodeSecurityCommandRunner,
			crypto: keychainTestCapabilities.crypto,
			issuer: 'https://sign-in.example.invalid',
			clientId: 'owner-fleet-cli-test',
			service,
		});
		const other = createMacosKeychainProofKeyStore({
			runner: nodeSecurityCommandRunner,
			crypto: keychainTestCapabilities.crypto,
			issuer: 'https://other.example.invalid',
			clientId: 'owner-fleet-cli-test',
			service,
		});
		try {
			const first = await store.createKey();
			const second = await store.createKey();
			// Act
			await store.save({ key: first, refreshToken: 'first-refresh' });
			const afterFirst = await store.load();
			await store.save({ key: second, refreshToken: 'second-refresh' });
			const afterOverwrite = await store.load();
			// A refresh saves the key it loaded with the rotated credential.
			if (afterOverwrite === null) throw new Error('Nothing loaded');
			await store.save({ key: afterOverwrite.key, refreshToken: 'rotated-refresh' });
			const afterRotation = await store.load();
			const fromOtherIssuer = await other.load();
			await store.remove();
			// Assert
			expect(afterFirst?.refreshToken).toBe('first-refresh');
			expect(
				afterFirst === null
					? null
					: await fleetAdminProofKeyThumbprint(keychainTestCapabilities.crypto, afterFirst.key),
			).toBe(await fleetAdminProofKeyThumbprint(keychainTestCapabilities.crypto, first));
			expect(afterOverwrite?.refreshToken).toBe('second-refresh');
			expect(
				afterOverwrite === null
					? null
					: await fleetAdminProofKeyThumbprint(keychainTestCapabilities.crypto, afterOverwrite.key),
			).toBe(await fleetAdminProofKeyThumbprint(keychainTestCapabilities.crypto, second));
			expect(afterRotation?.refreshToken).toBe('rotated-refresh');
			expect(
				afterRotation === null
					? null
					: await fleetAdminProofKeyThumbprint(keychainTestCapabilities.crypto, afterRotation.key),
			).toBe(await fleetAdminProofKeyThumbprint(keychainTestCapabilities.crypto, second));
			expect(fromOtherIssuer).toBeNull();
			expect(await store.load()).toBeNull();
		} finally {
			await store.remove();
			await other.remove();
		}
	},
);
