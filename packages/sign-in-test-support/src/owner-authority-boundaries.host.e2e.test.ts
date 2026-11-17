import * as signInTables from '@agent-collaboration/sign-in-core';
import { eq, sql as fixtureSql } from 'drizzle-orm';
import { decodeJwt } from 'jose';
import { expect, it } from 'vitest';
import { z } from 'zod';

import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import { controlledSignInIds } from '#sign-in-test-support/test-fixtures/controlled-sign-in-clock';
import {
	organizationOne,
	registeredClientId,
	registrationRequestId,
	startLocalAuthHarness,
	workspaceOne,
} from '#sign-in-test-support/test-fixtures/local-auth-harness';
import { inviteLocalPerson } from '#sign-in-test-support/test-fixtures/local-owner-organization';
import { storedRowProjection } from '#sign-in-test-support/test-fixtures/stored-row-projection';

useControlledSignInClock();

it('agent: real non-owner E7, forged actor input and public binding URLs never acquire owner authority across concurrent requests', async () => {
	const harness = await startLocalAuthHarness();
	try {
		const owner = await harness.ownerToken();
		const ownerPerson = z.object({ sub: z.string(), sid: z.string() }).parse(decodeJwt(owner));
		const endpoint = `/management/workspaces/${workspaceOne}/agents`;
		const legitimate = {
			method: 'POST',
			headers: { authorization: `Bearer ${owner}`, 'content-type': 'application/json' },
			body: JSON.stringify({ requestId: registrationRequestId, persona: 'operator' }),
		};
		expect((await harness.gateway(endpoint, legitimate)).status).toBe(200);
		await inviteLocalPerson({
			auth: harness.auth,
			database: harness.database,
			email: 'member@example.invalid',
		});
		const member = await harness.personToken('member@example.invalid');
		const memberPerson = z.object({ sub: z.string(), sid: z.string() }).parse(decodeJwt(member));
		expect(memberPerson.sub).not.toBe(ownerPerson.sub);
		expect(
			await harness.database
				.select({ user_id: fixtureSql`${signInTables.member.userId}` })
				.from(signInTables.member)
				.where(eq(signInTables.member.role, 'owner')),
		).toEqual([{ user_id: ownerPerson.sub }]);
		async function clientRows(): Promise<readonly Record<string, unknown>[]> {
			return await harness.database
				.select(storedRowProjection(signInTables.oauthClient))
				.from(signInTables.oauthClient)
				.orderBy(signInTables.oauthClient.clientId);
		}
		const initialClients = await clientRows();
		const rowsBefore = initialClients.map(({ clientId, metadata, grantTypes }) => ({
			clientId,
			metadata,
			grantTypes,
		}));
		const admissionBefore = await (
			await harness.gateway(`/__auth-proof?workspace=${workspaceOne}&client=${registeredClientId}`)
		).json();
		const forgedHeaders = {
			authorization: `Bearer ${member}`,
			'content-type': 'application/json',
			'x-owner-id': ownerPerson.sub,
			'x-actor-id': ownerPerson.sub,
			'x-organization-id': organizationOne,
		};
		const responses = await Promise.all([
			harness.gateway(endpoint, {
				method: 'POST',
				headers: forgedHeaders,
				body: JSON.stringify({ requestId: controlledSignInIds.nextId(), persona: 'operator' }),
			}),
			harness.gateway(`${endpoint}/${registeredClientId}`, { headers: forgedHeaders }),
			harness.gateway(`${endpoint}/${registeredClientId}`, {
				method: 'DELETE',
				headers: forgedHeaders,
				body: JSON.stringify({ requestId: controlledSignInIds.nextId(), persona: 'operator' }),
			}),
		]);
		expect(responses.map((response) => response.status)).toEqual([403, 403, 403]);
		const forgedBody = await harness.gateway(endpoint, {
			method: 'POST',
			headers: forgedHeaders,
			body: JSON.stringify({
				requestId: controlledSignInIds.nextId(),
				actor: ownerPerson.sub,
				owner: true,
				organizationId: organizationOne,
			}),
		});
		expect([400, 403].includes(forgedBody.status)).toBe(true);
		const publicResponses = await Promise.all(
			[
				'/changeClient',
				'/isLiveOwner',
				'/AgentClientManagement/changeClient',
				'/api/auth/AgentClientManagement/changeClient',
				...[
					'registerAndLink',
					'link',
					'unlink',
					'disable',
					'isLiveOwner',
					'ownsAgentClient',
					'humanCheckStatus',
				].flatMap((method: string): readonly string[] => [
					`/${method}`,
					`/AgentClientManagement/${method}`,
					`/api/auth/AgentClientManagement/${method}`,
				]),
			].map((pathname) =>
				harness.auth(pathname, {
					method: 'POST',
					headers: { ...forgedHeaders, cookie: '' },
					body: JSON.stringify({
						actor: ownerPerson.sub,
						owner: true,
						organizationId: organizationOne,
					}),
				}),
			),
		);
		expect(publicResponses.every((response) => [403, 404].includes(response.status))).toBe(true);
		// A public request cannot install or trigger the named-entry-only observer.
		const publicHoldId = controlledSignInIds.nextId();
		await Promise.all(
			[
				'/__auth-proof/management/arm',
				'/armManagementHold',
				'/AgentClientManagement/armManagementHold',
				`/__auth-proof/management-hold/arm?key=${publicHoldId}`,
				`/__auth-proof/management-hold/arrive?key=${publicHoldId}`,
			].map(async (pathname) => {
				const response = await harness.auth(pathname, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ requestId: publicHoldId, observeManagement: true }),
				});
				expect([403, 404].includes(response.status)).toBe(true);
			}),
		);
		expect(await harness.managementHolds.managementHoldStatus(publicHoldId)).toEqual({
			armed: false,
			observed: false,
		});
		await harness.managementHolds.armManagementHold(publicHoldId);
		try {
			const publicAttempt = await harness.auth('/api/auth/admin/oauth2/create-client', {
				method: 'POST',
				headers: forgedHeaders,
				body: JSON.stringify({ requestId: publicHoldId, observeManagement: true }),
			});
			expect([403, 404].includes(publicAttempt.status)).toBe(true);
			expect(await harness.managementHolds.managementHoldStatus(publicHoldId)).toEqual({
				armed: true,
				observed: false,
			});
		} finally {
			await harness.managementHolds.releaseManagementHold(publicHoldId);
		}
		async function refusedCallerB(): Promise<void> {
			const clientsBeforeB = await clientRows();
			const isolated = await harness.gateway(endpoint, {
				method: 'POST',
				headers: forgedHeaders,
				body: JSON.stringify({ requestId: controlledSignInIds.nextId() }),
			});
			expect(isolated.status).toBe(403);
			const noHook = await harness.auth('/__auth-proof/no-hook');
			expect(noHook.status).toBe(200);
			expect(await noHook.json()).toEqual({ refused: true });
			expect(await clientRows()).toEqual(clientsBeforeB);
		}
		async function heldOwnerA(revoke: boolean): Promise<void> {
			const clientBeforeA = await harness.database
				.select(storedRowProjection(signInTables.oauthClient))
				.from(signInTables.oauthClient)
				.where(eq(signInTables.oauthClient.clientId, registeredClientId))
				.limit(1)
				.then((storedRows) => storedRows[0] ?? null);
			// Reusing the completed operation makes A enter the real provider link/rotation path.
			await harness.managementHolds.armManagementHold(registrationRequestId);
			const accepted = harness.gateway(endpoint, legitimate);
			try {
				const entered = await harness.managementHolds.enteredManagementHold(registrationRequestId);
				expect(entered).toEqual({
					point: 'before-provider-owner-read',
					requestId: registrationRequestId,
				});
				await refusedCallerB();
				if (revoke)
					await harness.database
						.delete(signInTables.session)
						.where(eq(signInTables.session.id, ownerPerson.sid))
						.run();
			} finally {
				await harness.managementHolds.releaseManagementHold(registrationRequestId);
				await accepted;
			}
			const settled = await accepted;
			expect(settled.status).toBe(revoke ? 503 : 200);
			if (revoke) expect(await settled.json()).not.toHaveProperty('clientSecret');
			if (revoke)
				expect(
					await harness.database
						.select(storedRowProjection(signInTables.oauthClient))
						.from(signInTables.oauthClient)
						.where(eq(signInTables.oauthClient.clientId, registeredClientId))
						.limit(1)
						.then((storedRows) => storedRows[0] ?? null),
				).toEqual(clientBeforeA);
			await refusedCallerB();
		}
		// All earlier non-owner/public attempts preserve every stored field, including the credential hash.
		expect(await clientRows()).toEqual(initialClients);
		await heldOwnerA(false);
		await heldOwnerA(true);
		expect(
			await harness.database
				.select({
					clientId: fixtureSql`${signInTables.oauthClient.clientId}`,
					metadata: fixtureSql`${signInTables.oauthClient.metadata}`,
					grantTypes: fixtureSql`${signInTables.oauthClient.grantTypes}`,
				})
				.from(signInTables.oauthClient)
				.orderBy(signInTables.oauthClient.clientId),
		).toEqual(rowsBefore);
		expect(
			await (
				await harness.gateway(
					`/__auth-proof?workspace=${workspaceOne}&client=${registeredClientId}`,
				)
			).json(),
		).toEqual(admissionBefore);
		expect(harness.effects).toHaveLength(0);
	} finally {
		await harness.close();
	}
});
