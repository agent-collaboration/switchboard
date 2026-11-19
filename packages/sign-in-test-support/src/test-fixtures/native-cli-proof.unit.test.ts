import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import type { AuthTarget } from '@agent-collaboration/sign-in-owner-cli';
import { beforeEach, expect, it, vi } from 'vitest';

import { loginThroughNativeOwnerCli } from '#sign-in-test-support/test-fixtures/native-cli-proof';

const effects = vi.hoisted(() => ({ spawn: vi.fn(), writeFile: vi.fn(), readFile: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => ({
	...(await importOriginal<typeof import('node:child_process')>()),
	spawn: effects.spawn,
}));
vi.mock('node:fs/promises', async (importOriginal) => ({
	...(await importOriginal<typeof import('node:fs/promises')>()),
	writeFile: effects.writeFile,
	readFile: effects.readFile,
}));

class ObservedCliChild extends EventEmitter {
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	exitCode: number | null = null;
	readonly kill = vi.fn((): boolean => true);

	finish(exitCode: number): void {
		this.exitCode = exitCode;
		this.stdout.end();
		this.stderr.end();
		this.emit('exit', exitCode, null);
		this.emit('close', exitCode, null);
	}
}

const target: AuthTarget = {
	issuer: 'http://127.0.0.1:41001',
	managementAudience: 'management-test',
	gatewayUrl: 'http://127.0.0.1:41002',
	ownerCliClientId: 'owner-cli-test',
	ownerCliRedirectUri: 'http://127.0.0.1:0/callback',
	organizationId: '019d0000-0000-7000-8000-000000000001',
	workspaceId: '019d0000-0000-7000-8000-000000000002',
	tokenCachePath: '/private/tmp/native-cli-proof-unit/cache.json',
};

beforeEach((): void => {
	vi.clearAllMocks();
	effects.writeFile.mockResolvedValue(undefined);
	effects.readFile.mockResolvedValue(
		JSON.stringify({
			issuer: target.issuer,
			audience: target.managementAudience,
			clientId: target.ownerCliClientId,
			token: 'private-cached-token',
			expiresAt: 1,
		}),
	);
});

it('rejects a failed CLI while its browser continuation is still pending', async (): Promise<void> => {
	// Arrange
	const child = new ObservedCliChild();
	const spawned = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	const browser = Promise.withResolvers<readonly string[]>();
	effects.spawn.mockImplementation(() => {
		spawned.resolve();
		return child;
	});
	const login = loginThroughNativeOwnerCli({
		target,
		repositoryRoot: '/repository',
		browser: async (): Promise<readonly string[]> => {
			entered.resolve();
			return browser.promise;
		},
	});
	const rejected = expect(login).rejects.toThrow('Delivered native CLI failed (7)');
	await spawned.promise;
	child.stdout.write('AUTHORIZATION_URL=http://127.0.0.1:41001/sign-in\n');
	await entered.promise;

	// Act
	child.stderr.write('Owner code exchange refused\n');
	child.finish(7);

	// Assert
	await rejected;
	expect(effects.readFile).not.toHaveBeenCalled();
	expect(child.kill).not.toHaveBeenCalled();
	browser.resolve([]);
});

it('keeps browser failure decisive after a successful CLI exit', async (): Promise<void> => {
	// Arrange
	const child = new ObservedCliChild();
	const spawned = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	const browser = Promise.withResolvers<readonly string[]>();
	effects.spawn.mockImplementation(() => {
		spawned.resolve();
		return child;
	});
	const login = loginThroughNativeOwnerCli({
		target,
		repositoryRoot: '/repository',
		browser: async (): Promise<readonly string[]> => {
			entered.resolve();
			return browser.promise;
		},
	});
	const rejected = expect(login).rejects.toThrow('Main-frame navigation failed');
	await spawned.promise;
	child.stdout.write('AUTHORIZATION_URL=http://127.0.0.1:41001/sign-in\n');
	await entered.promise;

	// Act
	child.finish(0);
	browser.reject(new Error('Main-frame navigation failed'));

	// Assert
	await rejected;
	expect(effects.readFile).not.toHaveBeenCalled();
});

it('reads the real cache contract only after both CLI and browser succeed', async (): Promise<void> => {
	// Arrange
	const child = new ObservedCliChild();
	const spawned = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	const browser = Promise.withResolvers<readonly string[]>();
	effects.spawn.mockImplementation(() => {
		spawned.resolve();
		return child;
	});
	const login = loginThroughNativeOwnerCli({
		target,
		repositoryRoot: '/repository',
		browser: async (): Promise<readonly string[]> => {
			entered.resolve();
			return browser.promise;
		},
	});
	await spawned.promise;
	child.stdout.write('AUTHORIZATION_URL=http://127.0.0.1:41001/sign-in\n');
	await entered.promise;

	// Act
	child.stdout.write(
		'Owner management credential ready. Each command still checks the live session.\n',
	);
	child.finish(0);
	browser.resolve([]);

	// Assert
	await expect(login).resolves.toBe('private-cached-token');
	expect(effects.readFile).toHaveBeenCalledWith(target.tokenCachePath, 'utf8');
});
