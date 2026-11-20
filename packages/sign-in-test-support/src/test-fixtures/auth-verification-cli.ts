import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';

import { requirePrivateRuntimePath } from '@agent-collaboration/sign-in-owner-cli';
import { z } from 'zod';

import { runAuthProofProcess } from '#sign-in-test-support/test-fixtures/auth-proof-process';
import {
	authJourneySchema,
	authJourneyFiles,
	authJourneyExecutionPattern,
	journeyReadinessEvents,
	requireAdmittedRequestLimitCounters,
	workerdOnlyCallerCases,
	selectAuthObservations,
	requireMatchingAuthObservations,
	revisionFenceSupportingUnitFiles,
	type AuthJourney,
	type OfferedAuthTest,
} from '#sign-in-test-support/test-fixtures/auth-verification-journeys';
import { runSupportingAuthUnitProof } from '#sign-in-test-support/test-fixtures/auth-verification-unit-proof';
import { controlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-sign-in-clock';
import { workspaceConfigurations } from '#sign-in-test-support/test-fixtures/local-auth-configuration';
import { nodeInvocationReceiptSchema } from '#sign-in-test-support/test-fixtures/node-management-bridge-contracts';
import {
	compareNodeProofReceipts,
	nodeProofManifestSchema,
	prepareNodeProofArtifacts,
	type NodeProofManifest,
} from '#sign-in-test-support/test-fixtures/node-proof-artifacts';
import {
	prepareOrganizationStorageProof,
	requireOrganizationStorageProof,
} from '#sign-in-test-support/test-fixtures/organization-storage-proof';
import {
	authHarnessRequestLimitsSchema,
	type AuthHarnessRequestLimits,
	prepareProofBundles,
	proofBundleManifestSchema,
	proofArtifactNames,
	proofDigest,
	proofSourceIdentities,
	type ProofBundleManifest,
} from '#sign-in-test-support/test-fixtures/proof-bundle-artifacts';
import { turnstileTestSiteKey } from '#sign-in-test-support/test-fixtures/turnstile-test-keys';

const verificationTargetFields = {
	sourceRevision: z.string().regex(/^[a-f0-9]{40}$/u),
	executionHost: z.string().min(1),
};
/** local-workerd runs sign-in in the Worker; local-node runs it on sign-in-host-node behind the fixture bridge. */
const localVerificationTargetSchema = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('local-workerd'), ...verificationTargetFields }),
	z.strictObject({ kind: z.literal('local-node'), ...verificationTargetFields }),
]);
type LocalVerificationTarget = z.infer<typeof localVerificationTargetSchema>;

type NodeJourneyIdentity =
	| { readonly kind: 'workerd' }
	| { readonly kind: 'node'; readonly manifest: NodeProofManifest; readonly manifestFile: string };

function journeyHostEnvironment(node: NodeJourneyIdentity): Readonly<Record<string, string>> {
	return node.kind === 'node'
		? { SIGN_IN_TEST_HOST: 'node', AUTH_PROOF_NODE_MANIFEST_FILE: node.manifestFile }
		: {};
}

const nodeHarnessReceiptSchema = z.strictObject({
	receiptId: z.string(),
	identity: nodeProofManifestSchema,
	expected: z.array(nodeInvocationReceiptSchema),
	actual: z.array(nodeInvocationReceiptSchema),
});

/** Every Node harness must declare the frozen Node identity and attribute each initiated call to one Node receipt. */
async function requireMatchingNodeReceipts(props: {
	readonly evidence: string;
	readonly node: Extract<NodeJourneyIdentity, { kind: 'node' }>;
	readonly workerReceiptCount: number;
}): Promise<{ readonly receiptFiles: readonly string[]; readonly invocations: number }> {
	const changed = await Promise.all(
		[props.node.manifest.nodeHost, props.node.manifest.bridge, ...props.node.manifest.modules].map(
			async (artifact): Promise<boolean> =>
				proofDigest(await readFile(artifact.file, 'utf8')) !== artifact.sha256,
		),
	);
	if (changed.includes(true)) throw new Error('Executed Node artifact changed');
	const receiptFiles = (await readdir(props.evidence)).filter((file) =>
		/^node-harness-[a-f0-9-]+\.json$/u.test(file),
	);
	if (receiptFiles.length === 0 || receiptFiles.length !== props.workerReceiptCount)
		throw new Error('Node harness receipts are missing for some harness instances');
	const receipts = await Promise.all(
		receiptFiles.map(async (file) =>
			nodeHarnessReceiptSchema.parse(
				JSON.parse(await readFile(path.join(props.evidence, file), 'utf8')),
			),
		),
	);
	for (const receipt of receipts) {
		if (JSON.stringify(receipt.identity) !== JSON.stringify(props.node.manifest))
			throw new Error('Node harness identity differs from the declared Node target');
		if (receipt.expected.length === 0)
			throw new Error('Node harness recorded no attributed invocation');
		compareNodeProofReceipts(receipt.expected, receipt.actual);
	}
	return {
		receiptFiles,
		invocations: receipts.reduce((total, receipt) => total + receipt.actual.length, 0),
	};
}

interface RequestLimitSummary {
	readonly outerCounters: Readonly<Record<string, number>>;
	readonly limitedByLayer: { readonly outer: number; readonly provider: number };
	readonly unavailable: number;
	readonly backingFailures: Readonly<Record<string, number>>;
	readonly cloudflareVendorCredit: false;
}

function requireAdmittedRequestLimits(props: {
	readonly journey: AuthJourney;
	readonly signInHost: 'workerd' | 'node';
	readonly requestLimits: readonly AuthHarnessRequestLimits[];
}): RequestLimitSummary {
	requireAdmittedRequestLimitCounters(props);
	const outerCounters: Record<string, number> = {};
	for (const limits of props.requestLimits)
		outerCounters[limits.outerCounter] = (outerCounters[limits.outerCounter] ?? 0) + 1;
	const backingFailures: Record<string, number> = {};
	for (const limits of props.requestLimits)
		backingFailures[limits.backingFailure] = (backingFailures[limits.backingFailure] ?? 0) + 1;
	const observations = props.requestLimits.flatMap((limits) => limits.observations);
	return {
		outerCounters,
		limitedByLayer: {
			outer: observations.filter(
				(seen) => seen.kind === 'request-limited' && seen.layer === 'outer',
			).length,
			provider: observations.filter(
				(seen) => seen.kind === 'request-limited' && seen.layer === 'provider',
			).length,
		},
		unavailable: observations.filter((seen) => seen.kind === 'request-limit-unavailable').length,
		backingFailures,
		cloudflareVendorCredit: false,
	};
}

interface PreparedAuthVerification {
	readonly root: string;
	readonly evidence: string;
	readonly targetPath: string;
	readonly target: LocalVerificationTarget;
	readonly node: NodeJourneyIdentity;
	readonly artifacts: ProofBundleManifest;
	readonly organizationStorageModules: Readonly<Record<string, string>>;
	readonly manifestFile: string;
	readonly vitest: string;
	readonly inventory: readonly OfferedAuthTest[];
	readonly supportingUnits: readonly OfferedAuthTest[];
	readonly tuple: Readonly<Record<string, unknown>>;
	readonly checkFrozenSource: () => Promise<void>;
}

/** Build once and retain a complete declaration before any journey observations start. */
export async function prepareAuthVerification(
	targetFile: string,
	onEvidence?: (directory: string) => void,
): Promise<PreparedAuthVerification> {
	const targetPath = await requirePrivateRuntimePath(targetFile, true);
	const target = localVerificationTargetSchema.parse(
		JSON.parse(await readFile(targetPath, 'utf8')),
	);
	if (process.version !== 'v24.7.0' || hostname() !== target.executionHost)
		throw new Error('Verification target host/toolchain prerequisites do not match');
	const root = fileURLToPath(new URL('../../../../', import.meta.url));
	const execute = promisify(execFile);
	async function checkFrozenSource(): Promise<void> {
		const head = await execute('git', ['rev-parse', 'HEAD'], { cwd: root });
		const status = await execute('git', ['status', '--porcelain', '--untracked-files=all'], {
			cwd: root,
		});
		if (head.stdout.trim() !== target.sourceRevision || status.stdout !== '')
			throw new Error('Verification source is not the declared clean frozen revision');
	}
	await checkFrozenSource();
	const evidence = await mkdtemp(path.join(tmpdir(), '2026-10-verify-auth-'));
	onEvidence?.(evidence);
	async function runPinnedCommand(
		command: string,
		argumentsList: readonly string[],
		logName: string,
		environment: Readonly<Record<string, string>> = {},
	): Promise<void> {
		try {
			const output = await execute(command, [...argumentsList], {
				cwd: root,
				maxBuffer: 16 * 1024 * 1024,
				env: { ...process.env, ...environment },
			});
			await writeFile(path.join(evidence, logName), output.stdout + output.stderr, {
				mode: 0o600,
			});
		} catch (error) {
			const output = z
				.object({ stdout: z.string().optional(), stderr: z.string().optional() })
				.safeParse(error);
			await writeFile(
				path.join(evidence, logName),
				output.success
					? (output.data.stdout ?? '') + (output.data.stderr ?? '')
					: 'Command did not complete',
				{ mode: 0o600 },
			);
			throw new Error(`Prerequisite command failed; private evidence: ${evidence}`, {
				cause: error,
			});
		}
	}
	const pnpmVersion = await execute('pnpm', ['--version'], { cwd: root });
	if (pnpmVersion.stdout.trim() !== '10.33.0') throw new Error('Pinned pnpm version differs');
	await runPinnedCommand('pnpm', ['install', '--frozen-lockfile'], 'install.log');
	await runPinnedCommand('pnpm', ['build'], 'build.log');
	await checkFrozenSource();
	const artifacts = await prepareProofBundles(root, evidence);
	const organizationStorageModules = await prepareOrganizationStorageProof(root, evidence);
	const manifestFile = path.join(evidence, 'bundle-manifest.json');
	await writeFile(manifestFile, JSON.stringify(artifacts), { mode: 0o600, flag: 'wx' });
	let node: NodeJourneyIdentity = { kind: 'workerd' };
	if (target.kind === 'local-node') {
		const nodeManifest = await prepareNodeProofArtifacts(root, evidence);
		const nodeManifestFile = path.join(evidence, 'node-manifest.json');
		await writeFile(nodeManifestFile, JSON.stringify(nodeManifest), { mode: 0o600, flag: 'wx' });
		node = { kind: 'node', manifest: nodeManifest, manifestFile: nodeManifestFile };
	}
	const requireAuth = createRequire(new URL('../../package.json', import.meta.url));
	const vitest = path.join(path.dirname(requireAuth.resolve('vitest/package.json')), 'vitest.mjs');
	const inventoryFile = path.join(evidence, 'offered-inventory.json');
	await runPinnedCommand(
		process.execPath,
		[
			vitest,
			'list',
			'--project',
			'e2e-host',
			'packages/sign-in-test-support',
			`--json=${inventoryFile}`,
		],
		'inventory.log',
		journeyHostEnvironment(node),
	);
	const inventory = z
		.array(z.object({ name: z.string(), file: z.string(), projectName: z.literal('e2e-host') }))
		.parse(JSON.parse(await readFile(inventoryFile, 'utf8')));
	const unitInventoryFile = path.join(evidence, 'supporting-unit-inventory.json');
	await runPinnedCommand(
		process.execPath,
		[
			vitest,
			'list',
			'--project',
			'unit',
			...revisionFenceSupportingUnitFiles,
			`--json=${unitInventoryFile}`,
		],
		'supporting-unit-inventory.log',
	);
	const supportingUnits = z
		.array(z.object({ name: z.string(), file: z.string(), projectName: z.literal('unit') }))
		.parse(JSON.parse(await readFile(unitInventoryFile, 'utf8')));
	const tuple = {
		organizationStorageModules,
		supportingUnits,
		sourceRevision: target.sourceRevision,
		artifacts,
		lockfile: proofDigest(await readFile(path.join(root, 'pnpm-lock.yaml'), 'utf8')),
		configuration: artifacts.configurationSource,
		client: artifacts.clientSource,
		inventory,
		selections: {
			'revision-fence': selectAuthObservations({
				inventory,
				selectedFiles: authJourneyFiles('revision-fence'),
				journey: 'revision-fence',
				root,
			}),
			organization: selectAuthObservations({
				inventory,
				selectedFiles: authJourneyFiles('organization'),
				journey: 'organization',
				root,
			}),
			agent: selectAuthObservations({
				inventory,
				selectedFiles: authJourneyFiles('agent'),
				journey: 'agent',
				root,
			}),
			bootstrap: selectAuthObservations({
				inventory,
				selectedFiles: authJourneyFiles('bootstrap'),
				journey: 'bootstrap',
				root,
			}),
			people: selectAuthObservations({
				inventory,
				selectedFiles: authJourneyFiles('people'),
				journey: 'people',
				root,
			}),
		},
		hostSpecificExclusions: node.kind === 'node' ? workerdOnlyCallerCases : [],
		executionHost: hostname(),
		node: process.version,
		pnpm: pnpmVersion.stdout.trim(),
		...(node.kind === 'node' ? { signInHost: 'node', nodeArtifacts: node.manifest } : {}),
	};
	await writeFile(path.join(evidence, 'declared-target.json'), JSON.stringify(tuple), {
		mode: 0o600,
	});
	return {
		root,
		evidence,
		targetPath,
		target,
		node,
		artifacts,
		organizationStorageModules,
		manifestFile,
		vitest,
		inventory,
		supportingUnits,
		tuple,
		checkFrozenSource,
	};
}

/** Execute another selected journey against the exact same prepared artifact/configuration declaration. */
export async function runPreparedAuthVerification(
	prepared: PreparedAuthVerification,
	journey: AuthJourney,
): Promise<number> {
	const {
		root,
		evidence,
		targetPath,
		target,
		node,
		artifacts,
		organizationStorageModules,
		manifestFile,
		vitest,
		inventory,
		supportingUnits,
		tuple,
		checkFrozenSource,
	} = prepared;
	await checkFrozenSource();
	if (process.version !== 'v24.7.0' || hostname() !== target.executionHost)
		throw new Error('Prepared execution host/toolchain changed');
	const selectedFiles = authJourneyFiles(journey);
	const selected = selectAuthObservations({
		inventory,
		selectedFiles,
		journey,
		root,
	});
	const reportPath = path.join(evidence, journey + '-vitest.json');
	let supportingUnitPassed = 0;
	let observedStorageModules: readonly Readonly<Record<string, string>>[] = [];
	try {
		if (journey === 'revision-fence')
			supportingUnitPassed = await runSupportingAuthUnitProof({
				root,
				evidence,
				vitest,
				selected: supportingUnits,
			});
		const runtime = await runAuthProofProcess({
			command: process.execPath,
			args: [
				vitest,
				'run',
				'--project',
				'e2e-host',
				...selectedFiles,
				'--testNamePattern',
				authJourneyExecutionPattern(journey, selected),
				'--reporter=json',
				`--reporter=${path.join(root, 'packages/sign-in-test-support/src/test-fixtures/auth-proof-progress-reporter.ts')}`,
				`--outputFile=${reportPath}`,
			],
			cwd: root,
			env: {
				...process.env,
				AUTH_TEST_TARGET: targetPath,
				...(journey === 'organization' ? { AUTH_PROOF_ORGANIZATION_EVIDENCE: '1' } : {}),
				...(journey === 'revision-fence' ? { AUTH_PROOF_REVISION_EVIDENCE: '1' } : {}),
				AUTH_PROOF_MANIFEST_FILE: manifestFile,
				AUTH_PROOF_CASE_EVENTS_FILE: path.join(evidence, `${journey}-case-events.jsonl`),
				...journeyHostEnvironment(node),
			},
		});
		await writeFile(
			path.join(evidence, `${journey}-process.json`),
			JSON.stringify({
				ending: runtime.ending,
				processGroup: runtime.processGroup,
				cleanup: runtime.cleanup,
				checkedAt: new Date(controlledSignInClock.now()).toISOString(),
			}),
			{ mode: 0o600 },
		);
		await writeFile(
			path.join(evidence, journey + '-runtime.log'),
			runtime.stdout + runtime.stderr,
			{ mode: 0o600 },
		);
		if (
			runtime.ending.kind !== 'exited' ||
			runtime.ending.code !== 0 ||
			runtime.cleanup.remainingMembers.length !== 0
		) {
			process.stderr.write(`Real-target journey failed; private evidence: ${evidence}\n`);
			return 1;
		}
		if (journey === 'organization' || journey === 'revision-fence')
			observedStorageModules = requireOrganizationStorageProof(
				runtime.stdout,
				organizationStorageModules,
			);
	} catch (error) {
		await writeFile(
			path.join(evidence, `${journey}-process-error.json`),
			JSON.stringify({
				kind: 'runner-exception',
				name: error instanceof Error ? error.name : 'UnknownError',
				message: error instanceof Error ? error.message.slice(0, 500) : 'Proof runner failed',
			}),
			{ mode: 0o600 },
		);
		const output = z
			.object({ stdout: z.string().optional(), stderr: z.string().optional() })
			.safeParse(error);
		await writeFile(
			path.join(evidence, journey + '-runtime.log'),
			output.success
				? (output.data.stdout ?? '') + (output.data.stderr ?? '')
				: 'Runtime did not complete',
			{ mode: 0o600 },
		);
		process.stderr.write(`Real-target journey failed; private evidence: ${evidence}\n`);
		return 1;
	}
	const report = z
		.object({
			numPassedTests: z.number().positive(),
			numFailedTests: z.literal(0),
			numPendingTests: z.number().nonnegative(),
			success: z.literal(true),
			testResults: z.array(
				z.object({
					name: z.string(),
					assertionResults: z.array(
						z.object({
							ancestorTitles: z.array(z.string()),
							title: z.string(),
							status: z.string(),
						}),
					),
				}),
			),
		})
		.parse(JSON.parse(await readFile(reportPath, 'utf8')));
	await checkFrozenSource();
	if (
		JSON.stringify(await proofSourceIdentities(root)) !==
		JSON.stringify({
			configurationSource: artifacts.configurationSource,
			clientSource: artifacts.clientSource,
		})
	)
		throw new Error('Executed fixture sources changed');
	await Promise.all(
		proofArtifactNames.map(async (name) => {
			if (proofDigest(await readFile(artifacts[name].file, 'utf8')) !== artifacts[name].sha256)
				throw new Error('Executed artifact changed');
		}),
	);
	const actual = report.testResults.flatMap((file) =>
		file.assertionResults
			.filter((test) => test.status === 'passed')
			.map((test) => ({
				file: file.name,
				name: [...test.ancestorTitles, test.title].join(' > '),
			})),
	);
	requireMatchingAuthObservations({ selected, actual, passedCount: report.numPassedTests, root });
	const receipts = (await readdir(evidence)).filter((file) =>
		/^harness-[a-f0-9-]+\.json$/u.test(file),
	);
	if (receipts.length === 0) throw new Error('No actual harness target receipt');
	const receiptContents = await Promise.all(
		receipts.map((file) => readFile(path.join(evidence, file), 'utf8')),
	);
	const requestLimits: AuthHarnessRequestLimits[] = [];
	for (const contents of receiptContents) {
		const receipt = z
			.object({
				identity: proofBundleManifestSchema,
				ready: z.literal(true),
				readinessEvent: z.enum(journeyReadinessEvents[journey]),
				requestLimits: authHarnessRequestLimitsSchema,
				configuration: z.object({
					moduleHashes: z.object({
						auth: z.record(z.string(), z.string().length(64)),
						gateway: z.record(z.string(), z.string().length(64)),
					}),
					signIn: z.object({
						issuer: z.url(),
						toolPortalOrigin: z.literal('https://portal-test.invalid'),
						managementAudience: z.literal('https://portal-test.invalid/management'),
						ownerCliClientId: z.literal('owner-cli-local'),
						ownerCliRedirectUri: z.literal('http://127.0.0.1/callback'),
						managementHumanCheck: z.literal('remembered-login'),
						accessTokenSeconds: z.literal(300),
						turnstile: z.strictObject({
							kind: z.literal('local'),
							siteKey: z.literal(turnstileTestSiteKey),
							siteVerifyURLOverride: z.url(),
						}),
					}),
					gateway: z.object({
						SIGN_IN_ISSUER: z.string(),
						SIGN_IN_JWKS_URL: z.string(),
						TOOL_PORTAL_ORIGIN: z.string(),
						MANAGEMENT_AUDIENCE: z.string(),
						WORKSPACE_CONFIGURATIONS: z.string(),
					}),
				}),
				client: z.object({
					issuer: z.url(),
					ownerCliClientId: z.literal('owner-cli-local'),
					ownerCliRedirectUri: z.literal('http://127.0.0.1/callback'),
					managementAudience: z.literal('https://portal-test.invalid/management'),
					workspaceId: z.literal('33333333-3333-7333-8333-333333333333'),
					organizationId: z.literal('11111111-1111-7111-8111-111111111111'),
					entry: z.literal('scripts/verify-auth/owner-cli.ts'),
				}),
			})
			.parse(JSON.parse(contents));
		const config = receipt.configuration;
		const siteVerify = new URL(config.signIn.turnstile.siteVerifyURLOverride);
		if (
			siteVerify.origin !== new URL(config.signIn.issuer).origin ||
			siteVerify.pathname !== '/__auth-proof/turnstile-siteverify' ||
			siteVerify.search !== '' ||
			siteVerify.hash !== '' ||
			siteVerify.username !== '' ||
			siteVerify.password !== ''
		)
			throw new Error('Actual captcha configuration differs from the frozen local verifier');
		for (const [host, productionName] of [
			['auth', 'productionAuth'],
			['gateway', 'productionGateway'],
		] as const) {
			const hashes = config.moduleHashes[host];
			if (
				hashes['application.mjs'] !== artifacts[host].sha256 ||
				hashes['production-' + host + '.mjs'] !== artifacts[productionName].sha256 ||
				hashes['controlled-date.mjs'] !== artifacts.clock.sha256 ||
				hashes['native-signature-observer.mjs'] !== artifacts.signingObserver.sha256 ||
				hashes['worker.mjs'] !== artifacts.startup.sha256
			)
				throw new Error(
					'Actual Worker module bytes differ from the declared production/proof/clock artifacts',
				);
		}
		const configuredWorkspaces = z
			.record(
				z.uuid(),
				z.object({
					organizationId: z.uuid(),
					workspaceName: z.string(),
					mcp: z.object({
						providers: z.object({ fixture: z.object({ transport: z.object({ url: z.url() }) }) }),
					}),
				}),
			)
			.parse(JSON.parse(config.gateway.WORKSPACE_CONFIGURATIONS));
		const upstream = Object.values(configuredWorkspaces)[0]?.mcp.providers.fixture.transport.url;
		if (
			upstream === undefined ||
			new URL(upstream).hostname !== '127.0.0.1' ||
			JSON.stringify(JSON.parse(config.gateway.WORKSPACE_CONFIGURATIONS)) !==
				JSON.stringify(workspaceConfigurations(upstream))
		)
			throw new Error('Actual workspace configuration differs from the frozen fixture');
		if (
			JSON.stringify(receipt.identity) !== JSON.stringify(artifacts) ||
			new URL(config.signIn.issuer).hostname !== '127.0.0.1' ||
			receipt.client.issuer !== config.signIn.issuer ||
			config.gateway.SIGN_IN_ISSUER !== config.signIn.issuer ||
			config.gateway.SIGN_IN_JWKS_URL !== `${config.signIn.issuer}/api/auth/jwks` ||
			config.gateway.TOOL_PORTAL_ORIGIN !== config.signIn.toolPortalOrigin ||
			config.gateway.MANAGEMENT_AUDIENCE !== config.signIn.managementAudience
		)
			throw new Error('Actual configuration/client/artifacts differ from declared fixture');
		requestLimits.push(receipt.requestLimits);
	}
	const organizationEvidence =
		journey === 'organization'
			? (await readdir(evidence)).filter((file) =>
					/^organization-evidence-[a-f0-9-]+\.json$/u.test(file),
				)
			: [];
	if (journey === 'organization' && organizationEvidence.length !== receipts.length)
		throw new Error('Organization request-byte and storage evidence is missing');
	const revisionEvidence =
		journey === 'revision-fence'
			? (await readdir(evidence)).filter((file) =>
					/^revision-evidence-[a-f0-9-]+\.json$/u.test(file),
				)
			: [];
	if (journey === 'revision-fence' && revisionEvidence.length !== receipts.length)
		throw new Error('Revision storage evidence is missing');
	const requestLimitSummary = requireAdmittedRequestLimits({
		journey,
		signInHost: node.kind === 'node' ? 'node' : 'workerd',
		requestLimits,
	});
	const nodeComparison =
		node.kind === 'node'
			? await requireMatchingNodeReceipts({ evidence, node, workerReceiptCount: receipts.length })
			: null;
	await writeFile(
		path.join(evidence, journey + '-compared-target.json'),
		JSON.stringify({
			...tuple,
			receipts,
			organizationEvidence,
			storageComponentProof:
				journey === 'organization' || journey === 'revision-fence'
					? {
							layer: 'storage-component',
							expectedModules: organizationStorageModules,
							observedModules: observedStorageModules,
						}
					: null,
			revisionEvidence,
			supportingUnitProof:
				journey === 'revision-fence'
					? { layer: 'unit', passed: supportingUnitPassed, report: 'supporting-unit-vitest.json' }
					: null,
			requestLimits: requestLimitSummary,
			...(nodeComparison === null
				? {}
				: {
						nodeReceipts: nodeComparison.receiptFiles,
						nodeInvocations: nodeComparison.invocations,
					}),
			comparison: 'matched',
		}),
		{ mode: 0o600 },
	);
	process.stdout.write(
		JSON.stringify({
			journey,
			supportingUnitPassed,
			layer: 'host-e2e',
			passed: report.numPassedTests,
			failed: report.numFailedTests,
			offered: inventory.length,
			selected: selected.length,
			unselected: inventory.length - selected.length,
			reporterSkippedWithinFiles: report.numPendingTests,
			targetComparison: 'matched',
			requestLimits: requestLimitSummary,
			evidence,
		}) + '\n',
	);
	return 0;
}

/** S1 owns the local T3 agent/bootstrap journeys; B1 adds the people journey. Hosted journeys are added only with their later delivery grants. */
export async function runAuthVerification(args: readonly string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args: [...args],
		allowPositionals: true,
		options: { help: { type: 'boolean' }, 'target-file': { type: 'string' } },
	});
	if (values.help === true) {
		process.stdout.write(`Usage: pnpm verify:sign-in organization|revision-fence --target-file FILE
Runs the permanent real-workerd/D1/Better-Auth/Gateway host journey, with direct D1/DO and upstream-effect assertions.
Organization selects native stamp/renewal and organization-provisioning cases; retains private request bytes and organization/public-key readbacks. Central answers are a recording stand-in, not central CAS/key-retention proof.
Revision-fence selects native fences, person-fleet token release, revision drain/ACK, fleet-call recovery and both storage legs; supporting units isolate snapshot/session/native bounds; Node excludes the workerd deploy-backfill and no-scheduled-handler cases. Node startup backfill/no-interval wiring is separate integration proof.
S1 target JSON: {"kind":"local-workerd","sourceRevision":"<40-character checkout HEAD>","executionHost":"<target hostname>"}
Node target JSON: the same fields with "kind":"local-node" runs sign-in on sign-in-host-node behind the fixture bridge and also compares the Node dist and per-invocation Node receipts.
FILE must be an owned mode0600 regular file outside every Git checkout. Target values and credentials are not printed.
Requires a clean frozen checkout, Node24.7.0 and pnpm10.33.0; installs its frozen lockfile, builds workspace dependencies and freezes executable Worker bytes before running. Missing prerequisites and zero passing selected observations fail.
Evidence is retained in an owned OS-temp directory. Unselected journeys are reported separately; hosted identity/CPU and stronger human-intent checks remain unverified.\n`);
		return 0;
	}
	let evidenceDirectory: string | undefined;
	try {
		const journey = authJourneySchema.parse(positionals[0]);
		if (positionals.length !== 1) throw new Error('Expected exactly one verification journey');
		const prepared = await prepareAuthVerification(
			z.string().min(1).parse(values['target-file']),
			(directory) => {
				evidenceDirectory = directory;
			},
		);
		return await runPreparedAuthVerification(prepared, journey);
	} catch {
		if (evidenceDirectory !== undefined)
			process.stderr.write(`Private prerequisite/comparison evidence: ${evidenceDirectory}\n`);
		process.stderr.write(
			'Auth verification refused missing, invalid or mismatched target/prerequisites; no observation counted.\n',
		);
		return 1;
	}
}
