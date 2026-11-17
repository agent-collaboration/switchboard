import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as signInTables from '@agent-collaboration/sign-in-core';
import { eq, sql as fixtureSql } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { z } from 'zod';

import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import { controlledSignInIds } from '#sign-in-test-support/test-fixtures/controlled-sign-in-clock';
import {
	registeredClientId,
	registrationRequestId,
	startLocalAuthHarness,
	workspaceAudience,
	workspaceOne,
	workspaceTwo,
} from '#sign-in-test-support/test-fixtures/local-auth-harness';
import { runCachedNativeOwnerCommand } from '#sign-in-test-support/test-fixtures/native-cli-proof';
import {
	agentCredentialSchema,
	workspaceToken,
} from '#sign-in-test-support/test-fixtures/workspace-agent-proof';

useControlledSignInClock();

it('agent: delivered owner CLI registers, links, removes one workspace and retires without printing a credential', async () => {
	const harness = await startLocalAuthHarness();
	try {
		await harness.ownerToken();
		const directory = path.dirname(harness.target.tokenCachePath);
		const outputFile = path.join(directory, 'workspace-agent-credential.json');
		const targetFile = path.join(directory, 'owner-cli-target.json');
		const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
		const registration = await runCachedNativeOwnerCommand({
			target: harness.target,
			repositoryRoot,
			args: [
				'add-agent',
				'--persona',
				'operator',
				'--request-id',
				registrationRequestId,
				'--output',
				outputFile,
			],
		});
		expect(registration).toEqual({
			code: 0,
			stdout: 'Agent credential saved to the private output file.\n',
			stderr: '',
		});
		expect((await stat(outputFile)).mode & 0o777).toBe(0o600);
		const credential = agentCredentialSchema
			.extend({
				kind: z.literal('registered'),
				workspaceId: z.literal(workspaceOne),
				resource: z.literal(workspaceAudience(workspaceOne)),
			})
			.strict()
			.parse(JSON.parse(await readFile(outputFile, 'utf8')));
		expect(credential.clientId).toBe(registeredClientId);
		const secretBefore = await harness.database
			.select({ clientSecret: fixtureSql`${signInTables.oauthClient.clientSecret}` })
			.from(signInTables.oauthClient)
			.where(eq(signInTables.oauthClient.clientId, credential.clientId))
			.limit(1)
			.then((storedRows) => storedRows[0] ?? null);
		await writeFile(targetFile, JSON.stringify({ ...harness.target, workspaceId: workspaceTwo }), {
			mode: 0o600,
		});
		const link = await runCachedNativeOwnerCommand({
			target: { ...harness.target, workspaceId: workspaceTwo },
			repositoryRoot,
			args: [
				'add-agent',
				'--persona',
				'operator',
				'--request-id',
				controlledSignInIds.nextId(),
				'--client-id',
				credential.clientId,
			],
		});
		expect(link).toEqual({ code: 0, stdout: `linked: ${credential.clientId}\n`, stderr: '' });
		expect(
			await harness.database
				.select({ clientSecret: fixtureSql`${signInTables.oauthClient.clientSecret}` })
				.from(signInTables.oauthClient)
				.where(eq(signInTables.oauthClient.clientId, credential.clientId))
				.limit(1)
				.then((storedRows) => storedRows[0] ?? null),
		).toEqual(secretBefore);
		expect(await workspaceToken({ harness, credential, workspaceId: workspaceTwo })).toBeTypeOf(
			'string',
		);
		await writeFile(targetFile, JSON.stringify(harness.target), { mode: 0o600 });
		const removed = await runCachedNativeOwnerCommand({
			target: harness.target,
			repositoryRoot,
			args: [
				'remove-agent',
				'--client-id',
				credential.clientId,
				'--request-id',
				controlledSignInIds.nextId(),
			],
		});
		expect(removed).toEqual({ code: 0, stdout: `removed: ${credential.clientId}\n`, stderr: '' });
		expect(
			await harness.database
				.select({ resourceId: fixtureSql`${signInTables.oauthClientResource.resourceId}` })
				.from(signInTables.oauthClientResource)
				.where(eq(signInTables.oauthClientResource.clientId, credential.clientId)),
		).toEqual([{ resourceId: workspaceAudience(workspaceTwo) }]);
		const retired = await runCachedNativeOwnerCommand({
			target: harness.target,
			repositoryRoot,
			args: [
				'retire-agent',
				'--client-id',
				credential.clientId,
				'--request-id',
				controlledSignInIds.nextId(),
			],
		});
		expect(retired).toEqual({ code: 0, stdout: `removed: ${credential.clientId}\n`, stderr: '' });
		expect(
			await harness.database
				.select({ disabled: fixtureSql`coalesce(${signInTables.oauthClient.disabled}, ${0})` })
				.from(signInTables.oauthClient)
				.where(eq(signInTables.oauthClient.clientId, credential.clientId))
				.limit(1)
				.then((storedRows) => storedRows[0] ?? null),
		).toEqual({ disabled: 1 });
		expect(
			await harness.database
				.select({ resourceId: fixtureSql`${signInTables.oauthClientResource.resourceId}` })
				.from(signInTables.oauthClientResource)
				.where(eq(signInTables.oauthClientResource.clientId, credential.clientId)),
		).toEqual([{ resourceId: workspaceAudience(workspaceTwo) }]);
		for (const command of [registration, link, removed, retired]) {
			expect(command.stdout + command.stderr).not.toContain(credential.clientSecret);
		}
	} finally {
		await harness.close();
	}
});
