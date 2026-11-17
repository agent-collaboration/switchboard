import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'vitest';

import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import {
	setupFleetCli,
	type FleetFixture,
} from '#sign-in-test-support/test-fixtures/fleet-cli-fixture';

useControlledSignInClock();
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * The real source-checkout CLI entry (`scripts/verify-auth/owner-cli.ts`) plus built
 * dependencies, as a person runs it from the checkout; only the clock is preloaded. It is not
 * a built CLI artifact.
 */
async function runDeliveredCli(props: {
	readonly fixture: FleetFixture;
	readonly args: readonly string[];
}): Promise<{
	readonly exitCode: number;
	readonly stdout: readonly string[];
	readonly stderr: readonly string[];
}> {
	const { harness } = props.fixture;
	const targetFile = path.join(
		path.dirname(harness.target.tokenCachePath),
		'fleet-cli-target.json',
	);
	await writeFile(
		targetFile,
		JSON.stringify({ ...harness.target, organizationId: props.fixture.target.organizationId }),
		{ mode: 0o600 },
	);
	const child = spawn(
		process.execPath,
		[
			'--import',
			'./packages/sign-in-test-support/src/test-fixtures/controlled-native-cli-clock.ts',
			'scripts/verify-auth/owner-cli.ts',
			'--target',
			targetFile,
			...props.args,
		],
		{ cwd: repositoryRoot, stdio: ['ignore', 'pipe', 'pipe'] },
	);
	const ended = new Promise<number>((resolveEnd, rejectEnd) => {
		child.once('error', rejectEnd);
		child.once('exit', (code) => resolveEnd(code ?? 1));
	});
	const stdout: string[] = [];
	const stderr: string[] = [];
	const readOut = (async (): Promise<void> => {
		for await (const line of createInterface({ input: child.stdout })) {
			stdout.push(line);
			// The person opens the printed URL; the fixture's browser follows it with their cookie.
			if (line.startsWith('AUTHORIZATION_URL='))
				await props.fixture.io.browser(line.slice('AUTHORIZATION_URL='.length));
		}
	})();
	const readErr = (async (): Promise<void> => {
		for await (const line of createInterface({ input: child.stderr })) stderr.push(line);
	})();
	const [exitCode] = await Promise.all([ended, readOut, readErr]);
	return { exitCode, stdout, stderr };
}

it("fleet CLI source-checkout entry: --no-browser --memory-only create, lookup and records each sign in from the printed URL, map their flags into central's request, and print no credential", async () => {
	// Arrange
	const fixture = await setupFleetCli();
	const { harness } = fixture;
	const organizationId = fixture.target.organizationId;
	try {
		const operationId = fixture.io.nextId();
		const run = async (args: readonly string[]): ReturnType<typeof runDeliveredCli> =>
			runDeliveredCli({ fixture, args: ['--no-browser', '--memory-only', ...args] });
		// Act
		const created = await run([
			'fleet-create-workspace',
			'--operation-id',
			operationId,
			'--name',
			'research',
			'--description',
			'notes',
		]);
		const workspaceId = String(
			(JSON.parse(created.stdout.at(-1) ?? 'null') as { workspace?: { workspaceId?: string } })
				.workspace?.workspaceId,
		);
		const lookedUp = await run(['fleet-workspace-lookup', '--workspace-id', workspaceId]);
		const firstPage = await run(['fleet-change-records']);
		const recordId = harness.centralAdmin.changeRecords[0]?.id ?? '';
		const afterRecord = await run(['fleet-change-records', '--after', recordId, '--limit', '7']);
		// Assert: every command exited 0 after signing in from its own printed URL.
		const runs = [created, lookedUp, firstPage, afterRecord];
		expect(runs.map((cli) => cli.exitCode)).toEqual([0, 0, 0, 0]);
		for (const cli of runs) {
			expect(cli.stdout.filter((line) => line.startsWith('AUTHORIZATION_URL='))).toHaveLength(1);
			expect(cli.stderr).toContain(
				'Holding the fleet key and refresh credential in memory for this command only; the next command signs in again.',
			);
		}
		// Central received exactly the request each command's flags name.
		expect(harness.centralAdmin.arrivals.map((arrival) => arrival.request)).toEqual([
			{
				operation: 'CreateWorkspace',
				organizationId,
				operationId,
				name: 'research',
				description: 'notes',
			},
			{ operation: 'WorkspaceLookup', organizationId, workspaceId },
			{ operation: 'ReadChangeRecords', organizationId, after: null, limit: 100 },
			{ operation: 'ReadChangeRecords', organizationId, after: recordId, limit: 7 },
		]);
		// And each command printed central's result.
		const workspace = { workspaceId, name: 'research', description: 'notes', state: 'active' };
		expect(JSON.parse(created.stdout.at(-1) ?? 'null')).toEqual({
			result: 'applied',
			workspace,
		});
		expect(JSON.parse(lookedUp.stdout.at(-1) ?? 'null')).toEqual({ result: 'found', workspace });
		expect(JSON.parse(firstPage.stdout.at(-1) ?? 'null')).toEqual({
			result: 'records',
			records: [
				expect.objectContaining({ id: recordId, requestId: operationId, targetId: workspaceId }),
			],
		});
		expect(JSON.parse(afterRecord.stdout.at(-1) ?? 'null')).toEqual({
			result: 'records',
			records: [],
		});
		const output = runs.flatMap((cli) => [...cli.stdout, ...cli.stderr]).join('\n');
		expect(output).not.toMatch(/eyJ[A-Za-z0-9_-]+\.eyJ/u);
		for (const { authorization, proof } of harness.centralAdmin.receivedCredentials) {
			expect(output).not.toContain(authorization.replace(/^DPoP /u, ''));
			expect(output).not.toContain(proof);
		}
	} finally {
		await harness.close();
	}
});

it('fleet CLI source-checkout entry: --device exits non-zero with the named message and nothing is sent', async () => {
	const fixture = await setupFleetCli();
	const { harness } = fixture;
	try {
		const run = await runDeliveredCli({
			fixture,
			args: ['--device', '--memory-only', 'fleet-login'],
		});
		expect(run.exitCode).toBe(1);
		expect(run.stderr).toEqual([
			"Device sign-in isn't available yet; use --no-browser to sign in from another machine's browser.",
		]);
		expect(run.stdout).toEqual([]);
		expect(harness.centralAdmin.arrivals).toEqual([]);
	} finally {
		await harness.close();
	}
});
