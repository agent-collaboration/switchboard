import { fileURLToPath } from 'node:url';

import * as signInTables from '@agent-collaboration/sign-in-core';
import { eq, sql as fixtureSql } from 'drizzle-orm';
import { decodeJwt } from 'jose';
import { expect, it } from 'vitest';
import { z } from 'zod';

import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import {
	registeredClientId,
	registrationRequestId,
	startLocalAuthHarness,
	workspaceOne,
} from '#sign-in-test-support/test-fixtures/local-auth-harness';
import { runCachedNativeOwnerCommand } from '#sign-in-test-support/test-fixtures/native-cli-proof';

useControlledSignInClock();

it.each([
	'revoked-session',
	'expired-session',
	'removed-person',
	'demoted-owner',
	'unavailable-session-store',
] as const)(
	'agent: the next delivered CLI command refuses the already issued E7 after $0',
	async (change) => {
		const harness = await startLocalAuthHarness();
		try {
			const owner = await harness.ownerToken();
			const person = z.object({ sub: z.string(), sid: z.string() }).parse(decodeJwt(owner));
			const endpoint = `/management/workspaces/${workspaceOne}/agents`;
			const registered = await harness.gateway(endpoint, {
				method: 'POST',
				headers: { authorization: `Bearer ${owner}`, 'content-type': 'application/json' },
				body: JSON.stringify({ requestId: registrationRequestId, persona: 'operator' }),
			});
			expect(registered.status).toBe(200);
			const before = await (
				await harness.gateway(
					`/__auth-proof?workspace=${workspaceOne}&client=${registeredClientId}`,
				)
			).json();
			const command = {
				target: harness.target,
				repositoryRoot: fileURLToPath(new URL('../../../', import.meta.url)),
				args: ['agent-status', '--client-id', registeredClientId],
			};
			const admitted = await runCachedNativeOwnerCommand(command);
			expect(admitted.code).toBe(0);
			expect(admitted.stdout).toBe(`member: ${registeredClientId}\n`);
			switch (change) {
				case 'revoked-session':
					await harness.database
						.delete(signInTables.session)
						.where(eq(signInTables.session.id, person.sid))
						.run();
					break;
				case 'expired-session':
					await harness.database
						.update(signInTables.session)
						.set({ expiresAt: fixtureSql`${0}` })
						.where(eq(signInTables.session.id, person.sid))
						.run();
					break;
				case 'removed-person':
					await harness.database
						.delete(signInTables.member)
						.where(eq(signInTables.member.userId, person.sub))
						.run();
					break;
				case 'demoted-owner':
					await harness.database
						.update(signInTables.member)
						.set({ role: 'member' })
						.where(eq(signInTables.member.userId, person.sub))
						.run();
					break;
				case 'unavailable-session-store':
					await harness.setDatabaseFault({
						operation: 'select',
						table: 'session',
						key: person.sid,
					});
					break;
			}
			const refused = await runCachedNativeOwnerCommand(command);
			if (
				change === 'unavailable-session-store' &&
				!refused.stderr.includes('Sign-in service unavailable')
			) {
				const jwks = await harness.auth('/api/auth/jwks');
				const diagnostics = z
					.object({
						driverFailures: z.array(
							z.object({
								operation: z.string(),
								table: z.string(),
								reason: z.enum(['unique-key', 'other-database-error']),
							}),
						),
					})
					.parse(await (await harness.auth('/__auth-proof/database-control')).json());
				process.stderr.write(
					JSON.stringify({
						event: 'unavailable-session-diagnostic',
						code: refused.code,
						category: refused.stderr.includes('Owner management refused')
							? 'management-refused'
							: refused.stderr.includes('Sign-in service unavailable')
								? 'service-unavailable'
								: 'other',
						jwksStatus: jwks.status,
						...diagnostics,
					}) + '\n',
				);
			}
			expect(refused.code).toBe(1);
			expect(refused.stdout).toBe('');
			expect(
				refused.stderr.includes(
					change === 'unavailable-session-store'
						? 'Sign-in service unavailable'
						: 'Owner management refused',
				),
			).toBe(true);
			expect(refused.stderr.includes(owner)).toBe(false);
			expect(refused.stderr.includes(harness.cookie())).toBe(false);
			expect(harness.effects).toHaveLength(0);
			expect(
				await (
					await harness.gateway(
						`/__auth-proof?workspace=${workspaceOne}&client=${registeredClientId}`,
					)
				).json(),
			).toEqual(before);
		} finally {
			await harness.close();
		}
	},
);
