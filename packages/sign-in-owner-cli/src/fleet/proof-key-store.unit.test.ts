import * as fs from 'node:fs/promises';

import { fleetAdminProofKeyThumbprint } from '@agent-collaboration/sign-in-core';
import { afterEach, expect, it, vi } from 'vitest';

import {
	createMacosKeychainProofKeyStore,
	selectProofKeyStore,
	type SecurityCommandRunner,
} from '#sign-in-owner-cli/fleet/proof-key-store';

vi.mock('node:fs/promises', { spy: true });
afterEach(() => vi.clearAllMocks());

/**
 * A stand-in for `/usr/bin/security` over one in-memory keychain. It reads `-i` commands from
 * stdin with the real tool's double-quote words; the real tool's framing is proven by the
 * bounded macOS integration test, not here.
 */
function fakeSecurity(): {
	readonly runner: SecurityCommandRunner;
	readonly calls: { readonly args: readonly string[]; readonly stdin: string }[];
	readonly items: Map<string, string>;
} {
	const items = new Map<string, string>();
	const calls: { readonly args: readonly string[]; readonly stdin: string }[] = [];
	const runner: SecurityCommandRunner = async ({ args, stdin }) => {
		calls.push({ args, stdin: stdin ?? '' });
		const option = (list: readonly string[], flag: string): string =>
			list[list.indexOf(flag) + 1] ?? '';
		if (args[0] === '-i') {
			const words = [...(stdin ?? '').matchAll(/"([^"]*)"|(\S+)/gu)].map(
				(match) => match[1] ?? match[2] ?? '',
			);
			if (words[0] !== 'add-generic-password') return { exitCode: 1, stdout: '' };
			items.set(`${option(words, '-s')}\n${option(words, '-a')}`, option(words, '-w'));
			return { exitCode: 0, stdout: '' };
		}
		const key = `${option(args, '-s')}\n${option(args, '-a')}`;
		if (args[0] === 'find-generic-password') {
			const value = items.get(key);
			return value === undefined
				? { exitCode: 44, stdout: '' }
				: { exitCode: 0, stdout: `${value}\n` };
		}
		if (args[0] === 'delete-generic-password')
			return { exitCode: items.delete(key) ? 0 : 44, stdout: '' };
		return { exitCode: 1, stdout: '' };
	};
	return { runner, calls, items };
}

it('round-trips the key and refresh credential exactly, with the secret only on stdin', async (): Promise<void> => {
	// Arrange
	const security = fakeSecurity();
	const store = createMacosKeychainProofKeyStore({
		runner: security.runner,
		crypto: globalThis.crypto,
		issuer: 'https://sign-in.example.invalid',
		clientId: 'owner-fleet-cli',
	});
	const key = await store.createKey();
	// Act
	await store.save({ key, refreshToken: 'refresh-credential-1' });
	const loaded = await store.load();
	// Assert
	expect(loaded?.refreshToken).toBe('refresh-credential-1');
	expect(
		loaded === null ? null : await fleetAdminProofKeyThumbprint(globalThis.crypto, loaded.key),
	).toBe(await fleetAdminProofKeyThumbprint(globalThis.crypto, key));
	const value = [...security.items.values()][0] ?? '';
	const stored = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
	expect(Object.keys(stored).toSorted()).toEqual(['privateJwk', 'refreshToken']);
	for (const secret of [value, 'refresh-credential-1', String(stored.privateJwk.d)])
		for (const call of security.calls) expect(call.args.join(' ')).not.toContain(secret);
	expect(security.calls.filter((call) => call.stdin.includes(value))).toHaveLength(1);
	expect([...security.items.keys()]).toEqual([
		'dev.switchboard.fleet-cli\nhttps://sign-in.example.invalid|owner-fleet-cli',
	]);
});

it('keeps each issuer and client apart: one namespace never reads another', async (): Promise<void> => {
	const security = fakeSecurity();
	const store = (
		issuer: string,
		clientId: string,
	): ReturnType<typeof createMacosKeychainProofKeyStore> =>
		createMacosKeychainProofKeyStore({
			runner: security.runner,
			crypto: globalThis.crypto,
			issuer,
			clientId,
		});
	const owner = store('https://a.example.invalid', 'owner-fleet-cli');
	await owner.save({ key: await owner.createKey(), refreshToken: 'only-a' });
	expect(await store('https://b.example.invalid', 'owner-fleet-cli').load()).toBeNull();
	expect(await store('https://a.example.invalid', 'other-client').load()).toBeNull();
	expect((await owner.load())?.refreshToken).toBe('only-a');
	await owner.remove();
	expect(await owner.load()).toBeNull();
});

it.each([
	{ name: 'off macOS', platform: 'linux' as const, memoryOnly: false },
	{ name: 'with --memory-only', platform: 'darwin' as const, memoryOnly: true },
])(
	'holds the credential in memory $name, warns once and touches neither Keychain nor files',
	async ({ platform, memoryOnly }): Promise<void> => {
		const security = fakeSecurity();
		const warnings: string[] = [];
		const store = selectProofKeyStore({
			platform,
			memoryOnly,
			runner: security.runner,
			crypto: globalThis.crypto,
			issuer: 'https://sign-in.example.invalid',
			clientId: 'owner-fleet-cli',
			warn: (message) => warnings.push(message),
		});
		const key = await store.createKey();
		await store.save({ key, refreshToken: 'memory-only' });
		expect(store.custody).toBe('memory');
		expect(key.privateKey.extractable).toBe(false);
		expect((await store.load())?.refreshToken).toBe('memory-only');
		expect(warnings).toHaveLength(1);
		expect(security.calls).toEqual([]);
		expect(vi.mocked(fs.writeFile)).not.toHaveBeenCalled();
		expect(vi.mocked(fs.open)).not.toHaveBeenCalled();
	},
);

it('falls back to memory with the warning when the Keychain read fails, before any key exists', async (): Promise<void> => {
	const warnings: string[] = [];
	const failing: SecurityCommandRunner = async () => ({ exitCode: 51, stdout: '' });
	const store = selectProofKeyStore({
		platform: 'darwin',
		memoryOnly: false,
		runner: failing,
		crypto: globalThis.crypto,
		issuer: 'https://sign-in.example.invalid',
		clientId: 'owner-fleet-cli',
		warn: (message) => warnings.push(message),
	});
	expect(await store.load()).toBeNull();
	const key = await store.createKey();
	await store.save({ key, refreshToken: 'fallback' });
	expect(store.custody).toBe('memory');
	expect((await store.load())?.refreshToken).toBe('fallback');
	expect(warnings).toEqual([expect.stringContaining('The macOS Keychain is unavailable.')]);
	expect(vi.mocked(fs.writeFile)).not.toHaveBeenCalled();
});

it('a write the readback cannot see is a failed write, never a silent success', async (): Promise<void> => {
	const security = fakeSecurity();
	const lying: SecurityCommandRunner = async (call) =>
		call.args[0] === '-i' ? { exitCode: 0, stdout: '' } : security.runner(call);
	const store = createMacosKeychainProofKeyStore({
		runner: lying,
		crypto: globalThis.crypto,
		issuer: 'https://sign-in.example.invalid',
		clientId: 'owner-fleet-cli',
	});
	await expect(store.save({ key: await store.createKey(), refreshToken: 'x' })).rejects.toThrow(
		'Keychain write failed',
	);
});

it('when only the Keychain write fails, the key already made stays in memory for the command, still extractable, with the warning', async (): Promise<void> => {
	// Arrange: reads work (no item yet); every write is refused.
	const security = fakeSecurity();
	const writeRefused: SecurityCommandRunner = async (call) =>
		call.args[0] === '-i' ? { exitCode: 51, stdout: '' } : security.runner(call);
	const warnings: string[] = [];
	const store = selectProofKeyStore({
		platform: 'darwin',
		memoryOnly: false,
		runner: writeRefused,
		crypto: globalThis.crypto,
		issuer: 'https://sign-in.example.invalid',
		clientId: 'owner-fleet-cli',
		warn: (message) => warnings.push(message),
	});
	// Act
	const before = await store.load();
	const key = await store.createKey();
	await store.save({ key, refreshToken: 'kept-in-memory' });
	// Assert
	expect(before).toBeNull();
	expect(key.privateKey.extractable).toBe(true);
	expect(store.custody).toBe('memory');
	expect((await store.load())?.refreshToken).toBe('kept-in-memory');
	expect(security.items.size).toBe(0);
	expect(warnings).toEqual([expect.stringContaining('The macOS Keychain is unavailable.')]);
	expect(vi.mocked(fs.writeFile)).not.toHaveBeenCalled();
});

it('a key loaded from the Keychain is saved again with its rotated refresh credential: same key, new credential, still Keychain, no warning', async (): Promise<void> => {
	// Arrange: one stand-in keychain; each fresh store instance stands for a later CLI run.
	const security = fakeSecurity();
	const warnings: string[] = [];
	const freshStore = (): ReturnType<typeof selectProofKeyStore> =>
		selectProofKeyStore({
			platform: 'darwin',
			memoryOnly: false,
			runner: security.runner,
			crypto: globalThis.crypto,
			issuer: 'https://sign-in.example.invalid',
			clientId: 'owner-fleet-cli',
			warn: (message) => warnings.push(message),
		});
	const signIn = freshStore();
	const key = await signIn.createKey();
	await signIn.save({ key, refreshToken: 'refresh-1' });
	// Act: the next store instance loads it and saves the rotated credential.
	const refresher = freshStore();
	const loaded = await refresher.load();
	if (loaded === null) throw new Error('Nothing loaded');
	await refresher.save({ key: loaded.key, refreshToken: 'refresh-2' });
	const following = await freshStore().load();
	// Assert
	expect(refresher.custody).toBe('keychain');
	expect(warnings).toEqual([]);
	expect(following?.refreshToken).toBe('refresh-2');
	expect(
		following === null
			? null
			: await fleetAdminProofKeyThumbprint(globalThis.crypto, following.key),
	).toBe(await fleetAdminProofKeyThumbprint(globalThis.crypto, key));
});
