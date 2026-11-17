import { fileURLToPath } from 'node:url';

import { Miniflare, Response as WorkerResponse, type V4FetchHandler } from 'miniflare';
import { expect, it } from 'vitest';

import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import {
	bundleProductionWorker,
	bundleProofApplication,
	loadProofBundles,
	proofDigest,
	proofModuleHashes,
} from '#sign-in-test-support/test-fixtures/proof-bundle-artifacts';
import { clockedWorkerManifest } from '#sign-in-test-support/test-fixtures/worker-module-manifest';

useControlledSignInClock();

it('native signing preserves identical verified JWTs and isolates two overlapping workerd requests', async () => {
	const root = fileURLToPath(new URL('../../../', import.meta.url));
	const bareProduction = await bundleProductionWorker(root, 'auth');
	const bundles = await loadProofBundles(root);
	const application = await bundleProofApplication(
		root,
		'packages/sign-in-test-support/src/test-fixtures/native-signature-observer-proof-worker.ts',
	);
	const manifest = clockedWorkerManifest({
		kind: 'production-proof',
		host: 'auth',
		application,
		production: bundles.productionAuth,
		signingObserver: bundles.signingObserver,
		clock: bundles.clock,
		startup: bundles.startup,
	});
	expect(proofModuleHashes(manifest)['production-auth.mjs']).toBe(proofDigest(bareProduction));
	const bothArrived = Promise.withResolvers<void>();
	const arrivals = new Set<string>();
	const runtime = new Miniflare({
		telemetry: { enabled: false },
		logRequests: false,
		workers: [
			{
				config: {
					type: 'worker',
					name: 'native-signing-proof',
					manifest,
					compatibilityDate: '2026-08-15',
					compatibilityFlags: ['nodejs_compat'],
				},
				dev: {
					outboundService: {
						type: 'fetcher',
						async handler(request: Parameters<V4FetchHandler>[0]): Promise<WorkerResponse> {
							const label = new URL(request.url).searchParams.get('client');
							if (label !== 'one' && label !== 'two')
								return new WorkerResponse(null, { status: 400 });
							arrivals.add(label);
							if (arrivals.size === 2) bothArrived.resolve();
							await bothArrived.promise;
							return new WorkerResponse(null, { status: 204 });
						},
					},
				},
			},
		],
	});
	try {
		await runtime.ready;
		const responses = await Promise.all(
			['one', 'two'].map(async (label) => {
				const response = await runtime.dispatchFetch(
					'https://crypto-proof.invalid/?client=' + label,
				);
				const body: unknown = await response.json();
				expect(response.status, JSON.stringify(body)).toBe(200);
				return body;
			}),
		);
		expect(responses).toEqual(
			['one', 'two'].map((label) => ({
				unarmedNotRecorded: true,
				byteIdentical: true,
				verified: true,
				projection: {
					signed: true,
					clientId: label,
					organizationId: 'organization-' + label,
					workspaceId: 'workspace-' + label,
				},
			})),
		);
		expect([...arrivals].toSorted()).toEqual(['one', 'two']);
		expect(proofModuleHashes(manifest)['production-auth.mjs']).toBe(
			proofDigest(await bundleProductionWorker(root, 'auth')),
		);
	} finally {
		await runtime.dispose();
	}
});
