import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { epochMillisecondsSchema } from '@agent-collaboration/sign-in-core';
import { Response as WorkerResponse } from 'miniflare';
import { z } from 'zod';

import {
	startCentralControlProcess,
	type CentralControlProcess,
} from '#sign-in-test-support/test-fixtures/b2e/central-control-process';
import {
	requireJointCentralCheckout,
	type JointCentralCheckout,
} from '#sign-in-test-support/test-fixtures/b2e/joint-central-pins';
import {
	jointCentralPublicOrigin,
	type JointFixture,
} from '#sign-in-test-support/test-fixtures/b2e/joint-fixture';
import {
	createLinkFaultControl,
	forwardThroughLinkFault,
} from '#sign-in-test-support/test-fixtures/b2e/link-fault-proxy';
import {
	controlledSignInClock,
	controlledSignInIds,
} from '#sign-in-test-support/test-fixtures/controlled-sign-in-clock';
import { startLocalAuthHarness } from '#sign-in-test-support/test-fixtures/local-auth-harness';

/**
 * The canonical https JWKS URL central's Workers are configured with. Central's bridge fetches
 * exactly this URL from the plan's loopback fixture URL, the harness's own JWKS route.
 */
const signInKeysUrl = 'https://sign-in.example.invalid/api/auth/jwks';

/** Central's conformance Access policy (`collaboration-central-conformance` `fixture_policy`). */
const accessPolicy = {
	ACCESS_TEAM_DOMAIN: 'conformance-test.cloudflareaccess.com',
	ACCESS_SESSION_AUD: 'test-session-aud',
	ACCESS_ADMIN_AUD: 'test-admin-aud',
	ACCESS_OWNER_IDENTITY: 'owner@example.test',
} as const;

const bridgeReadinessSchema = z.strictObject({
	origin: z.url().refine((origin) => new URL(origin).hostname === '127.0.0.1', {
		message: 'central bridge must bind loopback',
	}),
});
type CentralBridge = CentralControlProcess<z.infer<typeof bridgeReadinessSchema>>;

const timeSetSchema = z.looseObject({
	answer: z.literal('timeSet'),
	setTimeMs: z.number(),
	liveFleets: z.number(),
});

/**
 * Central's own workerd bridge at the pinned commit (`tests/support/workerd-bridge.mts
 * --signin-plan`): a gateway routing `/public/*` to central and `/private/*` to its link
 * Worker, both on one CentralObject namespace, in central's pinned Miniflare and workerd with
 * storage in a fresh directory. Its controls exist only when it starts with
 * `--launcher-time-ms`: that instant is every organization's first clock. The same instant
 * through its own `setTimeMs` must then answer with no organization live yet, before sign-in's
 * first request. Any other answer (including `failed`, a possibly partial push) ends the run.
 */
async function startCentralBridge(props: {
	readonly checkout: JointCentralCheckout;
	readonly planPath: string;
	readonly jointTimeMs: number;
}): Promise<CentralBridge> {
	const bridge = await startCentralControlProcess({
		executable: props.checkout.node,
		arguments: [
			props.checkout.bridge,
			'--signin-plan',
			props.planPath,
			'--launcher-time-ms',
			String(props.jointTimeMs),
		],
		cwd: props.checkout.directory,
		readinessSchema: bridgeReadinessSchema,
		shutdown: 'stdin-close',
	});
	const timeSet = timeSetSchema.safeParse(await bridge.setTime(props.jointTimeMs));
	if (
		!timeSet.success ||
		timeSet.data.setTimeMs !== props.jointTimeMs ||
		timeSet.data.liveFleets !== 0
	) {
		await bridge.close();
		throw new Error('Central bridge clock was not set before its first request');
	}
	return bridge;
}

/**
 * workerd sign-in and real workerd central (B2e pairing 2). Sign-in runs in the harness's own
 * Miniflare; its CENTRAL binding is the fault hop, which forwards each request's bytes to
 * central's bridge gateway at `/private`. Central runs in its own pinned runtime, started by
 * its own bridge; this fixture reads and moves it only through that bridge's controls.
 */
export async function startJointWorkerd(props: {
	readonly checkoutDirectory: string;
	readonly node: string;
	readonly authenticatorClock: { readonly now: () => number };
}): Promise<JointFixture> {
	const checkout = await requireJointCentralCheckout({
		directory: props.checkoutDirectory,
		node: props.node,
	});
	const scratch = await mkdtemp('/tmp/2026-11-b2e-bridge-');
	await chmod(scratch, 0o700);
	const serviceId = controlledSignInIds.nextId();
	const control = createLinkFaultControl();
	let jointTimeMs: number = controlledSignInClock.now();
	let bridge: CentralBridge | undefined;
	let planPath: string | undefined;
	const current = (): CentralBridge => {
		if (bridge === undefined) throw new Error('The joint central bridge is not running');
		return bridge;
	};
	const hop = forwardThroughLinkFault({
		control,
		upstreamOrigin: () => current().readiness.origin,
	});
	let harness: Awaited<ReturnType<typeof startLocalAuthHarness>>;
	try {
		harness = await startLocalAuthHarness({
			turnstileSecret: 'published-test',
			authenticatorClock: {
				now: () => epochMillisecondsSchema.parse(props.authenticatorClock.now()),
			},
			workerdCentral: async (issuer) => {
				planPath = path.join(scratch, 'signin-plan.json');
				await writeFile(
					planPath,
					JSON.stringify({
						textBindings: {
							CENTRAL_SIGN_IN_ISSUER: issuer,
							CENTRAL_SIGN_IN_AUDIENCE: `${jointCentralPublicOrigin}/identity`,
							CENTRAL_SIGN_IN_JWKS_URL: signInKeysUrl,
							CENTRAL_ADMIN_AUDIENCE: `${jointCentralPublicOrigin}/admin`,
							CENTRAL_PUBLIC_ORIGIN: jointCentralPublicOrigin,
							CENTRAL_SIGN_IN_SERVICE_ID: serviceId,
							...accessPolicy,
						},
						jwksFixtureUrl: `${issuer}/api/auth/jwks`,
					}),
					{ mode: 0o600, flag: 'wx' },
				);
				bridge = await startCentralBridge({ checkout, planPath, jointTimeMs });
				return {
					centralBinding: {
						type: 'fetcher',
						handler: async (incoming): Promise<WorkerResponse> => {
							const reply = await hop(
								new Request(incoming.url, {
									method: incoming.method,
									headers: Object.fromEntries(incoming.headers),
									...(['GET', 'HEAD'].includes(incoming.method)
										? {}
										: { body: await incoming.arrayBuffer() }),
								}),
							);
							return new WorkerResponse(await reply.arrayBuffer(), {
								status: reply.status,
								headers: Object.fromEntries(reply.headers),
							});
						},
					},
				};
			},
		});
	} catch (error) {
		await bridge?.close();
		await rm(scratch, { recursive: true, force: true });
		throw error;
	}
	if (bridge === undefined || planPath === undefined) {
		await harness.close();
		await rm(scratch, { recursive: true, force: true });
		throw new Error('The harness never started the joint central bridge');
	}
	const startedPlan = planPath;
	async function closeBridge(): Promise<void> {
		const exitCode = await current().close();
		if (exitCode !== 0) throw new Error(`Central bridge exited ${String(exitCode)}`);
	}
	return {
		pairing: 'workerd-sign-in-with-workerd-central',
		harness,
		link: control,
		serviceId,
		async restartCentralEmpty(): Promise<void> {
			// A new bridge process: new storage, the same sign-in plan, the clock set first.
			await closeBridge();
			bridge = await startCentralBridge({ checkout, planPath: startedPlan, jointTimeMs });
		},
		async observe(organizationId): Promise<unknown> {
			const answer = await current().observe(organizationId);
			if (answer.answer !== 'observed')
				throw new Error(`Central bridge observer answered ${answer.answer}`);
			return answer['observation'];
		},
		async setJointTime(milliseconds): Promise<void> {
			const moved = await harness.auth('/__auth-proof/set-clock', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ milliseconds }),
			});
			if (moved.status !== 200) throw new Error('Sign-in clock was not moved');
			const answer = timeSetSchema.safeParse(await current().setTime(milliseconds));
			if (!answer.success || answer.data.setTimeMs !== milliseconds)
				throw new Error('Central bridge clock was not moved');
			jointTimeMs = milliseconds;
			harness.setCentralAdminTime(milliseconds);
		},
		async close(): Promise<void> {
			try {
				await harness.close();
			} finally {
				try {
					await closeBridge();
				} finally {
					await rm(scratch, { recursive: true, force: true });
				}
			}
		},
	};
}
