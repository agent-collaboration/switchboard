import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, open, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { nativeBrowserGroups } from '#sign-in-test-support/test-fixtures/native-browser-groups';
import { startHeadlessChrome } from '#sign-in-test-support/test-fixtures/native-browser-protocol';
import { registerNativeBrowserTestCleanup } from '#sign-in-test-support/test-fixtures/native-browser-test-cleanup';
import {
	activeOwnedProcessMembers,
	readOwnedProcessGroup,
	settleOwnedProcessGroup,
} from '#sign-in-test-support/test-fixtures/owned-process-group';

registerNativeBrowserTestCleanup();

const notification = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('retained'), group: z.number().int().positive() }),
	z.object({ kind: z.literal('ready'), groups: z.array(z.number().int().positive()).length(2) }),
]);
it('aborts a worker mid-run and closes every retained real Chrome group before worker exit', async (): Promise<void> => {
	const directory = await mkdtemp(path.join(tmpdir(), 'native-browser-abort-'));
	await Promise.all(['first', 'second'].map((name) => mkdir(path.join(directory, name))));
	const log = await open(path.join(directory, 'worker.stderr.log'), 'wx', 0o600);
	const groups = new Set<number>();
	const worker = spawn(
		process.execPath,
		[
			'--import',
			'tsx',
			fileURLToPath(new URL('./test-fixtures/native-browser-abort-worker.ts', import.meta.url)),
		],
		{
			cwd: fileURLToPath(new URL('../../../', import.meta.url)),
			env: { ...process.env, NATIVE_ABORT_EVIDENCE: directory },
			detached: true,
			stdio: ['ignore', 'ignore', log.fd, 'ipc'],
		},
	);
	const ended = new Promise<{
		readonly code: number | null;
		readonly signal: NodeJS.Signals | null;
	}>((resolve, reject) => {
		worker.once('error', reject);
		worker.once('exit', (code, signal): void => resolve({ code, signal }));
	});
	try {
		await new Promise<void>((resolve, reject) => {
			worker.on('message', (value): void => {
				const event = notification.parse(value);
				if (event.kind === 'retained') groups.add(event.group);
				else {
					event.groups.forEach((group) => groups.add(group));
					resolve();
				}
			});
			void ended.then(
				() => reject(new Error('Browser abort worker exited before readiness')),
				reject,
			);
		});
		if (worker.pid === undefined) throw new Error('Owned worker PID missing');
		process.kill(worker.pid, 'SIGTERM');
		const ending = await ended;
		const remaining = await Promise.all(
			[...groups].map(async (group) =>
				activeOwnedProcessMembers(await readOwnedProcessGroup(group)),
			),
		);
		expect(remaining).toEqual([[], []]);
		expect(ending).toEqual({ code: 143, signal: null });
	} finally {
		if (worker.pid !== undefined && worker.exitCode === null && worker.signalCode === null)
			process.kill(worker.pid, 'SIGTERM');
		await ended;
		const cleanup = await Promise.all(
			[...groups].map((group) => settleOwnedProcessGroup({ group })),
		);
		await log.close();
		if (cleanup.every((result) => result.remaining !== null && result.remaining.length === 0))
			await rm(directory, { recursive: true });
	}
});

describe.sequential('Vitest teardown after an aborted browser test', (): void => {
	let group: number | undefined;
	let evidence: string | undefined;
	afterAll(async (): Promise<void> => {
		// Emergency ownership is retained even if the teardown regression fails.
		await nativeBrowserGroups.closeAll('teardown');
		if (evidence !== undefined) await rm(evidence, { recursive: true });
	});
	it.fails('aborts after retaining a real Chrome without a per-test finally', async (): Promise<void> => {
		evidence = await mkdtemp(path.join(tmpdir(), 'native-browser-test-abort-'));
		group = (await startHeadlessChrome(evidence)).pid;
		throw new Error('Deliberate test abort after Chrome ownership');
	});
	it('observes the aborted tests group empty before the next test starts', async (): Promise<void> => {
		if (group === undefined) throw new Error('Chrome ownership was not reached');
		expect(activeOwnedProcessMembers(await readOwnedProcessGroup(group))).toEqual([]);
		if (evidence === undefined) throw new Error('Chrome evidence missing');
		z.object({
			kind: z.literal('natural'),
			termination: z.object({ kind: z.literal('not-requested') }),
			remaining: z.array(z.unknown()).length(0),
		}).parse(JSON.parse(await readFile(path.join(evidence, 'chrome-cleanup.json'), 'utf8')));
	});
});
