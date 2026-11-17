import * as fs from 'node:fs/promises';

import { afterEach, expect, it, vi } from 'vitest';

import { deviceSignInUnavailable } from '#sign-in-owner-cli/fleet/fleet-cli-commands';
import * as keyStores from '#sign-in-owner-cli/fleet/proof-key-store';
import { runOwnerCli } from '#sign-in-owner-cli/owner-cli';

vi.mock('node:fs/promises', { spy: true });
vi.mock('#sign-in-owner-cli/fleet/proof-key-store', { spy: true });
afterEach(() => vi.restoreAllMocks());

it.each(['fleet-login', 'fleet-create-workspace', 'login'])(
	'--device with %s exits non-zero with the named message before any network, Keychain or file call',
	async (command): Promise<void> => {
		// Arrange: an otherwise complete invocation.
		const fetchSpy = vi.spyOn(globalThis, 'fetch');
		const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
		// Act
		const exitCode = await runOwnerCli([
			'--target',
			'/private/runtime/target.json',
			'--device',
			command,
			'--operation-id',
			'019a3dce-2000-7000-8000-000000000004',
			'--name',
			'research',
		]);
		// Assert
		expect(exitCode).toBe(1);
		expect(stderr).toHaveBeenCalledWith(`${deviceSignInUnavailable}\n`);
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(vi.mocked(keyStores.selectProofKeyStore)).not.toHaveBeenCalled();
		expect(vi.mocked(keyStores.createMacosKeychainProofKeyStore)).not.toHaveBeenCalled();
		expect(vi.mocked(fs.readFile)).not.toHaveBeenCalled();
		expect(vi.mocked(fs.lstat)).not.toHaveBeenCalled();
	},
);
