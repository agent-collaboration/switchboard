import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import type { AuthTarget } from '@agent-collaboration/sign-in-owner-cli';
import { beforeEach, expect, it, vi } from 'vitest';

import { controlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-sign-in-clock';
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
	signalCode: NodeJS.Signals | null = null;
	killed = false;
	readonly kill = vi.fn((): boolean => true);

	terminate(signal: NodeJS.Signals): void {
		this.killed = true;
		this.signalCode = signal;
		this.stdout.end();
		this.stderr.end();
		this.emit('close', null, signal);
	}

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

it('refuses a forced CLI exit-zero with a valid cache but no original authorization', async (): Promise<void> => {
	const child = new ObservedCliChild();
	const spawned = Promise.withResolvers<void>();
	effects.spawn.mockImplementation(() => {
		spawned.resolve();
		return child;
	});
	const browser = vi.fn(async (): Promise<readonly string[]> => []);
	const login = loginThroughNativeOwnerCli({ target, repositoryRoot: '/repository', browser });
	const rejected = expect(login).rejects.toThrow(
		'Forced native CLI login did not print an authorization URL',
	);

	await spawned.promise;
	child.finish(0);

	await rejected;
	expect(browser).not.toHaveBeenCalled();
	expect(effects.readFile).not.toHaveBeenCalled();
});

it('allows the cache-only completion when cache reuse was explicit', async (): Promise<void> => {
	const child = new ObservedCliChild();
	const spawned = Promise.withResolvers<void>();
	effects.spawn.mockImplementation(() => {
		spawned.resolve();
		return child;
	});
	const browser = vi.fn(async (): Promise<readonly string[]> => []);
	const login = loginThroughNativeOwnerCli({
		target,
		repositoryRoot: '/repository',
		browser,
		profile: {
			kind: 'clock',
			nowMilliseconds: controlledSignInClock.now(),
			authorization: 'allow-cache',
		},
	});

	await spawned.promise;
	child.finish(0);

	await expect(login).resolves.toBe('private-cached-token');
	expect(browser).not.toHaveBeenCalled();
});

it.each(['waitingForUrl', 'browserRunning'] as const)(
	'cancels and joins the child while %s',
	async (phase): Promise<void> => {
		const child = new ObservedCliChild();
		const spawned = Promise.withResolvers<void>();
		const enteredBrowser = Promise.withResolvers<void>();
		const browser = Promise.withResolvers<readonly string[]>();
		const cancellation = new AbortController();
		const reason = new Error('Proof scenario cancelled');
		child.kill.mockImplementationOnce(() => {
			child.terminate('SIGTERM');
			return true;
		});
		effects.spawn.mockImplementation(() => {
			spawned.resolve();
			return child;
		});
		const cancelBrowser = vi.fn(async (): Promise<void> => {
			browser.reject(reason);
		});
		const login = loginThroughNativeOwnerCli({
			target,
			repositoryRoot: '/repository',
			signal: cancellation.signal,
			browser: async (): Promise<readonly string[]> => {
				enteredBrowser.resolve();
				return browser.promise;
			},
			cancelBrowser,
		});
		void login.catch(() => undefined);
		void browser.promise.catch(() => undefined);

		await spawned.promise;
		if (phase === 'browserRunning') {
			child.stdout.write('AUTHORIZATION_URL=http://127.0.0.1:41001/sign-in\n');
			await enteredBrowser.promise;
		}
		cancellation.abort(reason);

		// A broken cancellation path gets a fake child close so the control fails at the assertion.
		if (child.signalCode === null) {
			child.terminate('SIGTERM');
			browser.reject(reason);
		}
		expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
		await expect(login).rejects.toBe(reason);
		expect(child.signalCode).toBe('SIGTERM');
		expect(cancelBrowser).toHaveBeenCalledTimes(phase === 'browserRunning' ? 1 : 0);
		expect(effects.readFile).not.toHaveBeenCalled();
	},
);
