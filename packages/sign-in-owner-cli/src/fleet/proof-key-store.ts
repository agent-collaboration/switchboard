import { execFile } from 'node:child_process';

import {
	createFleetAdminProofKey,
	exportFleetAdminPrivateJwk,
	importFleetAdminProofKey,
	type FleetAdminProofKey,
	type SignInCrypto,
} from '@agent-collaboration/sign-in-core';
import { z } from 'zod';

/** The fleet CLI's key and its key-bound refresh credential (t15e): both or neither. */
export interface FleetCliCredential {
	readonly key: FleetAdminProofKey;
	readonly refreshToken: string;
}

/**
 * Where the fleet CLI keeps that credential: the macOS Keychain,
 * otherwise memory for this one command. Never a file.
 */
export interface ProofKeyStore {
	readonly custody: 'keychain' | 'memory';
	/** A fresh key this store can keep: extractable only when the Keychain will hold it. */
	readonly createKey: () => Promise<FleetAdminProofKey>;
	readonly load: () => Promise<FleetCliCredential | null>;
	readonly save: (credential: FleetCliCredential) => Promise<void>;
	readonly remove: () => Promise<void>;
}

export function createMemoryProofKeyStore(crypto: SignInCrypto): ProofKeyStore {
	let held: FleetCliCredential | null = null;
	return {
		custody: 'memory',
		createKey: async () => createFleetAdminProofKey(crypto),
		load: async () => held,
		save: async (credential) => {
			held = credential;
		},
		remove: async () => {
			held = null;
		},
	};
}

/** One `/usr/bin/security` invocation; a secret only ever travels in `stdin`. */
export type SecurityCommandRunner = (props: {
	readonly args: readonly string[];
	readonly stdin?: string;
}) => Promise<{ readonly exitCode: number; readonly stdout: string }>;

export const nodeSecurityCommandRunner: SecurityCommandRunner = async ({ args, stdin }) =>
	new Promise((resolveRun) => {
		const child = execFile(
			'/usr/bin/security',
			[...args],
			{ encoding: 'utf8', maxBuffer: 1024 * 1024 },
			(error, stdout) => {
				const code = error === null ? 0 : typeof error.code === 'number' ? error.code : Number.NaN;
				resolveRun({ exitCode: Number.isNaN(code) ? 1 : code, stdout });
			},
		);
		child.stdin?.end(stdin ?? '');
	});

export const fleetCliKeychainService = 'dev.switchboard.fleet-cli';
/** `security find-generic-password`: no such item. */
const itemNotFound = 44;
const keychainValueSchema = z.strictObject({
	privateJwk: z.looseObject({
		kty: z.literal('EC'),
		crv: z.literal('P-256'),
		x: z.string(),
		y: z.string(),
		d: z.string(),
	}),
	refreshToken: z.string().min(1),
});

/** A word `security -i` reads as one token: base64url and URL characters, never a quote. */
function quotedWord(value: string): string {
	if (!/^[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%|-]+$/u.test(value) || value.includes("'"))
		throw new Error('Keychain names must be plain URL characters');
	return `"${value}"`;
}

/**
 * One generic-password item per issuer and client: service `dev.switchboard.fleet-cli`,
 * account `<issuer>|<clientId>`, value base64url(JSON {privateJwk, refreshToken}). Accepted
 * cost (t15b): the key is extractable so it can be stored, and any process that can run
 * `security` as this user can read the item without a prompt.
 */
export function createMacosKeychainProofKeyStore(props: {
	readonly runner: SecurityCommandRunner;
	readonly crypto: SignInCrypto;
	readonly issuer: string;
	readonly clientId: string;
	readonly service?: string;
}): ProofKeyStore {
	const service = props.service ?? fleetCliKeychainService;
	const account = `${props.issuer}|${props.clientId}`;
	async function readItem(): Promise<string | null> {
		const found = await props.runner({
			args: ['find-generic-password', '-s', service, '-a', account, '-w'],
		});
		if (found.exitCode === itemNotFound) return null;
		if (found.exitCode !== 0) throw new Error('Keychain read failed');
		return found.stdout.trim();
	}
	return {
		custody: 'keychain',
		createKey: async () => createFleetAdminProofKey(props.crypto, { extractable: true }),
		async load(): Promise<FleetCliCredential | null> {
			const stored = await readItem();
			if (stored === null) return null;
			const value = keychainValueSchema.parse(
				JSON.parse(Buffer.from(stored, 'base64url').toString('utf8')),
			);
			return {
				// Extractable: after a refresh this same key is saved again with the rotated credential.
				key: await importFleetAdminProofKey(props.crypto, value.privateJwk, { extractable: true }),
				refreshToken: value.refreshToken,
			};
		},
		async save(credential): Promise<void> {
			const value = Buffer.from(
				JSON.stringify(
					keychainValueSchema.parse({
						privateJwk: await exportFleetAdminPrivateJwk(props.crypto, credential.key),
						refreshToken: credential.refreshToken,
					}),
				),
			).toString('base64url');
			// `security -i` reads the command from stdin, so the value never enters argv.
			const added = await props.runner({
				args: ['-i'],
				stdin: `add-generic-password -U -s ${quotedWord(service)} -a ${quotedWord(account)} -w ${quotedWord(value)}\n`,
			});
			// `-i` can exit 0 when its inner command fails: the readback is the proof of the write.
			if (added.exitCode !== 0 || (await readItem()) !== value)
				throw new Error('Keychain write failed');
		},
		async remove(): Promise<void> {
			const removed = await props.runner({
				args: ['delete-generic-password', '-s', service, '-a', account],
			});
			if (removed.exitCode !== 0 && removed.exitCode !== itemNotFound)
				throw new Error('Keychain delete failed');
		},
	};
}

/**
 * The Keychain on macOS, otherwise memory with a warning. A Keychain failure in the middle of a
 * command also falls back to memory for the rest of that command, with the same warning.
 */
export function selectProofKeyStore(props: {
	readonly platform: NodeJS.Platform;
	readonly memoryOnly: boolean;
	readonly runner: SecurityCommandRunner;
	readonly crypto: SignInCrypto;
	readonly issuer: string;
	readonly clientId: string;
	readonly warn: (message: string) => void;
}): ProofKeyStore {
	const warning =
		'Holding the fleet key and refresh credential in memory for this command only; the next command signs in again.';
	if (props.memoryOnly || props.platform !== 'darwin') {
		props.warn(warning);
		return createMemoryProofKeyStore(props.crypto);
	}
	const keychain = createMacosKeychainProofKeyStore(props);
	let fallback: ProofKeyStore | null = null;
	function memory(): ProofKeyStore {
		if (fallback === null) {
			props.warn(`The macOS Keychain is unavailable. ${warning}`);
			fallback = createMemoryProofKeyStore(props.crypto);
		}
		return fallback;
	}
	return {
		get custody(): ProofKeyStore['custody'] {
			return fallback === null ? 'keychain' : 'memory';
		},
		createKey: async () => (fallback ?? keychain).createKey(),
		async load(): Promise<FleetCliCredential | null> {
			if (fallback !== null) return fallback.load();
			try {
				return await keychain.load();
			} catch {
				return memory().load();
			}
		},
		async save(credential): Promise<void> {
			if (fallback !== null) return fallback.save(credential);
			try {
				await keychain.save(credential);
			} catch {
				await memory().save(credential);
			}
		},
		async remove(): Promise<void> {
			if (fallback !== null) return fallback.remove();
			try {
				await keychain.remove();
			} catch {
				await memory().remove();
			}
		},
	};
}
