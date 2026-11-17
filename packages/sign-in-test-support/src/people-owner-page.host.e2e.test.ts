import { fileURLToPath } from 'node:url';

import { member, organization } from '@agent-collaboration/sign-in-core';
import { organizationPersonTokenClaimsSchema } from '@agent-collaboration/sign-in-core/person-identity';
import { eq } from 'drizzle-orm';
import { decodeJwt } from 'jose';
import { expect, it } from 'vitest';
import { z } from 'zod';

import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import {
	controlledSignInClock,
	controlledSignInIds,
} from '#sign-in-test-support/test-fixtures/controlled-sign-in-clock';
import { startLocalAuthHarness } from '#sign-in-test-support/test-fixtures/local-auth-harness';
import { loginThroughNativeOwnerCli } from '#sign-in-test-support/test-fixtures/native-cli-proof';
import {
	createServedOwnerBrowser,
	type ServedOwnerObservation,
} from '#sign-in-test-support/test-fixtures/served-owner-browser';

useControlledSignInClock();
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));

it('people: served first-login pages keep the original CLI authorization through app setup, rotated cookie and organization creation', async () => {
	const harness = await startLocalAuthHarness();
	const observations: ServedOwnerObservation[] = [];
	try {
		const token = await loginThroughNativeOwnerCli({
			target: harness.target,
			repositoryRoot,
			browser: createServedOwnerBrowser({
				harness,
				email: 'owner@example.invalid',
				organization: { name: 'Created through the page', slug: 'page-first-owner' },
				observe: (event): void => {
					observations.push(event);
				},
			}),
		});
		// The delivered CLI verified the signature, original state/PKCE loopback
		// and live session before returning this private-cache credential.
		const claims = organizationPersonTokenClaimsSchema.parse(decodeJwt(token));
		const confirmation = observations.find((event) => event.kind === 'app-confirmed');
		if (confirmation?.kind !== 'app-confirmed')
			throw new Error('The served app confirmation was not observed');
		expect(confirmation.afterSessionId).not.toBe(confirmation.beforeSessionId);
		expect(claims.sid).toBe(confirmation.afterSessionId);
		expect(claims.second_factor_method).toBe('app');
		expect(
			await harness.database
				.select({ id: organization.id, name: organization.name })
				.from(organization),
		).toEqual([{ id: claims.organization_id, name: 'Created through the page' }]);
		expect(
			await harness.database
				.select({ organizationId: member.organizationId, role: member.role })
				.from(member),
		).toEqual([{ organizationId: claims.organization_id, role: 'owner' }]);
	} finally {
		await harness.close();
	}
});

it('people: the delivered chooser refuses a foreign organization and issues for the selected real membership after fresh social sign-in', async () => {
	const harness = await startLocalAuthHarness();
	const observations: ServedOwnerObservation[] = [];
	try {
		const initial = organizationPersonTokenClaimsSchema.parse(
			decodeJwt(await harness.ownerToken()),
		);
		const created = await harness.auth('/api/auth/organization/create', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ name: 'Second membership', slug: 'second-page-membership' }),
		});
		expect(created.status).toBe(200);
		const second = z.object({ id: z.uuidv7() }).parse(await created.json());
		expect(second.id).not.toBe(initial.organization_id);
		// An existing foreign organization is an adversarial fixture precondition,
		// not an admitted membership or a substitute for native set-active checks.
		const foreignOrganizationId = controlledSignInIds.nextId();
		await harness.database.insert(organization).values({
			id: foreignOrganizationId,
			name: 'Foreign organization',
			slug: 'foreign-page-membership',
			fleetState: 'settingUp',
			createdAt: new Date(controlledSignInClock.now()),
		});
		const token = await loginThroughNativeOwnerCli({
			target: harness.target,
			repositoryRoot,
			browser: createServedOwnerBrowser({
				harness,
				email: 'owner@example.invalid',
				selection: { organizationId: initial.organization_id, foreignOrganizationId },
				observe: (event): void => {
					observations.push(event);
				},
			}),
		});
		const claims = organizationPersonTokenClaimsSchema.parse(decodeJwt(token));
		expect(claims.organization_id).toBe(initial.organization_id);
		expect(claims.sid).not.toBe(initial.sid);
		expect(observations).toContainEqual({ kind: 'foreign-organization-refused', status: 403 });
		expect(
			await harness.database
				.select({ personId: member.userId })
				.from(member)
				.where(eq(member.organizationId, foreignOrganizationId)),
		).toEqual([]);
	} finally {
		await harness.close();
	}
});
