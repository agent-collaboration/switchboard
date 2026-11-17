import {
	agentRegistrationSchema,
	releaseSignInResponse,
	type AccessTokenReleaseClaims,
	type AgentRegistration,
	type SignInResponseReleasePorts,
} from '@agent-collaboration/sign-in-core';
import * as hegel from '@hegeldev/hegel';
import * as generators from '@hegeldev/hegel/generators';
import { expect, it } from 'vitest';

// R33 / S8: the token-kind dispatch family. Every generated combination of grant, audience,
// client, refresh credential, body, claims, agent, resource, sessions and one throwing port is
// decided by releaseSignInResponse and by an independent model of the Program Design's 20-step
// table and its two rules. The model follows today's code (f3b2b88b); it never imports it.

const issuer = 'https://sign-in.invalid';
const toolPortalOrigin = 'https://portal.invalid';
const workspaceId = '33333333-3333-7333-8333-333333333333';
const otherWorkspaceId = '44444444-4444-7444-8444-444444444444';
const workspaceAudience = `${toolPortalOrigin}/workspaces/${workspaceId}/mcp`;
const managementAudience = 'https://portal.invalid/management';
const centralAdminAudience = 'https://central.invalid/admin';
const otherAudience = 'https://elsewhere.invalid/api';
const ownerFleetCliClientId = 'owner-fleet-cli';
const organizationId = '019a3dce-2000-7000-8000-0000000000a3';
const otherOrganizationId = '019a3dce-2000-7000-8000-0000000000b9';
const personSubject = '019a3dce-2000-7000-8000-0000000000a1';
const personSessionSubject = '019a3dce-2000-7000-8000-0000000000a2';
const accessTokenSeconds = 300;
/** The injected clock's first sample, in milliseconds. */
const firstClockSample = 1_800_000_000_000;
const snapshotValidUntil = firstClockSample + 200_000;

const grants = ['client_credentials', 'person', 'introspection', 'none'] as const;
type Grant = (typeof grants)[number];
type ThrowingPort =
	| 'none'
	| 'isPersonSessionActive'
	| 'now'
	| 'isPersonOrganizationSessionActive'
	| 'inspectSignedToken'
	| 'readAgent'
	| 'readWorkspaceResource'
	| 'deleteSession'
	| 'cleanupUnboundPerson';
type IntrospectionBody =
	| 'well-formed'
	| 'not-json'
	| 'active-missing'
	| 'active-not-boolean'
	| 'string-field-number'
	| 'exp-string';
interface IntrospectionFields {
	readonly active: boolean;
	readonly sub: boolean;
	readonly sid: boolean;
	readonly organization: boolean;
	readonly aud: 'management' | 'other' | 'missing';
	readonly exp: 'future' | 'past' | 'missing';
}
type TokenBody = 'well-formed' | 'not-json' | 'access-token-missing' | 'access-token-number';
type RefreshCredential = 'absent' | 'string' | 'null';
type Audience = 'workspace' | 'central-admin' | 'management' | 'other';
type Client = 'agent' | 'owner-fleet-cli' | 'other-person-client';
type ClaimsTiming = 'valid' | 'wrong-issuer' | 'passed' | 'too-long' | 'not-after-issued';
type AgentState =
	| 'valid'
	| 'missing'
	| 'disabled'
	| 'incomplete'
	| 'other-client'
	| 'other-organization';
type ResourceState =
	| 'valid'
	| 'missing'
	| 'no-policy'
	| 'other-identifier'
	| 'other-organization'
	| 'other-workspace';
/** The person-fleet decision on its two clock samples. "Names another person" can't be built:
 * the decision's person is parsed from the same claims' `sub`. */
type PersonFleetDecision = 'released' | 'refused' | 'released-then-refused';

interface ReleaseCase {
	readonly grant: Grant;
	readonly upstreamOk: boolean;
	readonly introspectionBody: IntrospectionBody;
	readonly introspection: IntrospectionFields;
	readonly tokenBody: TokenBody;
	readonly refresh: RefreshCredential;
	readonly audience: Audience;
	readonly client: Client;
	readonly timing: ClaimsTiming;
	readonly sidPresent: boolean;
	readonly organizationPresent: boolean;
	readonly workspacePresent: boolean;
	readonly subjectIsClient: boolean;
	readonly resourceRequested: boolean;
	readonly agent: AgentState;
	/** Whether the agent's own resources include the requested one (step 13). */
	readonly agentHoldsResource: boolean;
	readonly resource: ResourceState;
	readonly personFleet: PersonFleetDecision;
	readonly organizationSessionActive: boolean;
	/** One entry per session issued in this request: whether it is still active. */
	readonly sessions: readonly boolean[];
	readonly createdPeople: number;
	readonly throwingPort: ThrowingPort;
}

type Answer =
	| { readonly kind: 'pass-through' }
	| { readonly kind: 'json'; readonly status: number; readonly body: unknown };
type Outcome =
	| {
			readonly kind: 'resolved';
			readonly answer: Answer;
			readonly deletedSessions: readonly string[];
			readonly cleanedPeople: readonly string[];
	  }
	| {
			readonly kind: 'rejected';
			readonly deletedSessions: readonly string[];
			readonly cleanedPeople: readonly string[];
	  };
interface ModelDecision {
	readonly outcome: Outcome;
	/** Which steps and rules decided, for the coverage check. */
	readonly reached: readonly string[];
}

/** Mostly the valid choice, so deep steps are reached; each fault about one draw in four. */
function mostly<TChoice>(
	testCase: hegel.TestCase,
	valid: TChoice,
	faults: readonly TChoice[],
): TChoice {
	const roll = testCase.draw(generators.integers({ minValue: 0, maxValue: faults.length * 4 - 1 }));
	return faults[roll] ?? valid;
}

function drawReleaseCase(testCase: hegel.TestCase): ReleaseCase {
	const sessionCount = testCase.draw(generators.integers({ minValue: 0, maxValue: 2 }));
	const sessions = Array.from({ length: sessionCount }, (): boolean =>
		mostly(testCase, true, [false]),
	);
	const grant = testCase.draw(generators.sampledFrom(grants));
	// Each grant's own valid path is the likely draw, so its deepest steps are reached; every
	// other audience, client and sid choice stays reachable.
	const agentGrant = grant === 'client_credentials';
	return {
		grant,
		upstreamOk: mostly(testCase, true, [false]),
		introspectionBody: mostly<IntrospectionBody>(testCase, 'well-formed', [
			'not-json',
			'active-missing',
			'active-not-boolean',
			'string-field-number',
			'exp-string',
		]),
		introspection: {
			active: mostly(testCase, true, [false]),
			sub: mostly(testCase, true, [false]),
			sid: mostly(testCase, true, [false]),
			organization: mostly(testCase, true, [false]),
			aud: mostly<IntrospectionFields['aud']>(testCase, 'management', ['other', 'missing']),
			exp: mostly<IntrospectionFields['exp']>(testCase, 'future', ['past', 'missing']),
		},
		tokenBody: mostly<TokenBody>(testCase, 'well-formed', [
			'not-json',
			'access-token-missing',
			'access-token-number',
		]),
		refresh: testCase.draw(generators.sampledFrom(['absent', 'absent', 'string', 'null'] as const)),
		audience: agentGrant
			? mostly<Audience>(testCase, 'workspace', ['central-admin', 'management', 'other'])
			: testCase.draw(
					generators.sampledFrom(['workspace', 'central-admin', 'management', 'other'] as const),
				),
		client: agentGrant
			? mostly<Client>(testCase, 'agent', ['owner-fleet-cli', 'other-person-client'])
			: testCase.draw(
					generators.sampledFrom(['agent', 'owner-fleet-cli', 'other-person-client'] as const),
				),
		timing: mostly<ClaimsTiming>(testCase, 'valid', [
			'wrong-issuer',
			'passed',
			'too-long',
			'not-after-issued',
		]),
		sidPresent: mostly(testCase, !agentGrant, [agentGrant]),
		organizationPresent: mostly(testCase, true, [false]),
		workspacePresent: mostly(testCase, true, [false]),
		subjectIsClient: mostly(testCase, true, [false]),
		resourceRequested: mostly(testCase, true, [false]),
		agent: mostly<AgentState>(testCase, 'valid', [
			'missing',
			'disabled',
			'incomplete',
			'other-client',
			'other-organization',
		]),
		agentHoldsResource: mostly(testCase, true, [false]),
		resource: mostly<ResourceState>(testCase, 'valid', [
			'missing',
			'no-policy',
			'other-identifier',
			'other-organization',
			'other-workspace',
		]),
		personFleet: mostly<PersonFleetDecision>(testCase, 'released', [
			'refused',
			'released-then-refused',
		]),
		organizationSessionActive: mostly(testCase, true, [false]),
		sessions,
		createdPeople: testCase.draw(generators.integers({ minValue: 0, maxValue: 1 })),
		throwingPort: mostly<ThrowingPort>(testCase, 'none', [
			'isPersonSessionActive',
			'now',
			'isPersonOrganizationSessionActive',
			'inspectSignedToken',
			'readAgent',
			'readWorkspaceResource',
			'deleteSession',
			'cleanupUnboundPerson',
		]),
	};
}

const sessionIdsOf = (releaseCase: ReleaseCase): readonly string[] =>
	releaseCase.sessions.map((_, index) => `session-${index}`);
const peopleOf = (releaseCase: ReleaseCase): readonly string[] =>
	Array.from({ length: releaseCase.createdPeople }, (_, index) => `created-person-${index}`);

function wellFormedIntrospectionBody(fields: IntrospectionFields): Record<string, unknown> {
	return {
		active: fields.active,
		...(fields.sub ? { sub: personSubject } : {}),
		...(fields.sid ? { sid: personSessionSubject } : {}),
		...(fields.organization ? { organization_id: organizationId } : {}),
		...(fields.aud === 'management'
			? { aud: managementAudience }
			: fields.aud === 'other'
				? { aud: otherAudience }
				: {}),
		...(fields.exp === 'future'
			? { exp: firstClockSample / 1000 + 300 }
			: fields.exp === 'past'
				? { exp: firstClockSample / 1000 - 1_000 }
				: {}),
	};
}

/** A decision that answers without any cleanup. */
function answer(result: Answer, step: string): ModelDecision {
	return {
		outcome: { kind: 'resolved', answer: result, deletedSessions: [], cleanedPeople: [] },
		reached: [step],
	};
}

/** Introspection's `{"active": false}`, with no cleanup. */
function inactive(step: string): ModelDecision {
	return answer({ kind: 'json', status: 200, body: { active: false } }, step);
}

/** The upstream response, unchanged. */
function passThrough(step: string): ModelDecision {
	return answer({ kind: 'pass-through' }, step);
}

type Refusal = 'invalid_client' | 'invalid_target' | 'invalid_grant' | 'not-allowed';
type TokenGrant = Extract<Grant, 'client_credentials' | 'person'>;

/** A refusal's status: 403 for not-allowed, 400 for the OAuth errors. */
function refusalStatus(error: Refusal): 400 | 403 {
	switch (error) {
		case 'not-allowed':
			return 403;
		case 'invalid_client':
		case 'invalid_target':
		case 'invalid_grant':
			return 400;
		default:
			return error satisfies never;
	}
}

/** Which cleanup, if any, rejects when the generated port is the one that throws. */
function rejectingCleanup(port: ThrowingPort): 'delete' | 'cleanup' | null {
	switch (port) {
		case 'deleteSession':
			return 'delete';
		case 'cleanupUnboundPerson':
			return 'cleanup';
		case 'none':
		case 'isPersonSessionActive':
		case 'now':
		case 'isPersonOrganizationSessionActive':
		case 'inspectSignedToken':
		case 'readAgent':
		case 'readWorkspaceResource':
			return null;
		default:
			return port satisfies never;
	}
}

/** The refusal code a thrown read or a malformed token body gives each token grant. */
function invalidFor(grant: TokenGrant | 'none'): Refusal {
	switch (grant) {
		case 'client_credentials':
			return 'invalid_client';
		case 'person':
		case 'none':
			return 'invalid_grant';
		default:
			return grant satisfies never;
	}
}

function introspectionBodyIsWellFormed(body: IntrospectionBody): boolean {
	switch (body) {
		case 'well-formed':
			return true;
		case 'not-json':
		case 'active-missing':
		case 'active-not-boolean':
		case 'string-field-number':
		case 'exp-string':
			return false;
		default:
			return body satisfies never;
	}
}

function tokenBodyIsWellFormed(body: TokenBody): boolean {
	switch (body) {
		case 'well-formed':
			return true;
		case 'not-json':
		case 'access-token-missing':
		case 'access-token-number':
			return false;
		default:
			return body satisfies never;
	}
}

function claimsTimingIsValid(timing: ClaimsTiming): boolean {
	switch (timing) {
		case 'valid':
			return true;
		case 'wrong-issuer':
		case 'passed':
		case 'too-long':
		case 'not-after-issued':
			return false;
		default:
			return timing satisfies never;
	}
}

/** Step 10: whether the registration admits the agent at all. */
function agentIsRegistered(agent: AgentState): boolean {
	switch (agent) {
		case 'valid':
			return true;
		case 'missing':
		case 'disabled':
		case 'incomplete':
		case 'other-client':
		case 'other-organization':
			return false;
		default:
			return agent satisfies never;
	}
}

/** Steps 11-12 for the requested resource. */
function resourceStanding(resource: ResourceState): 'matches' | 'no-target' | 'mismatched' {
	switch (resource) {
		case 'valid':
			return 'matches';
		case 'missing':
		case 'no-policy':
			return 'no-target';
		case 'other-identifier':
		case 'other-organization':
		case 'other-workspace':
			return 'mismatched';
		default:
			return resource satisfies never;
	}
}

/** The decision table and its two rules (Program Design, "How the model walks"). */
function modelRelease(releaseCase: ReleaseCase): ModelDecision {
	const throws = (port: ThrowingPort): boolean => releaseCase.throwingPort === port;
	const sessionIds = sessionIdsOf(releaseCase);
	const people = peopleOf(releaseCase);
	// Rule 2: delete every issued session at once; only when all succeed, clean up every created
	// person; then answer. A rejected cleanup leaves no answer: the release itself rejects.
	const refuse = (error: Refusal, step: string): ModelDecision => {
		const rejecting = rejectingCleanup(releaseCase.throwingPort);
		if (rejecting === 'delete' && sessionIds.length > 0)
			return {
				outcome: { kind: 'rejected', deletedSessions: sessionIds, cleanedPeople: [] },
				reached: [step, 'rule-2-delete-rejects'],
			};
		if (rejecting === 'cleanup' && people.length > 0)
			return {
				outcome: { kind: 'rejected', deletedSessions: sessionIds, cleanedPeople: people },
				reached: [step, 'rule-2-cleanup-rejects'],
			};
		return {
			outcome: {
				kind: 'resolved',
				answer: { kind: 'json', status: refusalStatus(error), body: { error } },
				deletedSessions: sessionIds,
				cleanedPeople: people,
			},
			reached: [step],
		};
	};
	const grant = releaseCase.grant;
	// Rule 1: a thrown read decides at once, ahead of every later step.
	const thrownRead = (): ModelDecision => {
		switch (grant) {
			case 'introspection':
				return inactive('rule-1-introspection');
			case 'client_credentials':
			case 'person':
			case 'none':
				return refuse(invalidFor(grant), 'rule-1-refusal');
			default:
				return grant satisfies never;
		}
	};

	// Steps 1-4.
	const introspect = (): ModelDecision => {
		if (!releaseCase.upstreamOk) return passThrough('step-5');
		if (!introspectionBodyIsWellFormed(releaseCase.introspectionBody)) return inactive('step-1');
		const fields = releaseCase.introspection;
		if (!fields.active) return passThrough('step-2');
		if (throws('now')) return thrownRead();
		if (
			!fields.sub ||
			!fields.sid ||
			!fields.organization ||
			fields.aud !== 'management' ||
			fields.exp !== 'future'
		)
			return inactive('step-3');
		if (throws('isPersonOrganizationSessionActive')) return thrownRead();
		if (!releaseCase.organizationSessionActive) return inactive('step-3');
		return answer(
			{
				kind: 'json',
				status: 200,
				body: { ...wellFormedIntrospectionBody(fields), checkedAt: firstClockSample },
			},
			'step-4',
		);
	};

	// Steps 9-14.
	const releaseAgentToken = (): ModelDecision => {
		if (
			releaseCase.sidPresent ||
			!releaseCase.organizationPresent ||
			!releaseCase.workspacePresent ||
			!releaseCase.resourceRequested ||
			releaseCase.audience !== 'workspace' ||
			!releaseCase.subjectIsClient
		)
			return refuse('invalid_client', 'step-9');
		if (throws('readAgent')) return thrownRead();
		if (!agentIsRegistered(releaseCase.agent) || releaseCase.client !== 'agent')
			return refuse('invalid_client', 'step-10');
		if (throws('readWorkspaceResource')) return thrownRead();
		const standing = resourceStanding(releaseCase.resource);
		switch (standing) {
			case 'no-target':
				return refuse('invalid_target', 'step-11');
			case 'mismatched':
				return refuse('invalid_client', 'step-12');
			case 'matches':
				if (!releaseCase.agentHoldsResource) return refuse('invalid_target', 'step-13');
				return passThrough('step-14');
			default:
				return standing satisfies never;
		}
	};

	// Steps 16-17: a person-fleet token for central's admin audience.
	const releasePersonFleetToken = (): ModelDecision => {
		const decision = releaseCase.personFleet;
		switch (decision) {
			case 'refused':
				return refuse('invalid_grant', 'step-16');
			case 'released':
			case 'released-then-refused':
				if (throws('isPersonOrganizationSessionActive')) return thrownRead();
				if (!releaseCase.organizationSessionActive) return refuse('invalid_grant', 'step-16');
				// The fresh clock sample after the awaited membership read refuses the second time.
				if (decision === 'released-then-refused') return refuse('invalid_grant', 'step-16');
				return passThrough('step-17');
			default:
				return decision satisfies never;
		}
	};

	// Steps 15-19.
	const releasePersonToken = (): ModelDecision => {
		if (throws('readWorkspaceResource')) return thrownRead();
		const audience = releaseCase.audience;
		switch (audience) {
			case 'workspace':
				if (releaseCase.resource !== 'missing') return refuse('invalid_target', 'step-15');
				return refuse('invalid_grant', 'step-18');
			case 'central-admin':
				return releasePersonFleetToken();
			case 'other':
				return refuse('invalid_grant', 'step-18');
			case 'management':
				if (!releaseCase.sidPresent || !releaseCase.organizationPresent)
					return refuse('invalid_grant', 'step-18');
				if (throws('isPersonOrganizationSessionActive')) return thrownRead();
				if (!releaseCase.organizationSessionActive) return refuse('invalid_grant', 'step-18');
				return passThrough('step-19');
			default:
				return audience satisfies never;
		}
	};

	// Steps 6-8, then the grant's own steps.
	const releaseToken = (tokenGrant: TokenGrant): ModelDecision => {
		if (!releaseCase.upstreamOk) return passThrough('step-5');
		if (!tokenBodyIsWellFormed(releaseCase.tokenBody))
			return refuse(invalidFor(tokenGrant), 'step-6');
		if (throws('inspectSignedToken')) return thrownRead();
		const refreshAdmitted =
			tokenGrant === 'person' &&
			releaseCase.audience === 'central-admin' &&
			releaseCase.client === 'owner-fleet-cli';
		if (releaseCase.refresh !== 'absent' && !refreshAdmitted)
			return refuse('invalid_grant', 'step-7');
		if (throws('now')) return thrownRead();
		if (!claimsTimingIsValid(releaseCase.timing)) return refuse(invalidFor(tokenGrant), 'step-8');
		switch (tokenGrant) {
			case 'client_credentials':
				return releaseAgentToken();
			case 'person':
				return releasePersonToken();
			default:
				return tokenGrant satisfies never;
		}
	};

	// Step 0.
	if (releaseCase.sessions.length > 0) {
		if (throws('isPersonSessionActive')) return thrownRead();
		if (releaseCase.sessions.some((active) => !active)) return refuse('not-allowed', 'step-0');
	}
	switch (grant) {
		case 'introspection':
			return introspect();
		case 'none':
			return passThrough('step-5');
		case 'client_credentials':
		case 'person':
			return releaseToken(grant);
		default:
			return grant satisfies never;
	}
}

const audiences: Readonly<Record<Audience, string>> = {
	workspace: workspaceAudience,
	'central-admin': centralAdminAudience,
	management: managementAudience,
	other: otherAudience,
};
const clientIds: Readonly<Record<Client, string>> = {
	agent: 'agent-one',
	'owner-fleet-cli': ownerFleetCliClientId,
	'other-person-client': 'person-web-client',
};
const claimTimes: Readonly<Record<ClaimsTiming, { readonly iat: number; readonly exp: number }>> = {
	valid: { iat: 1_799_999_990, exp: 1_800_000_290 },
	'wrong-issuer': { iat: 1_799_999_990, exp: 1_800_000_290 },
	passed: { iat: 1_799_999_000, exp: 1_799_999_300 },
	'too-long': { iat: 1_799_999_990, exp: 1_800_000_291 },
	'not-after-issued': { iat: 1_800_000_100, exp: 1_800_000_100 },
};

function signedClaimsFor(releaseCase: ReleaseCase): AccessTokenReleaseClaims {
	const clientId = clientIds[releaseCase.client];
	const subject = releaseCase.subjectIsClient ? clientId : personSubject;
	const personFleet = releaseCase.grant === 'person' && releaseCase.audience === 'central-admin';
	return {
		iss: releaseCase.timing === 'wrong-issuer' ? 'https://forged.invalid' : issuer,
		sub: subject,
		aud: audiences[releaseCase.audience],
		...claimTimes[releaseCase.timing],
		client_id: clientId,
		azp: subject,
		// A person-fleet token always carries its session and organization.
		...(releaseCase.sidPresent || personFleet ? { sid: personSessionSubject } : {}),
		...(releaseCase.organizationPresent || personFleet ? { organization_id: organizationId } : {}),
		...(releaseCase.workspacePresent ? { workspace_id: workspaceId } : {}),
		...(personFleet
			? {
					token_profile: 'person-fleet',
					authorization_subject_id: '019a3dce-2000-7000-8000-0000000000a4',
					person_revision: 1,
					organization_revision: 1,
					permission_policy_digest: 'd'.repeat(64),
					permissions: ['organization:view'],
					session_expires_at_ms: firstClockSample + 3_600_000,
					authorization_snapshot_at_ms: firstClockSample - 100_000,
					authorization_snapshot_valid_until_ms: snapshotValidUntil,
					// Without its key binding the profile is invalid, so the decision refuses.
					...(releaseCase.personFleet === 'refused' ? {} : { cnf: { jkt: 'cli-key-thumbprint' } }),
				}
			: {}),
	};
}

function agentFor(state: AgentState, holdsResource: boolean): AgentRegistration | null {
	if (state === 'missing') return null;
	return agentRegistrationSchema.parse({
		clientId: state === 'other-client' ? 'agent-two' : 'agent-one',
		metadata: {
			kind: 'agent',
			organizationId: state === 'other-organization' ? otherOrganizationId : organizationId,
		},
		grantTypes: ['client_credentials'],
		clientCredentialsScopes: ['tool-portal:agent'],
		tokenEndpointAuthMethod: 'client_secret_basic',
		resourceIds: [
			holdsResource ? workspaceAudience : `${toolPortalOrigin}/workspaces/${otherWorkspaceId}/mcp`,
		],
		disabled: state === 'disabled',
		registrationComplete: state !== 'incomplete',
	});
}

type WorkspaceResourceRecord = Awaited<
	ReturnType<SignInResponseReleasePorts['readWorkspaceResource']>
>;
function resourceFor(state: ResourceState, identifier: string): WorkspaceResourceRecord {
	if (identifier !== workspaceAudience || state === 'missing') return null;
	return {
		identifier: state === 'other-identifier' ? `${workspaceAudience}/other` : identifier,
		metadata: {
			kind: 'workspace',
			organizationId: state === 'other-organization' ? otherOrganizationId : organizationId,
			workspaceId: state === 'other-workspace' ? otherWorkspaceId : workspaceId,
		},
		allowedScopes: [state === 'no-policy' ? 'tool-portal:other' : 'tool-portal:agent'],
		customClaims: null,
		disabled: false,
	};
}

function upstreamResponse(releaseCase: ReleaseCase): Response {
	if (!releaseCase.upstreamOk) return Response.json({ error: 'invalid_token' }, { status: 401 });
	if (releaseCase.grant === 'introspection') {
		switch (releaseCase.introspectionBody) {
			case 'well-formed':
				return Response.json(wellFormedIntrospectionBody(releaseCase.introspection));
			case 'not-json':
				return new Response('not json');
			case 'active-missing':
				return Response.json({ sub: personSubject });
			case 'active-not-boolean':
				return Response.json({ active: 'yes' });
			case 'string-field-number':
				return Response.json({ active: true, sub: 7 });
			case 'exp-string':
				return Response.json({ active: true, exp: '9' });
			default:
				return releaseCase.introspectionBody satisfies never;
		}
	}
	const refresh =
		releaseCase.refresh === 'string'
			? { refresh_token: 'refresh-credential' }
			: releaseCase.refresh === 'null'
				? { refresh_token: null }
				: {};
	switch (releaseCase.tokenBody) {
		case 'well-formed':
			return Response.json({
				access_token: 'signed-access-token',
				token_type: 'Bearer',
				...refresh,
			});
		case 'not-json':
			return new Response('not json');
		case 'access-token-missing':
			return Response.json({ token_type: 'Bearer', ...refresh });
		case 'access-token-number':
			return Response.json({ access_token: 7, token_type: 'Bearer', ...refresh });
		default:
			return releaseCase.tokenBody satisfies never;
	}
}

/** The real release with ports built from the case; a rejection is an observed outcome. */
async function observeRelease(releaseCase: ReleaseCase): Promise<Outcome> {
	let currentTime = firstClockSample;
	const deletedSessions: string[] = [];
	const cleanedPeople: string[] = [];
	const failIf = (port: ThrowingPort): void => {
		if (releaseCase.throwingPort === port) throw new Error(`generated ${port} failure`);
	};
	const claims = signedClaimsFor(releaseCase);
	const issuedSessions = sessionIdsOf(releaseCase).map((sessionId, index) => ({
		personId: `issued-person-${index}`,
		sessionId,
	}));
	const ports: SignInResponseReleasePorts = {
		issuer,
		toolPortalOrigin,
		requestedResource: releaseCase.resourceRequested ? workspaceAudience : null,
		managementAudience,
		centralAdminAudience,
		ownerFleetCliClientId,
		accessTokenSeconds,
		now: () => {
			failIf('now');
			return currentTime;
		},
		inspectSignedToken: () => {
			failIf('inspectSignedToken');
			return claims;
		},
		readAgent: async () => {
			failIf('readAgent');
			return agentFor(releaseCase.agent, releaseCase.agentHoldsResource);
		},
		readWorkspaceResource: async (identifier) => {
			failIf('readWorkspaceResource');
			return resourceFor(releaseCase.resource, identifier);
		},
		isPersonSessionActive: async (_personId, sessionId) => {
			failIf('isPersonSessionActive');
			return releaseCase.sessions[sessionIdsOf(releaseCase).indexOf(sessionId)] === true;
		},
		isPersonOrganizationSessionActive: async () => {
			failIf('isPersonOrganizationSessionActive');
			// The awaited read lets the snapshot deadline pass before the fresh clock sample.
			if (releaseCase.personFleet === 'released-then-refused') currentTime = snapshotValidUntil;
			return releaseCase.organizationSessionActive;
		},
		deleteSession: async (sessionId) => {
			deletedSessions.push(sessionId);
			failIf('deleteSession');
		},
		cleanupUnboundPerson: async (personId) => {
			cleanedPeople.push(personId);
			failIf('cleanupUnboundPerson');
		},
	};
	const response = upstreamResponse(releaseCase);
	try {
		const released = await releaseSignInResponse({
			response,
			tokenGrant: releaseCase.grant,
			issuedSessions,
			createdUserIds: peopleOf(releaseCase),
			ports,
		});
		const releasedAnswer: Answer =
			released === response
				? { kind: 'pass-through' }
				: { kind: 'json', status: released.status, body: await released.json() };
		return { kind: 'resolved', answer: releasedAnswer, deletedSessions, cleanedPeople };
	} catch {
		return { kind: 'rejected', deletedSessions, cleanedPeople };
	}
}

const everyStepAndRule = [
	...Array.from({ length: 20 }, (_, step) => `step-${step}`),
	'rule-1-introspection',
	'rule-1-refusal',
	'rule-2-delete-rejects',
	'rule-2-cleanup-rejects',
] as const;

it('the token-kind dispatch decides every generated grant, audience, client and failure as its model does', async () => {
	// Arrange
	const reached = new Set<string>();
	// Act / Assert: each case's real outcome equals the model's.
	await hegel.testAsync(
		async (testCase) => {
			const releaseCase = drawReleaseCase(testCase);
			const expected = modelRelease(releaseCase);
			for (const label of expected.reached) reached.add(label);
			expect(await observeRelease(releaseCase)).toEqual(expected.outcome);
		},
		{ testCases: 10_000, derandomize: true, database: hegel.Database.disabled },
	);
	// Assert: the generation reached every step of the table and both rules.
	expect(everyStepAndRule.filter((label) => !reached.has(label))).toEqual([]);
});
