import {
	createMemoryProofKeyStore,
	requireFleetTarget,
	signInFleetCli,
} from '@agent-collaboration/sign-in-owner-cli';
import { expect } from 'vitest';
import { z } from 'zod';

import { controlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-sign-in-clock';
import { tokenForCurrentOwnerSession } from '#sign-in-test-support/test-fixtures/current-session-owner-token';
import { fleetCliIoFor } from '#sign-in-test-support/test-fixtures/fleet-cli-fixture';
import {
	agentAudience,
	registrationRequestId,
	workspaceOne,
} from '#sign-in-test-support/test-fixtures/local-auth-configuration';
import {
	expectUnchangedOrganizationRead,
	organizationReadCounts,
	requestOrganizationRead,
	runOrganizationReadCases,
	type OrganizationReadKind,
	type OrganizationReadScenario,
} from '#sign-in-test-support/test-fixtures/organization-read-scenario';
import { webSignInCrypto } from '#sign-in-test-support/test-fixtures/recording-sign-in-capabilities';

/** All three credentials are issued on the current production path; only browser navigation is driven. */
export async function expectOrganizationReadBearerRefusals(
	scenario: OrganizationReadScenario,
	kind: OrganizationReadKind,
): Promise<void> {
	const { harness } = scenario;
	const personToken = await tokenForCurrentOwnerSession(harness);
	const registered = await harness.gateway(`/management/workspaces/${workspaceOne}/agents`, {
		method: 'POST',
		headers: { authorization: `Bearer ${personToken}`, 'content-type': 'application/json' },
		body: JSON.stringify({ requestId: registrationRequestId, persona: 'operator' }),
	});
	expect(registered.status).toBe(200);
	const credentials = z
		.object({
			kind: z.literal('registered'),
			clientId: z.string().min(1),
			clientSecret: z.string().min(1),
		})
		.parse(await registered.json());
	const issued = await harness.auth('/api/auth/oauth2/token', {
		method: 'POST',
		headers: {
			authorization: `Basic ${btoa(`${credentials.clientId}:${credentials.clientSecret}`)}`,
			'content-type': 'application/x-www-form-urlencoded',
		},
		body: new URLSearchParams({
			grant_type: 'client_credentials',
			scope: 'tool-portal:agent',
			resource: agentAudience,
		}),
	});
	expect(issued.status).toBe(200);
	const agentToken = z
		.object({ access_token: z.string().min(1) })
		.parse(await issued.json()).access_token;
	const fleetSession = await signInFleetCli({
		target: requireFleetTarget({ ...harness.target, organizationId: scenario.organizationId }),
		store: createMemoryProofKeyStore(webSignInCrypto),
		io: fleetCliIoFor({
			harness,
			cookie: scenario.ownerCookie,
			now: controlledSignInClock.now,
			sent: [],
		}),
	});
	await runOrganizationReadCases(
		[personToken, agentToken, fleetSession.accessToken],
		async (bearer): Promise<void> => {
			const counts = await organizationReadCounts(harness);
			await expectUnchangedOrganizationRead({
				harness,
				request: () =>
					requestOrganizationRead({
						scenario,
						kind,
						cookie: '',
						headers: { authorization: `Bearer ${bearer}` },
					}),
				status: 401,
				body: { kind: 'refused' },
			});
			expect(await organizationReadCounts(harness)).toEqual(counts);
		},
	);
}
