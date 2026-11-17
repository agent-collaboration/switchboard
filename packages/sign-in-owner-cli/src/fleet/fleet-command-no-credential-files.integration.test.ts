import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { fleetAdminProofKeyThumbprint } from '@agent-collaboration/sign-in-core';
import { afterEach, expect, it, vi } from 'vitest';

import {
	nodeFleetCliEnvironment,
	type FleetCliEnvironment,
} from '#sign-in-owner-cli/fleet/fleet-cli-commands';
import type { FleetCliIo } from '#sign-in-owner-cli/fleet/fleet-credential';
import { selectProofKeyStore } from '#sign-in-owner-cli/fleet/proof-key-store';
import { runOwnerCli } from '#sign-in-owner-cli/owner-cli';

vi.mock('node:fs', { spy: true });
vi.mock('node:fs/promises', { spy: true });
afterEach(() => vi.clearAllMocks());

const issuer = 'https://sign-in.example.invalid';
const organizationId = '019a3dce-2000-7000-8000-000000000001';
const fleetClient = 'owner-fleet-cli';

/** Every Node file-writing entry point; reads are allowed (the CLI reads its target). */
const writeApis = [
	[
		fsPromises,
		[
			'writeFile',
			'appendFile',
			'mkdir',
			'rename',
			'copyFile',
			'cp',
			'symlink',
			'link',
			'truncate',
			'mkdtemp',
		],
	],
	[
		fs,
		[
			'writeFileSync',
			'appendFileSync',
			'mkdirSync',
			'renameSync',
			'copyFileSync',
			'cpSync',
			'symlinkSync',
			'linkSync',
			'truncateSync',
			'mkdtempSync',
			'createWriteStream',
			'writeSync',
			'writeFile',
			'appendFile',
		],
	],
] as const;
function writeCalls(): readonly string[] {
	const calls: string[] = [];
	for (const [module, names] of writeApis)
		for (const name of names) {
			const spied: unknown = Reflect.get(module, name);
			if (vi.isMockFunction(spied) && spied.mock.calls.length > 0) calls.push(name);
		}
	// open/openSync only count when opened for writing.
	for (const [module, name] of [
		[fsPromises, 'open'],
		[fs, 'openSync'],
		[fs, 'open'],
	] as const) {
		const spied: unknown = Reflect.get(module, name);
		if (vi.isMockFunction(spied))
			for (const call of spied.mock.calls)
				if (typeof call[1] === 'string' && /[wa+]/u.test(call[1])) calls.push(name);
	}
	return calls;
}

/** A stand-in issuer and relay over the CLI's own injected fetch; the loopback listener is real. */
function fakeServices(): FleetCliIo {
	let ids = 0;
	return {
		crypto: globalThis.crypto,
		now: () => 2_208_988_800_000,
		nextId: () => {
			ids += 1;
			return `019a3dce-2000-7000-8000-${ids.toString(16).padStart(12, '0')}`;
		},
		async browser(url) {
			const authorization = new URL(new URL(url).searchParams.get('authorize') ?? 'invalid:');
			const callback = new URL(authorization.searchParams.get('redirect_uri') ?? 'invalid:');
			callback.search = new URLSearchParams({
				code: 'authorization-code',
				state: authorization.searchParams.get('state') ?? '',
				iss: issuer,
			}).toString();
			await fetch(callback);
		},
		async fetch(input, init) {
			const url = new URL(String(input));
			const headers = new Headers(init?.headers);
			if (url.pathname === '/api/auth/oauth2/token') {
				const header = JSON.parse(
					Buffer.from((headers.get('dpop') ?? '').split('.')[0] ?? '', 'base64url').toString(
						'utf8',
					),
				);
				const thumbprint = await fleetAdminProofKeyThumbprint(globalThis.crypto, {
					privateKey: undefined as never,
					publicJwk: header.jwk,
				});
				const part = (value: unknown): string =>
					Buffer.from(JSON.stringify(value)).toString('base64url');
				return Response.json({
					access_token: `${part({ alg: 'none' })}.${part({ aud: 'https://central.example.invalid/admin', client_id: fleetClient, token_profile: 'person-fleet', cnf: { jkt: thumbprint } })}.`,
					token_type: 'DPoP',
					refresh_token: 'refresh-credential',
				});
			}
			return Response.json({
				result: 'applied',
				workspace: {
					workspaceId: '019a3dce-2000-7000-8000-0000000000a1',
					name: 'research',
					description: '',
					state: 'active',
				},
			});
		},
	};
}

async function privateTarget(): Promise<{ readonly directory: string; readonly file: string }> {
	const directory = await fsPromises.mkdtemp(path.join(tmpdir(), '2026-11-fleet-cli-writes-'));
	const file = path.join(directory, 'target.json');
	await fsPromises.writeFile(
		file,
		JSON.stringify({
			issuer,
			managementAudience: 'https://portal.example.invalid/management',
			gatewayUrl: 'https://portal.example.invalid',
			ownerCliClientId: 'owner-cli',
			ownerCliRedirectUri: 'http://127.0.0.1/callback',
			organizationId,
			workspaceId: '019a3dce-2000-7000-8000-000000000002',
			tokenCachePath: path.join(directory, 'owner-token.json'),
			centralAdminAudience: 'https://central.example.invalid/admin',
			centralPublicOrigin: 'https://central.example.invalid',
			ownerFleetCliClientId: fleetClient,
		}),
		{ mode: 0o600 },
	);
	return { directory, file };
}

it.each([
	{
		path: '--memory-only',
		args: ['--memory-only'],
		environment: (base: FleetCliEnvironment): FleetCliEnvironment => base,
	},
	{
		path: 'the Keychain runner failing',
		args: [],
		environment: (base: FleetCliEnvironment): FleetCliEnvironment => ({
			...base,
			store: ({ issuer: storeIssuer, clientId }) =>
				selectProofKeyStore({
					platform: 'darwin',
					memoryOnly: false,
					runner: async () => ({ exitCode: 51, stdout: '' }),
					crypto: globalThis.crypto,
					issuer: storeIssuer,
					clientId,
					warn: () => undefined,
				}),
		}),
	},
])(
	'a full fleet-create-workspace with $path writes no file anywhere',
	async ({ args, environment }): Promise<void> => {
		// Arrange (before observation): the private target file the person keeps.
		const target = await privateTarget();
		const listing = async (): Promise<readonly string[]> =>
			[
				...(await fsPromises.readdir(target.directory)),
				'--cwd--',
				...(await fsPromises.readdir(process.cwd())),
			].toSorted();
		const before = await listing();
		vi.clearAllMocks();
		const lines: string[] = [];
		const base = nodeFleetCliEnvironment({
			noBrowser: true,
			memoryOnly: args.includes('--memory-only'),
			openBrowser: async () => undefined,
		});
		// Act: the real argv dispatch, target read, store selection, sign-in and command.
		const exitCode = await runOwnerCli(
			[
				'--target',
				target.file,
				...args,
				'fleet-create-workspace',
				'--operation-id',
				'019a3dce-2000-7000-8000-000000000004',
				'--name',
				'research',
			],
			{
				...environment(base),
				io: fakeServices(),
				confirmSecondFactor: async () => false,
				write: (line) => lines.push(line),
			},
		);
		// Assert
		expect(exitCode).toBe(0);
		expect(JSON.parse(lines.at(-1) ?? 'null')).toMatchObject({ result: 'applied' });
		expect(writeCalls()).toEqual([]);
		expect(await listing()).toEqual(before);
		await fsPromises.rm(target.directory, { recursive: true });
	},
);
