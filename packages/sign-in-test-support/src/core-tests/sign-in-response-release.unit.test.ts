import {
	accessTokenReleaseClaimsSchema,
	agentRegistrationSchema,
	releaseSignInResponse,
	type AccessTokenReleaseClaims,
	type SignInResponseReleasePorts,
} from '@agent-collaboration/sign-in-core';
import { decodeJwt, generateKeyPair, SignJWT } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import { expectNoIssuedCredentials } from '#sign-in-test-support/test-fixtures/credential-free-refusal';

useControlledSignInClock();

const issuer = 'https://sign-in.invalid';
const workspaceId = '33333333-3333-7333-8333-333333333333';
const agentAudience = `https://portal.invalid/workspaces/${workspaceId}/mcp`;
const toolPortalOrigin = 'https://portal.invalid';
const managementAudience = 'https://portal.invalid/management';
const organizationId = '11111111-1111-7111-8111-111111111111';
const now = 1_800_000_000;
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
beforeAll(async () => {
	keys = await generateKeyPair('EdDSA');
});
const agentClaims = {
	iss: issuer,
	sub: 'agent-one',
	aud: agentAudience,
	iat: now,
	exp: now + 300,
	client_id: 'agent-one',
	azp: 'agent-one',
	organization_id: organizationId,
	workspace_id: workspaceId,
};

function ports(changes: Partial<SignInResponseReleasePorts> = {}): SignInResponseReleasePorts {
	return {
		issuer,
		toolPortalOrigin,
		requestedResource: agentAudience,
		managementAudience,
		centralAdminAudience: 'https://central.invalid/admin',
		ownerFleetCliClientId: 'owner-fleet-cli',
		accessTokenSeconds: 300,
		now: () => now * 1000,
		inspectSignedToken: (token: string): AccessTokenReleaseClaims =>
			accessTokenReleaseClaimsSchema.parse(decodeJwt(token)),
		readAgent: async () =>
			agentRegistrationSchema.parse({
				clientId: 'agent-one',
				metadata: { kind: 'agent', organizationId },
				grantTypes: ['client_credentials'],
				clientCredentialsScopes: ['tool-portal:agent'],
				tokenEndpointAuthMethod: 'client_secret_basic',
				resourceIds: [agentAudience],
				disabled: false,
				registrationComplete: true,
			}),
		readWorkspaceResource: async (identifier: string) =>
			identifier === agentAudience
				? {
						identifier,
						metadata: { kind: 'workspace', organizationId, workspaceId },
						allowedScopes: ['tool-portal:agent'],
						customClaims: null,
						disabled: false,
					}
				: null,
		isPersonSessionActive: async () => true,
		isPersonOrganizationSessionActive: async () => true,
		deleteSession: async () => {},
		cleanupUnboundPerson: async () => {},
		...changes,
	};
}
async function tokenResponse(changes: Readonly<Record<string, unknown>> = {}): Promise<Response> {
	const token = await new SignJWT({ ...agentClaims, ...changes })
		.setProtectedHeader({ alg: 'EdDSA', typ: 'at+jwt' })
		.sign(keys.privateKey);
	return Response.json({ access_token: token, token_type: 'Bearer', expires_in: 300 });
}

describe('outer response release after the signing effect', () => {
	it('timestamps an active confirmation at its first session read before later awaited work advances the controlled clock', async () => {
		let currentTime = now * 1000;
		const firstReadTime = currentTime;
		const result = await releaseSignInResponse({
			response: Response.json({
				active: true,
				sub: 'owner-person',
				sid: 'owner-session',
				aud: managementAudience,
				exp: now + 300,
				organization_id: organizationId,
			}),
			tokenGrant: 'introspection',
			issuedSessions: [],
			createdUserIds: [],
			ports: ports({
				now: () => currentTime,
				isPersonOrganizationSessionActive: async () => {
					currentTime += 60_000;
					return true;
				},
			}),
		});
		expect(await result.json()).toEqual({
			active: true,
			sub: 'owner-person',
			sid: 'owner-session',
			aud: managementAudience,
			exp: now + 300,
			organization_id: organizationId,
			checkedAt: firstReadTime,
		});
	});
	it('releases the real signed token only when the current registration permits it', async () => {
		const response = await tokenResponse();
		const result = await releaseSignInResponse({
			response,
			tokenGrant: 'client_credentials',
			issuedSessions: [],
			createdUserIds: [],
			ports: ports(),
		});
		expect(result).toBe(response);
		expect(
			z.object({ access_token: z.string() }).parse(await result.json()).access_token,
		).toBeTypeOf('string');
	});
	it('withholds the signed token when removal is visible at the final read', async () => {
		const response = await tokenResponse();
		const current = await ports().readAgent('agent-one');
		const result = await releaseSignInResponse({
			response,
			tokenGrant: 'client_credentials',
			issuedSessions: [],
			createdUserIds: [],
			ports: ports({
				readAgent: async () => (current === null ? null : { ...current, disabled: true }),
			}),
		});
		expect(result.status).toBe(400);
		expect(await result.json()).toEqual({ error: 'invalid_client' });
	});
	it.each([
		{ organization_id: '22222222-2222-7222-8222-222222222222' },
		{ aud: managementAudience },
		{ sid: 'forged-person-session' },
		{ sub: 'different-agent' },
		{ azp: 'different-agent' },
		{ exp: now + 301 },
		{ exp: now },
	])('withholds signed conflicting or overlong claims %j', async (claims) => {
		const result = await releaseSignInResponse({
			response: await tokenResponse(claims),
			tokenGrant: 'client_credentials',
			issuedSessions: [],
			createdUserIds: [],
			ports: ports(),
		});
		expect(await result.json()).toEqual({ error: 'invalid_client' });
	});
	it('fails closed when the post-signing registration read is unavailable', async () => {
		const result = await releaseSignInResponse({
			response: await tokenResponse(),
			tokenGrant: 'client_credentials',
			issuedSessions: [],
			createdUserIds: [],
			ports: ports({
				readAgent: async () => {
					throw new Error('controlled read unavailable');
				},
			}),
		});
		expect(await result.json()).toEqual({ error: 'invalid_client' });
	});
	it('refuses a refresh credential beside a management token, even from the fleet CLI client', async () => {
		for (const client of ['owner-cli', 'owner-fleet-cli']) {
			const token = await new SignJWT({
				iss: issuer,
				sub: 'person-one',
				sid: 'session-one',
				aud: managementAudience,
				iat: now,
				exp: now + 300,
				client_id: client,
				azp: client,
				organization_id: organizationId,
			})
				.setProtectedHeader({ alg: 'EdDSA', typ: 'at+jwt' })
				.sign(keys.privateKey);
			const refused = await releaseSignInResponse({
				response: Response.json({ access_token: token, refresh_token: 'refresh-credential' }),
				tokenGrant: 'person',
				issuedSessions: [],
				createdUserIds: [],
				ports: ports({ requestedResource: managementAudience }),
			});
			expect([client, refused.status, await refused.json()]).toEqual([
				client,
				400,
				{ error: 'invalid_grant' },
			]);
		}
	});

	it('a person token requires its live Person and exact session', async () => {
		const result = await releaseSignInResponse({
			response: await tokenResponse({
				sub: 'owner-person',
				client_id: 'owner-cli',
				azp: 'owner-cli',
				sid: 'owner-session',
				aud: managementAudience,
			}),
			tokenGrant: 'person',
			issuedSessions: [],
			createdUserIds: [],
			ports: ports({ isPersonOrganizationSessionActive: async () => false }),
		});
		expect(await result.json()).toEqual({ error: 'invalid_grant' });
	});
	it('reports invalid_target when an unlink commits before the post-signing link read', async () => {
		const current = await ports().readAgent('agent-one');
		const result = await releaseSignInResponse({
			response: await tokenResponse(),
			tokenGrant: 'client_credentials',
			issuedSessions: [],
			createdUserIds: [],
			ports: ports({
				readAgent: async () => (current === null ? null : { ...current, resourceIds: [] }),
			}),
		});
		expect(await result.json()).toEqual({ error: 'invalid_target' });
	});
	it('reads resource organization again after signing instead of trusting the earlier client claim', async () => {
		const resource = await ports().readWorkspaceResource(agentAudience);
		const result = await releaseSignInResponse({
			response: await tokenResponse(),
			tokenGrant: 'client_credentials',
			issuedSessions: [],
			createdUserIds: [],
			ports: ports({
				readWorkspaceResource: async () =>
					resource === null
						? null
						: {
								...resource,
								metadata: {
									...resource.metadata,
									organizationId: '22222222-2222-7222-8222-222222222222',
								},
							},
			}),
		});
		expect(await result.json()).toEqual({ error: 'invalid_client' });
	});
	it('discards a signed workspace claim that does not match the requested resource row', async () => {
		const result = await releaseSignInResponse({
			response: await tokenResponse({ workspace_id: '44444444-4444-7444-8444-444444444444' }),
			tokenGrant: 'client_credentials',
			issuedSessions: [],
			createdUserIds: [],
			ports: ports(),
		});
		expect(await result.json()).toEqual({ error: 'invalid_client' });
	});
	it('requires the signed workspace claim even when the client and audience are correct', async () => {
		const result = await releaseSignInResponse({
			response: await tokenResponse({ workspace_id: undefined }),
			tokenGrant: 'client_credentials',
			issuedSessions: [],
			createdUserIds: [],
			ports: ports(),
		});
		expect(await result.json()).toEqual({ error: 'invalid_client' });
	});
	it('refuses a linked person code client at a workspace resource with invalid_target', async () => {
		const result = await releaseSignInResponse({
			response: await tokenResponse({
				sub: 'owner-person',
				client_id: 'owner-cli',
				azp: 'owner-cli',
				sid: 'owner-session',
			}),
			tokenGrant: 'person',
			issuedSessions: [],
			createdUserIds: [],
			ports: ports(),
		});
		expect(await result.json()).toEqual({ error: 'invalid_target' });
	});
	it('cleans an inserted session before refusing its cookie response', async () => {
		const sessions = new Set(['new-session']);
		const result = await releaseSignInResponse({
			response: new Response(null, {
				status: 302,
				headers: { 'set-cookie': 'session=synthetic-test-cookie' },
			}),
			tokenGrant: 'none',
			issuedSessions: [{ personId: 'new-person', sessionId: 'new-session' }],
			createdUserIds: [],
			ports: ports({
				isPersonSessionActive: async () => false,
				deleteSession: async (id: string): Promise<void> => {
					sessions.delete(id);
				},
			}),
		});
		expect(result.headers.has('set-cookie')).toBe(false);
		expect(await result.json()).toEqual({ error: 'not-allowed' });
		expect(sessions.size).toBe(0);
	});
});

describe('outer response release of a person-fleet token', () => {
	// Unit/integration boundary: the real outer fence with a signed fixture token. It proves the
	// fence calls the person-fleet check, not issuer or central behaviour.
	const adminAudience = 'https://central.invalid/admin';
	const nowMilliseconds = now * 1000;
	async function personFleetResponse(
		changes: Readonly<Record<string, unknown>> = {},
	): Promise<Response> {
		const token = await new SignJWT({
			iss: issuer,
			sub: '019a3dce-2000-7000-8000-0000000000a1',
			sid: '019a3dce-2000-7000-8000-0000000000a2',
			aud: adminAudience,
			iat: now,
			// Native expiry and the signed session deadline both stay future unless a case moves them.
			exp: now + 300,
			client_id: 'fleet-admin-client',
			azp: 'fleet-admin-client',
			cnf: { jkt: 'caller-key-thumbprint' },
			token_profile: 'person-fleet',
			organization_id: '019a3dce-2000-7000-8000-0000000000a3',
			authorization_subject_id: '019a3dce-2000-7000-8000-0000000000a4',
			person_revision: 1,
			organization_revision: 1,
			permission_policy_digest: 'd'.repeat(64),
			permissions: ['organization:view'],
			session_expires_at_ms: nowMilliseconds + 3_600_000,
			authorization_snapshot_at_ms: nowMilliseconds - 100_000,
			authorization_snapshot_valid_until_ms: nowMilliseconds + 200_000,
			...changes,
		})
			.setProtectedHeader({ alg: 'EdDSA', typ: 'at+jwt' })
			.sign(keys.privateKey);
		return Response.json({ access_token: token, token_type: 'DPoP', expires_in: 300 });
	}
	/** The same signed token with a refresh credential beside it, as Better Auth returns it. */
	async function withRefresh(response: Response): Promise<Response> {
		const body = z.record(z.string(), z.unknown()).parse(await response.json());
		return Response.json({ ...body, refresh_token: 'refresh-credential' });
	}
	async function release(response: Response): Promise<Response> {
		return releaseSignInResponse({
			response,
			tokenGrant: 'person',
			issuedSessions: [],
			createdUserIds: [],
			ports: ports({ centralAdminAudience: adminAudience }),
		});
	}

	it('releases a token inside its snapshot, session and native deadlines', async () => {
		const response = await personFleetResponse();
		expect(await release(response)).toBe(response);
	});

	it.each([
		{
			name: 'its snapshot deadline is reached exactly, while native exp and the session are future',
			changes: {
				authorization_snapshot_at_ms: nowMilliseconds - 300_000,
				authorization_snapshot_valid_until_ms: nowMilliseconds,
			},
		},
		{
			name: 'its snapshot deadline has passed, while native exp and the session are future',
			changes: {
				authorization_snapshot_at_ms: nowMilliseconds - 299_000,
				authorization_snapshot_valid_until_ms: nowMilliseconds - 1,
			},
		},
		{
			name: 'its signed session deadline is reached first',
			changes: { session_expires_at_ms: nowMilliseconds },
		},
		{ name: 'it has no key binding', changes: { cnf: undefined } },
	])('refuses at the outer fence when $name', async ({ changes }) => {
		const refused = await release(await personFleetResponse(changes));
		expect(refused.status).toBe(400);
		expect(await refused.json()).toEqual({ error: 'invalid_grant' });
	});

	it('releases a refresh credential only beside a key-bound person-fleet token for the fleet CLI', async () => {
		const response = await withRefresh(
			await personFleetResponse({ client_id: 'owner-fleet-cli', azp: 'owner-fleet-cli' }),
		);
		expect(await release(response)).toBe(response);
	});

	// Each conjunct of the refresh exception negated alone; the others stay true.
	const fleetCli = { client_id: 'owner-fleet-cli', azp: 'owner-fleet-cli' };
	it.each([
		{ conjunct: 'client', name: 'another client (the admin page)', changes: {} },
		{
			conjunct: 'profile',
			name: 'the fleet CLI with another token profile',
			changes: { ...fleetCli, token_profile: 'management' },
		},
		{
			conjunct: 'audience',
			name: 'the fleet CLI for another audience',
			changes: { ...fleetCli, aud: 'https://central.invalid/not-admin' },
		},
		{
			conjunct: 'key binding',
			name: 'the fleet CLI with no key binding',
			changes: { ...fleetCli, cnf: undefined },
		},
		{
			conjunct: 'key binding',
			name: 'the fleet CLI with a binding that names no key',
			changes: { ...fleetCli, cnf: {} },
		},
	])(
		'refuses a refresh credential ($conjunct): $name, releasing no credential',
		async ({ changes }) => {
			const refused = await release(await withRefresh(await personFleetResponse(changes)));
			const body: unknown = await refused.json();
			expect(refused.status).toBe(400);
			expect(body).toEqual({ error: 'invalid_grant' });
			expectNoIssuedCredentials(body);
		},
	);

	// The membership read is the last await before release. A token in bounds when the read starts
	// can pass a signed deadline while it waits, so release decides the deadlines again after it.
	// Each case makes one deadline the earliest; the others stay later.
	const deadlines = [
		{
			deadline: 'snapshot',
			at: nowMilliseconds + 100_000,
			changes: {
				authorization_snapshot_at_ms: nowMilliseconds - 100_000,
				authorization_snapshot_valid_until_ms: nowMilliseconds + 100_000,
			},
		},
		{
			deadline: 'session',
			at: nowMilliseconds + 100_000,
			changes: {
				authorization_snapshot_valid_until_ms: nowMilliseconds + 200_000,
				session_expires_at_ms: nowMilliseconds + 100_000,
			},
		},
		{
			deadline: 'native exp',
			at: (now + 300) * 1000,
			changes: {
				authorization_snapshot_at_ms: nowMilliseconds + 100,
				authorization_snapshot_valid_until_ms: nowMilliseconds + 300_100,
			},
		},
	] as const;
	async function releaseAcrossHeldMembershipRead(
		changes: Readonly<Record<string, unknown>>,
		readCompletesAt: number,
	): Promise<{
		readonly sent: Response;
		readonly released: Response;
		readonly membershipReads: number;
		readonly deletedSessions: readonly string[];
		readonly cleanedPersons: readonly string[];
	}> {
		let clock = nowMilliseconds;
		let membershipReads = 0;
		const deletedSessions: string[] = [];
		const cleanedPersons: string[] = [];
		const entered = Promise.withResolvers<void>();
		const held = Promise.withResolvers<boolean>();
		const sent = await withRefresh(await personFleetResponse({ ...fleetCli, ...changes }));
		const releasing = releaseSignInResponse({
			response: sent,
			tokenGrant: 'person',
			// One session and one new person issued alongside, so the refusal's cleanup is visible.
			issuedSessions: [{ personId: 'issued-person', sessionId: 'issued-session' }],
			createdUserIds: ['created-person'],
			ports: ports({
				centralAdminAudience: adminAudience,
				now: () => clock,
				isPersonOrganizationSessionActive: async () => {
					membershipReads += 1;
					entered.resolve();
					return held.promise;
				},
				deleteSession: async (sessionId) => {
					deletedSessions.push(sessionId);
				},
				cleanupUnboundPerson: async (personId) => {
					cleanedPersons.push(personId);
				},
			}),
		});
		await entered.promise;
		clock = readCompletesAt;
		held.resolve(true);
		return { sent, released: await releasing, membershipReads, deletedSessions, cleanedPersons };
	}

	it.each(deadlines)(
		'releases when the membership read completes 1 ms before the $deadline deadline',
		async ({ at, changes }) => {
			const { sent, released, membershipReads, deletedSessions, cleanedPersons } =
				await releaseAcrossHeldMembershipRead(changes, at - 1);
			// The original signed response, untouched: no redated factor or snapshot.
			expect(released).toBe(sent);
			expect(membershipReads).toBe(1);
			expect([deletedSessions, cleanedPersons]).toEqual([[], []]);
		},
	);

	it.each(
		deadlines.flatMap((entry) => [
			{ ...entry, when: 'exactly at', readCompletesAt: entry.at },
			{ ...entry, when: '1 ms after', readCompletesAt: entry.at + 1 },
		]),
	)(
		'refuses, releasing no credential, when the membership read completes $when the $deadline deadline',
		async ({ changes, readCompletesAt }) => {
			const { released, membershipReads, deletedSessions, cleanedPersons } =
				await releaseAcrossHeldMembershipRead(changes, readCompletesAt);
			const body: unknown = await released.json();
			expect(released.status).toBe(400);
			expect(body).toEqual({ error: 'invalid_grant' });
			expectNoIssuedCredentials(body);
			// The refusal's existing cleanup contract, and no second membership read.
			expect(membershipReads).toBe(1);
			expect([deletedSessions, cleanedPersons]).toEqual([['issued-session'], ['created-person']]);
		},
	);
});
