import { watch } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { requirePrivateRuntimePath } from '@agent-collaboration/sign-in-owner-cli';
import { expect, it } from 'vitest';
import { z } from 'zod';

import { runAuthProofProcess } from '#sign-in-test-support/test-fixtures/auth-proof-process';
import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import { controlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-sign-in-clock';

useControlledSignInClock();

const blockedChild = `process.on('SIGTERM', () => {}); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);`;
const pidSchema = z.object({
	parent: z.number().int().positive(),
	grandchild: z.number().int().positive(),
});
type FixturePids = z.infer<typeof pidSchema>;
type ProcessResult = Awaited<ReturnType<typeof runAuthProofProcess>>;

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false;
		throw error;
	}
}

function killOwnedGroup(processGroup: number): void {
	try {
		process.kill(-processGroup, 'SIGKILL');
	} catch (error) {
		if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
	}
}

function observeFixturePids(directory: string): {
	readonly ready: Promise<FixturePids>;
	readonly close: () => void;
} {
	const ready = Promise.withResolvers<FixturePids>();
	async function inspect(): Promise<void> {
		try {
			ready.resolve(
				pidSchema.parse(JSON.parse(await readFile(path.join(directory, 'ready.json'), 'utf8'))),
			);
		} catch (error) {
			if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
				ready.reject(error);
		}
	}
	const watcher = watch(directory, () => {
		void inspect();
	});
	void inspect();
	return { ready: ready.promise, close: () => watcher.close() };
}

for (const mode of ['blocked-parent', 'normal-parent'] as const) {
	it(`process: owns and reaps a grandchild after ${mode} termination`, async () => {
		const expectedEnding =
			mode === 'blocked-parent'
				? { kind: 'timed-out', signal: 'SIGKILL' }
				: { kind: 'exited', code: 0 };
		const caseEvents = process.env.AUTH_PROOF_CASE_EVENTS_FILE;
		const evidenceRoot =
			caseEvents === undefined
				? tmpdir()
				: path.dirname(await requirePrivateRuntimePath(caseEvents, false));
		const directory = await mkdtemp(path.join(evidenceRoot, '2026-10-auth-proof-process-'));
		const readyFile = path.join(directory, 'ready.json');
		const observation = observeFixturePids(directory);
		// Readiness permits immediate termination, so publish it only after the PID bytes flush.
		const code = `
import { spawn } from 'node:child_process';
import { writeFile, rename } from 'node:fs/promises';
const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(blockedChild)}], { stdio: 'ignore' });
process.on('SIGTERM', () => {});
const pids = { parent: process.pid, grandchild: grandchild.pid };
process.stdout.write(JSON.stringify(pids), async () => {
 await writeFile(${JSON.stringify(readyFile + '.pending')}, JSON.stringify(pids), {mode: 0o600});
 await rename(${JSON.stringify(readyFile + '.pending')}, ${JSON.stringify(readyFile)});
 ${mode === 'blocked-parent' ? 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);' : 'process.exit(0);'}
});`;
		let processGroup: number | undefined;
		let fixturePids: FixturePids | undefined;
		let result: ProcessResult | undefined;
		const deadline = new AbortController();
		const running = runAuthProofProcess({
			command: process.execPath,
			args: ['--input-type=module', '-e', code],
			cwd: process.cwd(),
			env: process.env,
			deadline: deadline.signal,
			onStarted: (groupId: number): void => {
				processGroup = groupId;
			},
		});
		void running.catch(() => undefined);
		try {
			const first = await Promise.race([
				observation.ready.then((pids) => ({ kind: 'ready', pids }) as const),
				running.then((completed) => ({ kind: 'ended', result: completed }) as const),
			]);
			if (first.kind === 'ready') {
				fixturePids = first.pids;
				if (mode === 'blocked-parent') deadline.abort();
			}
			if (first.kind === 'ended') result = first.result;
			if (result !== undefined) {
				// Diagnose a child crash before parsing its output; never hide it behind a JSON error.
				expect({
					ending: result.ending,
					stderr: result.stderr,
					cleanup: result.cleanup,
				}).toMatchObject({
					ending: expectedEnding,
					stderr: '',
					cleanup: { remainingMembers: [] },
				});
				fixturePids = pidSchema.parse(JSON.parse(result.stdout));
			}
			if (fixturePids === undefined)
				throw new Error('Process fixture did not publish its PID readiness record');
			expect(fixturePids.parent).toBe(processGroup);
			result ??= await running;
			const grandchildAlive = processExists(fixturePids.grandchild);
			// Probe the OS independently of the reported cleanup rows.
			expect({
				grandchildAlive,
				ending: result?.ending ?? 'runner-did-not-return',
			}).toMatchObject({
				grandchildAlive: false,
			});
			if (result === undefined)
				throw new Error('Process runner did not return after its process-exit event');
			expect({
				ending: result.ending,
				stderr: result.stderr,
				cleanup: result.cleanup,
			}).toMatchObject({
				ending: expectedEnding,
				stderr: '',
				cleanup: { remainingMembers: [] },
			});
			expect(result.cleanup.signals).toEqual(expect.arrayContaining(['SIGTERM', 'SIGKILL']));
			expect(pidSchema.parse(JSON.parse(result.stdout))).toEqual(fixturePids);
		} finally {
			observation.close();
			// Keep pre-cleanup evidence: a broken runner must fail with the surviving grandchild visible.
			try {
				await writeFile(
					path.join(directory, 'observed.json'),
					JSON.stringify({
						mode,
						processGroup,
						fixturePids,
						grandchildAlive:
							fixturePids === undefined ? null : processExists(fixturePids.grandchild),
						result,
						time: new Date(controlledSignInClock.now()).toISOString(),
					}),
					{ mode: 0o600 },
				);
			} finally {
				if (processGroup !== undefined) killOwnedGroup(processGroup);
			}
			const settled = await running;
			await writeFile(
				path.join(directory, 'cleanup.json'),
				JSON.stringify({
					ending: settled.ending,
					cleanup: settled.cleanup,
					grandchildAlive: fixturePids === undefined ? null : processExists(fixturePids.grandchild),
					time: new Date(controlledSignInClock.now()).toISOString(),
				}),
				{ mode: 0o600 },
			);
			if (fixturePids !== undefined) expect(processExists(fixturePids.grandchild)).toBe(false);
			process.stdout.write(
				JSON.stringify({
					event: 'process-fixture-receipt',
					file: path.join(directory, 'observed.json'),
				}) + '\n',
			);
		}
	});
}
