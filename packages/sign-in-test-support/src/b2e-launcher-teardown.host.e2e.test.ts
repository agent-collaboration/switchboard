import { chmod, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { useCentralProcessTeardown } from '#sign-in-test-support/test-fixtures/b2e/central-control-process';
import {
	jointArtifactsDirectory,
	requireJointLauncher,
} from '#sign-in-test-support/test-fixtures/b2e/joint-central-pins';
import {
	startTokioCentral,
	type TokioCentral,
} from '#sign-in-test-support/test-fixtures/b2e/tokio-central-launcher';
import {
	controlledSignInClock,
	controlledSignInIds,
} from '#sign-in-test-support/test-fixtures/controlled-sign-in-clock';

const artifactsDirectory = jointArtifactsDirectory();

/** Whether a process id still names a live process, asked of the OS with signal 0. */
function processIsRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** The launcher the inner suite leaves running, and its scratch, for the case after it. */
let leftRunning: { readonly central: TokioCentral; readonly root: string } | undefined;

// The B2e launcher fixture owns its child's lifetime. A suite that
// registers the fixture's teardown and leaves a launcher running, as a case whose `finally`
// never ran would, must have that launcher ended by its registered `afterAll`, before the next
// case runs.
describe.runIf(artifactsDirectory !== null)('B2e Tokio launcher teardown', () => {
	describe('a suite whose case never calls close()', () => {
		useCentralProcessTeardown();

		it('starts a real launcher through the fixture and leaves it running', async () => {
			const artifacts = await requireJointLauncher(artifactsDirectory ?? '');
			const root = await mkdtemp('/tmp/2026-11-b2e-central-');
			await chmod(root, 0o700);
			const central = await startTokioCentral({
				launcherPath: artifacts.launcher,
				root: path.join(root, 'central'),
				socket: path.join(root, 'link.sock'),
				issuer: 'http://127.0.0.1:9',
				audience: 'https://central.example.invalid/identity',
				adminAudience: 'https://central.example.invalid/admin',
				publicOrigin: 'https://central.example.invalid',
				jwksUrl: 'http://127.0.0.1:9/api/auth/jwks',
				serviceId: controlledSignInIds.nextId(),
				legacyOrganization: controlledSignInIds.nextId(),
				fixedTimeMs: controlledSignInClock.now(),
			});
			leftRunning = { central, root };
			expect(processIsRunning(central.pid)).toBe(true);
		});
	});

	it("that suite's registered teardown ended exactly its launcher before this case ran", async () => {
		const left = leftRunning;
		if (left === undefined) throw new Error('The inner suite started no launcher');
		try {
			// Assert first, without waiting: the registered afterAll has already ended it.
			expect(processIsRunning(left.central.pid)).toBe(false);
			// Then its own exit event, already settled: a clean SIGTERM exit.
			expect(await left.central.exited).toBe(0);
		} finally {
			if (processIsRunning(left.central.pid)) await left.central.close();
			await rm(left.root, { recursive: true, force: true });
		}
	});
});
