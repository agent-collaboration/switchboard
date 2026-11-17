import { chmod, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';

import { epochMillisecondsSchema } from '@agent-collaboration/sign-in-core';
import { z } from 'zod';

import { requireJointLauncher } from '#sign-in-test-support/test-fixtures/b2e/joint-central-pins';
import {
	jointCentralPublicOrigin,
	type JointFixture,
} from '#sign-in-test-support/test-fixtures/b2e/joint-fixture';
import {
	startLinkFaultProxy,
	type LinkFaultProxy,
} from '#sign-in-test-support/test-fixtures/b2e/link-fault-proxy';
import {
	startTokioCentral,
	type TokioCentral,
} from '#sign-in-test-support/test-fixtures/b2e/tokio-central-launcher';
import {
	controlledSignInClock,
	controlledSignInIds,
} from '#sign-in-test-support/test-fixtures/controlled-sign-in-clock';
import { startLocalAuthHarness } from '#sign-in-test-support/test-fixtures/local-auth-harness';

const launchedClockSchema = z.looseObject({
	answer: z.literal('timeSet'),
	setTimeMs: z.number(),
	liveFleets: z.number(),
});

export interface JointNodeFixture extends JointFixture {
	readonly central: TokioCentral;
}

/**
 * Node sign-in against real Tokio central over the real 0600 link socket (B2e pairing 1).
 * The only hop between them is the test-only fault proxy, which passes bytes unchanged unless
 * a case arms a hold or a dropped reply.
 */
export async function startJointNode(props: {
	readonly artifactsDirectory: string;
	readonly authenticatorClock: { readonly now: () => number };
}): Promise<JointNodeFixture> {
	const artifacts = await requireJointLauncher(props.artifactsDirectory);
	const root = await mkdtemp('/tmp/2026-11-b2e-central-');
	await chmod(root, 0o700);
	const serviceId = controlledSignInIds.nextId();
	const legacyOrganization = controlledSignInIds.nextId();
	let central: TokioCentral | undefined;
	let restarts = 0;
	let jointTimeMs: number = controlledSignInClock.now();
	let launch: ((root: string, fixedTimeMs: number) => Promise<TokioCentral>) | undefined;
	let link: LinkFaultProxy | undefined;
	const harness = await startLocalAuthHarness({
		turnstileSecret: 'published-test',
		authenticatorClock: {
			now: () => epochMillisecondsSchema.parse(props.authenticatorClock.now()),
		},
		centralLink: async (issuer) => {
			launch = async (centralRoot, fixedTimeMs) => {
				const launched = await startTokioCentral({
					launcherPath: artifacts.launcher,
					root: centralRoot,
					socket: path.join(root, 'link.sock'),
					issuer,
					audience: `${jointCentralPublicOrigin}/identity`,
					adminAudience: `${jointCentralPublicOrigin}/admin`,
					publicOrigin: jointCentralPublicOrigin,
					jwksUrl: `${issuer}/api/auth/jwks`,
					serviceId,
					legacyOrganization,
					fixedTimeMs,
				});
				// The launcher starts at --fixed-time-ms; the same instant through its own control
				// must answer with no organization live yet, before sign-in's first request.
				const timeSet = launchedClockSchema.safeParse(await launched.setTime(fixedTimeMs));
				if (
					!timeSet.success ||
					timeSet.data.setTimeMs !== fixedTimeMs ||
					timeSet.data.liveFleets !== 0
				) {
					await launched.close();
					throw new Error('Central launcher clock was not set before its first request');
				}
				return launched;
			};
			central = await launch(path.join(root, 'central'), jointTimeMs);
			// The proxy dials this socket path for each request, so a relaunch behind it is seen.
			link = await startLinkFaultProxy(central.socket);
			return {
				socketPath: link.socketPath,
				async close(): Promise<void> {
					await link?.close();
					const exitCode = await central?.close();
					if (exitCode !== 0) throw new Error(`Central launcher exited ${String(exitCode)}`);
				},
			};
		},
	});
	if (central === undefined || link === undefined) {
		await harness.close();
		throw new Error('The harness never started the joint central link');
	}
	const started = { link };
	const current = (): TokioCentral => {
		if (central === undefined) throw new Error('The joint central is not running');
		return central;
	};
	return {
		pairing: 'node-sign-in-with-tokio-central',
		harness,
		get central(): TokioCentral {
			return current();
		},
		link: started.link,
		serviceId,
		async restartCentralEmpty(): Promise<void> {
			const exitCode = await current().close();
			if (exitCode !== 0) throw new Error(`Central launcher exited ${String(exitCode)}`);
			if (launch === undefined) throw new Error('The joint central was never launched');
			restarts += 1;
			central = await launch(path.join(root, `central-restarted-${String(restarts)}`), jointTimeMs);
		},
		async observe(organization): Promise<unknown> {
			const answer = await current().observe(organization);
			if (answer.answer !== 'observed')
				throw new Error(`Central observer answered ${answer.answer}`);
			return answer['observation'];
		},
		async setJointTime(milliseconds): Promise<void> {
			const response = await harness.auth('/__auth-proof/set-clock', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ milliseconds }),
			});
			if (response.status !== 200) throw new Error('Sign-in clock was not moved');
			const answer = await current().setTime(milliseconds);
			if (answer.answer !== 'timeSet')
				throw new Error(`Central clock was not moved: ${answer.answer}`);
			jointTimeMs = milliseconds;
			harness.setCentralAdminTime(milliseconds);
		},
		async close(): Promise<void> {
			try {
				await harness.close();
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	};
}
