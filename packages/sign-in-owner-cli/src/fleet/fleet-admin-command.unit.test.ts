import {
	createFleetAdminProofKey,
	fleetAdminProofKeyThumbprint,
	type FleetAdminRequest,
} from '@agent-collaboration/sign-in-core';
import { expect, it } from 'vitest';

import type { AuthTarget, FleetTarget } from '#sign-in-owner-cli/auth-target';
import { runFleetAdminCommand } from '#sign-in-owner-cli/fleet/fleet-admin-command';
import { runFleetCommand } from '#sign-in-owner-cli/fleet/fleet-cli-commands';
import type { FleetCliIo } from '#sign-in-owner-cli/fleet/fleet-credential';
import { createMemoryProofKeyStore } from '#sign-in-owner-cli/fleet/proof-key-store';

const target: FleetTarget = {
	issuer: 'https://sign-in.example.invalid',
	organizationId: '019a3dce-2000-7000-8000-000000000001',
	ownerCliRedirectUri: 'http://127.0.0.1/callback',
	centralAdminAudience: 'https://central.example.invalid/admin',
	centralPublicOrigin: 'https://central.example.invalid',
	ownerFleetCliClientId: 'owner-fleet-cli',
};
const operation: FleetAdminRequest = {
	operation: 'CreateWorkspace',
	organizationId: target.organizationId,
	operationId: '019a3dce-2000-7000-8000-000000000004',
	name: 'research',
	description: '',
};

/** The JWS header or payload, read without verifying: the test checks what the CLI sent. */
function jwsPart(token: string, index: 0 | 1): Record<string, unknown> {
	return JSON.parse(Buffer.from(token.split('.')[index] ?? '', 'base64url').toString('utf8'));
}
const decodeProtectedHeader = (token: string): Record<string, unknown> => jwsPart(token, 0);
const decodeJwt = (token: string): Record<string, unknown> => jwsPart(token, 1);

function unsignedToken(claims: Readonly<Record<string, unknown>>): string {
	const part = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
	return `${part({ alg: 'none' })}.${part(claims)}.`;
}

/** A scripted issuer token endpoint and relay; central's answers come from `relayReplies`. */
async function scenario(relayReplies: readonly (() => Response)[]): Promise<{
	readonly io: FleetCliIo;
	readonly relayCalls: { readonly path: string; readonly body: string; readonly proof: string }[];
	readonly refreshCalls: string[];
	readonly store: ReturnType<typeof createMemoryProofKeyStore>;
	readonly session: {
		readonly accessToken: string;
		readonly key: Awaited<ReturnType<typeof createFleetAdminProofKey>>;
	};
}> {
	const key = await createFleetAdminProofKey(globalThis.crypto);
	const store = createMemoryProofKeyStore(globalThis.crypto);
	await store.save({ key, refreshToken: 'refresh-1' });
	const relayCalls: { readonly path: string; readonly body: string; readonly proof: string }[] = [];
	const refreshCalls: string[] = [];
	let ids = 0;
	const io: FleetCliIo = {
		crypto: globalThis.crypto,
		now: () => 2_208_988_800_000,
		nextId: () => {
			ids += 1;
			return `019a3dce-2000-7000-8000-${ids.toString(16).padStart(12, '0')}`;
		},
		browser: async () => {
			throw new Error('no browser in this case');
		},
		async fetch(input, init) {
			const url = new URL(String(input));
			const headers = new Headers(init?.headers);
			if (url.pathname === '/api/auth/oauth2/token') {
				const form = new URLSearchParams(
					typeof init?.body === 'string'
						? init.body
						: init?.body instanceof URLSearchParams
							? init.body
							: '',
				);
				refreshCalls.push(form.get('refresh_token') ?? '');
				const jwk = decodeProtectedHeader(headers.get('dpop') ?? '').jwk;
				const thumbprint =
					jwk === undefined
						? ''
						: await fleetAdminProofKeyThumbprint(globalThis.crypto, {
								privateKey: key.privateKey,
								publicJwk: jwk as typeof key.publicJwk,
							});
				return Response.json({
					access_token: unsignedToken({
						aud: target.centralAdminAudience,
						client_id: target.ownerFleetCliClientId,
						token_profile: 'person-fleet',
						cnf: { jkt: thumbprint },
					}),
					token_type: 'DPoP',
					refresh_token: `refresh-${refreshCalls.length + 1}`,
				});
			}
			relayCalls.push({
				path: url.pathname,
				body: typeof init?.body === 'string' ? init.body : '',
				proof: headers.get('dpop') ?? '',
			});
			const reply = relayReplies[relayCalls.length - 1];
			if (reply === undefined) throw new Error('unexpected relay call');
			return reply();
		},
	};
	return { io, relayCalls, refreshCalls, store, session: { accessToken: 'access-1', key } };
}

const refusedFactor = (): Response =>
	Response.json({ result: 'refused', reason: 'secondFactorRequired' });
const applied = (): Response =>
	Response.json({
		result: 'applied',
		workspace: {
			workspaceId: '019a3dce-2000-7000-8000-0000000000a1',
			name: 'research',
			description: '',
			state: 'active',
		},
	});

it('after a confirmed step-up it refreshes with the same key and retries once, same operation, fresh proof', async (): Promise<void> => {
	// Arrange
	const world = await scenario([refusedFactor, applied]);
	let confirmations = 0;
	// Act
	const outcome = await runFleetAdminCommand({
		target,
		store: world.store,
		session: world.session,
		operation,
		io: world.io,
		confirmSecondFactor: async () => {
			confirmations += 1;
			return true;
		},
	});
	// Assert
	expect(outcome).toMatchObject({ kind: 'answered', result: { result: 'applied' } });
	expect(confirmations).toBe(1);
	expect(world.refreshCalls).toEqual(['refresh-1']);
	expect((await world.store.load())?.refreshToken).toBe('refresh-2');
	const [first, retry] = world.relayCalls;
	expect(world.relayCalls).toHaveLength(2);
	expect(retry?.body).toBe(first?.body);
	const firstProof = decodeJwt(first?.proof ?? '');
	const retryProof = decodeJwt(retry?.proof ?? '');
	expect(retryProof['jti']).not.toBe(firstProof['jti']);
	expect(retryProof['intent']).toBe(firstProof['intent']);
	expect(retryProof['ath']).not.toBe(firstProof['ath']);
	expect(decodeProtectedHeader(retry?.proof ?? '')['jwk']).toEqual(world.session.key.publicJwk);
});

it('a cancelled or failed confirmation refreshes nothing and retries nothing', async (): Promise<void> => {
	const world = await scenario([refusedFactor]);
	const outcome = await runFleetAdminCommand({
		target,
		store: world.store,
		session: world.session,
		operation,
		io: world.io,
		confirmSecondFactor: async () => false,
	});
	expect(outcome).toEqual({ kind: 'not-confirmed' });
	expect(world.refreshCalls).toEqual([]);
	expect(world.relayCalls).toHaveLength(1);
});

it('a lost reply is unknown: no retry and no new operation ID', async (): Promise<void> => {
	const world = await scenario([
		() => {
			throw new TypeError('connection reset');
		},
	]);
	const outcome = await runFleetAdminCommand({
		target,
		store: world.store,
		session: world.session,
		operation,
		io: world.io,
		confirmSecondFactor: async () => true,
	});
	expect(outcome).toEqual({ kind: 'unknown' });
	expect(world.relayCalls).toHaveLength(1);
	expect(JSON.parse(world.relayCalls[0]?.body ?? '{}').operationId).toBe(operation.operationId);
	expect(world.refreshCalls).toEqual([]);
});

const nameInUse = (): Response => Response.json({ result: 'refused', reason: 'nameInUse' });
const foundWorkspace =
	(name: string | null): (() => Response) =>
	(): Response =>
		Response.json({
			result: 'found',
			workspace:
				name === null
					? null
					: {
							workspaceId: operation.operationId,
							name,
							description: '',
							state: 'active',
						},
		});

it.each([
	{
		found: 'research',
		expected: {
			kind: 'created-earlier',
			workspace: {
				workspaceId: '019a3dce-2000-7000-8000-000000000004',
				name: 'research',
				description: '',
				state: 'active',
			},
		},
	},
	{
		found: 'other',
		expected: { kind: 'answered', result: { result: 'refused', reason: 'nameInUse' } },
	},
	{
		found: null,
		expected: { kind: 'answered', result: { result: 'refused', reason: 'nameInUse' } },
	},
])(
	'a create answered nameInUse looks up its own workspace once; found with the same name ($found) it was created earlier',
	async ({ found, expected }): Promise<void> => {
		// Arrange
		const world = await scenario([nameInUse, foundWorkspace(found)]);
		// Act
		const outcome = await runFleetAdminCommand({
			target,
			store: world.store,
			session: world.session,
			operation,
			io: world.io,
			confirmSecondFactor: async () => true,
		});
		// Assert: exactly one create, then exactly one lookup at workspaceId = operationId.
		expect(outcome).toEqual(expected);
		expect(world.relayCalls.map((call) => call.path)).toEqual([
			'/api/auth/organization-admin/v1/create-workspace',
			'/api/auth/organization-admin/v1/workspace-lookup',
		]);
		expect(JSON.parse(world.relayCalls[1]?.body ?? '{}')).toEqual({
			organizationId: target.organizationId,
			workspaceId: operation.operationId,
		});
	},
);

it('a create answered conflict is reported as is: no lookup, no retry', async (): Promise<void> => {
	// Arrange
	const world = await scenario([
		(): Response => Response.json({ result: 'refused', reason: 'conflict' }),
	]);
	// Act
	const outcome = await runFleetAdminCommand({
		target,
		store: world.store,
		session: world.session,
		operation,
		io: world.io,
		confirmSecondFactor: async () => true,
	});
	// Assert
	expect(outcome).toEqual({ kind: 'answered', result: { result: 'refused', reason: 'conflict' } });
	expect(world.relayCalls).toHaveLength(1);
});

/** The same target as a person's target file holds it, for the real command entry. */
const authTarget: AuthTarget = {
	issuer: target.issuer,
	managementAudience: 'https://portal.example.invalid/management',
	gatewayUrl: 'https://portal.example.invalid',
	ownerCliClientId: 'owner-cli',
	ownerCliRedirectUri: target.ownerCliRedirectUri,
	organizationId: target.organizationId,
	workspaceId: '019a3dce-2000-7000-8000-000000000002',
	tokenCachePath: '/nonexistent/owner-token.json',
	centralAdminAudience: target.centralAdminAudience,
	centralPublicOrigin: target.centralPublicOrigin,
	ownerFleetCliClientId: target.ownerFleetCliClientId,
};

/** `fleet-create-workspace` through the real command entry: its printed lines and exit code. */
async function createThroughCli(relayReplies: readonly (() => Response)[]): Promise<{
	readonly exitCode: number;
	readonly lines: readonly string[];
	readonly relayPaths: readonly string[];
	readonly relayBodies: readonly unknown[];
}> {
	const world = await scenario(relayReplies);
	const lines: string[] = [];
	const exitCode = await runFleetCommand({
		command: 'fleet-create-workspace',
		target: authTarget,
		options: { 'operation-id': '019a3dce-2000-7000-8000-000000000004', name: 'research' },
		environment: {
			io: world.io,
			store: () => world.store,
			confirmSecondFactor: async () => false,
			write: (line) => lines.push(line),
		},
	});
	return {
		exitCode,
		lines,
		relayPaths: world.relayCalls.map((call) => call.path),
		relayBodies: world.relayCalls.map((call) => JSON.parse(call.body)),
	};
}

it.each([
	{ found: null, case: 'finds nothing' },
	{ found: 'another-name', case: 'finds another name' },
])(
	'the CLI prints the nameInUse words and exits non-zero when its one lookup $case',
	async ({ found }): Promise<void> => {
		// Act
		const run = await createThroughCli([nameInUse, foundWorkspace(found)]);
		// Assert: the printed words and exit code; one create, then one lookup at the operation.
		expect(run.lines).toEqual(['A workspace with that name already exists.']);
		expect(run.exitCode).not.toBe(0);
		expect(run.relayPaths).toEqual([
			'/api/auth/organization-admin/v1/create-workspace',
			'/api/auth/organization-admin/v1/workspace-lookup',
		]);
		expect(run.relayBodies[1]).toEqual({
			organizationId: target.organizationId,
			workspaceId: operation.operationId,
		});
	},
);

it('the CLI prints the conflict words and exits non-zero, with no lookup', async (): Promise<void> => {
	// Act
	const run = await createThroughCli([
		(): Response => Response.json({ result: 'refused', reason: 'conflict' }),
	]);
	// Assert
	expect(run.lines).toEqual([
		'That request was already used for a different workspace. Try again.',
	]);
	expect(run.exitCode).not.toBe(0);
	expect(run.relayPaths).toEqual(['/api/auth/organization-admin/v1/create-workspace']);
});

it('the CLI prints "Workspace created." and exits 0 when its one lookup finds its own workspace', async (): Promise<void> => {
	// Act
	const run = await createThroughCli([nameInUse, foundWorkspace('research')]);
	// Assert
	expect(run.lines[0]).toBe('Workspace created.');
	expect(JSON.parse(run.lines[1] ?? 'null')).toEqual({
		workspace: {
			workspaceId: operation.operationId,
			name: 'research',
			description: '',
			state: 'active',
		},
	});
	expect(run.exitCode).toBe(0);
	expect(run.relayPaths).toHaveLength(2);
});
