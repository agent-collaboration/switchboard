/// <reference types="node" />

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import ts from 'typescript';

const requiredPortalPackageExports = [
	'@agent-collaboration/sign-in-core',
	'@agent-collaboration/tool-host-core',
	'@agent-collaboration/tool-host-node',
	'@agent-collaboration/tool-host-node/catalog-typescript',
	'@agent-collaboration/tool-engine/mcp-gateway',
	'@agent-collaboration/tool-engine/upstream-mcp-connectors',
	'@agent-collaboration/tool-engine/capability-dispatch',
	'@agent-collaboration/tool-engine/standalone-tool-portal',
	'@agent-collaboration/tool-access/contracts',
	'@agent-collaboration/tool-access/authorization',
	'@agent-collaboration/agent-portal-sdk',
	'@agent-collaboration/agent-portal-sdk/adapter-boundary',
	'@agent-collaboration/agent-portal-sdk/approval-surface',
	'@agent-collaboration/agent-portal-sdk/artifact-surface',
	'@agent-collaboration/agent-portal-sdk/capability-description-surface',
	'@agent-collaboration/agent-portal-sdk/contracts',
	'@agent-collaboration/agent-portal-sdk/gateway-runtime-client',
	'@agent-collaboration/agent-portal-sdk/portal-call-surface',
	'@agent-collaboration/agent-portal-sdk/portal-event-surface',
	'@agent-collaboration/agent-portal-sdk/portable-contracts',
	'@agent-collaboration/agent-portal-sdk/testing',
	'@agent-collaboration/agent-portal-sdk/tool-portal-mcp-client',
	'@agent-collaboration/agent-portal-sdk/tool-portal-mcp-client/node-transport',
	'@agent-collaboration/tool-host-node/testing/fake-upstream-mcp-server',
] as const;

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const requiredPortalNamedExports = {
	'@agent-collaboration/sign-in-core': [
		'signInConfigurationSchema',
		'agentRegistrationSchema',
		'agentRegistrationAllowsToken',
		'registerAgentClient',
		'disableAgentClient',
		'handleSignInRequest',
		'releaseSignInResponse',
	],
	'@agent-collaboration/tool-host-core': [
		'createHostedMcpProxy',
		'createWorkspaceAuthority',
		'createVolatileAuthorityStore',
		'decideApprovalTokenUse',
		'workspaceMembershipRow',
		'workspaceConfigurationSchema',
	],
	'@agent-collaboration/tool-host-node': [
		'startNodeHost',
		'openNodeOperationStore',
		'createNodeHostComposition',
		'nodeHostConfigSchema',
		'resolveUpstreamServers',
		'createNodeProviderRuntime',
		'loadMcpConfig',
		'formatSecretValue',
		'mcpPortalConfigSchema',
		'standaloneToolPortalConfigSchema',
		'createMcpPortalConfigSchemaArtifact',
	],
	'@agent-collaboration/tool-host-node/catalog-typescript': [
		'compileCatalogTypescriptModules',
		'fingerprintCatalogTypescriptInput',
	],
	'@agent-collaboration/tool-engine/mcp-gateway': [
		'createMcpGateway',
		'createWorkspaceToolCatalog',
		'encodeToolRef',
		'decodeToolRef',
		'createAgentCatalogViewCache',
	],
	'@agent-collaboration/tool-engine/upstream-mcp-connectors': [
		'createUpstreamMcpClientRuntime',
		'redactUpstreamResponse',
		'UpstreamMcpError',
	],
	'@agent-collaboration/tool-engine/standalone-tool-portal': [
		'mergeToolPortalList',
		'mergeToolPortalSearch',
		'mergeToolPortalDescribe',
	],
	'@agent-collaboration/tool-engine/capability-dispatch': [
		'createCapabilityDispatcher',
		'dispatchInvocationSchema',
		'operationKeySchema',
		'operationRecordSchema',
		'approvalReceiptSchema',
	],
	'@agent-collaboration/tool-access/contracts': [
		'createPersonTokenVerifier',
		'personTokenClaimsSchema',
		'personProofSchema',
		'mcpConfigSchema',
		'secretValueSchema',
		'configuredCliPolicySchema',
		'toolPortalToolSelectorSchema',
		'hostAccessBinding',
		'assessAccessInput',
		'accessFacts',
		'accessProfileProjection',
		'accessAssessment',
		'assessAccessResult',
		'inputRevisions',
	],
	'@agent-collaboration/tool-access/authorization': [
		'createAccessAssessor',
		'resolvePortalAccessPolicy',
		'mcpPortalCallPolicyDecision',
		'validateCliAllowanceInvocation',
		'resolveCompiledGoogleCommand',
	],
	'@agent-collaboration/agent-portal-sdk': [
		'CapabilityReferenceSchema',
		'JsonObjectSchema',
		'JsonValueSchema',
		'PortalCallRequestSchema',
		'PortalCallResultSchema',
		'PortalDescribeRequestSchema',
		'PortalDescribeResultSchema',
		'PortalErrorSchema',
		'PortalListRequestSchema',
		'PortalListResultSchema',
		'PortalSearchRequestSchema',
		'PortalSearchResultSchema',
		'SafeDiagnosticSchema',
		'createPortalCallSurfaceJsonSchemas',
	],
	'@agent-collaboration/agent-portal-sdk/adapter-boundary': [
		'PortalAdapterEnvelopeSchema',
		'TrustedAgentScopeSchema',
	],
	'@agent-collaboration/agent-portal-sdk/approval-surface': [
		'ApprovalDecisionReferenceSchema',
		'ApprovalRequiredResultSchema',
	],
	'@agent-collaboration/agent-portal-sdk/artifact-surface': [
		'ArtifactReferenceSchema',
		'PortalArtifactReadRequestSchema',
		'PortalArtifactReadResultSchema',
		'PortalArtifactRecordSchema',
		'PortalArtifactRedactorSchema',
	],
	'@agent-collaboration/agent-portal-sdk/capability-description-surface': [
		'CapabilitySearchMatchSchema',
		'CapabilityDescriptorSchema',
		'CapabilitySummarySchema',
		'ResultExpectationSchema',
		'SafeCallingHintSchema',
		'ToolSafetySummarySchema',
		'ToolSchemaHintSchema',
		'ToolSchemaSummarySchema',
	],
	'@agent-collaboration/agent-portal-sdk/contracts': [
		'GatewayRuntimeFrameworkIdentitySchema',
		'GatewayRuntimeProjectionCohortDigestSchema',
		'GatewayRuntimeTrustedInvocationPrincipalSchema',
		'ManagedAgentProjectionSchema',
	],
	'@agent-collaboration/agent-portal-sdk/gateway-runtime-client': [
		'GatewayRuntimeClient',
		'GatewayRuntimeFrameDecoder',
		'GatewayRuntimeProtocolError',
		'GatewayRuntimeSocketReadFlow',
		'createGatewayRuntimeChunkSenderState',
		'createNodeGatewayRuntimeTransportFactory',
		'encodeGatewayRuntimeFrame',
		'reduceGatewayRuntimeChunkSenderState',
	],
	'@agent-collaboration/agent-portal-sdk/portal-call-surface': [
		'PortalCallRequestSchema',
		'PortalCallResultSchema',
		'PortalDescribeResultSchema',
		'PortalDescribeRequestSchema',
		'PortalErrorSchema',
		'PortalListResultSchema',
		'PortalListRequestSchema',
		'PortalSearchResultSchema',
		'PortalSearchRequestSchema',
	],
	'@agent-collaboration/agent-portal-sdk/portal-event-surface': [
		'PortalCancellationRequestEventSchema',
		'PortalCancellationResultEventSchema',
		'PortalDiagnosticEventSchema',
		'PortalEventSchema',
		'PortalPartialOutputEventSchema',
		'PortalProgressEventSchema',
		'SafeDiagnosticSchema',
	],
	'@agent-collaboration/agent-portal-sdk/portable-contracts': [
		'PORTABLE_CONTRACT_ADAPTERS',
		'PORTABLE_REFINEMENT_DESCRIPTORS',
		'PORTABLE_REFINEMENT_IDENTITIES',
		'assertPortableContractSchemaIsExportable',
		'encodeCanonicalJson',
	],
	'@agent-collaboration/agent-portal-sdk/testing': [
		'createPortalCallRequestFixture',
		'createPortalCallResultFixture',
	],
	'@agent-collaboration/agent-portal-sdk/tool-portal-mcp-client': ['ToolPortalMcpClient'],
	'@agent-collaboration/agent-portal-sdk/tool-portal-mcp-client/node-transport': [
		'createNodeToolPortalMcpTransport',
	],
	'@agent-collaboration/tool-host-node/testing/fake-upstream-mcp-server': [
		'createFakeUpstreamTools',
		'startFakeUpstreamMcpServer',
	],
} as const;

const requiredPortalNamedExportSpecifiers = [
	'@agent-collaboration/sign-in-core',
	'@agent-collaboration/tool-host-core',
	'@agent-collaboration/tool-engine/standalone-tool-portal',
	'@agent-collaboration/tool-host-node',
	'@agent-collaboration/tool-host-node/catalog-typescript',
	'@agent-collaboration/tool-access/contracts',
	'@agent-collaboration/tool-access/authorization',
	'@agent-collaboration/agent-portal-sdk',
	'@agent-collaboration/agent-portal-sdk/adapter-boundary',
	'@agent-collaboration/agent-portal-sdk/approval-surface',
	'@agent-collaboration/agent-portal-sdk/artifact-surface',
	'@agent-collaboration/agent-portal-sdk/capability-description-surface',
	'@agent-collaboration/agent-portal-sdk/gateway-runtime-client',
	'@agent-collaboration/agent-portal-sdk/portal-call-surface',
	'@agent-collaboration/agent-portal-sdk/portal-event-surface',
	'@agent-collaboration/agent-portal-sdk/portable-contracts',
	'@agent-collaboration/agent-portal-sdk/testing',
	'@agent-collaboration/agent-portal-sdk/tool-portal-mcp-client',
	'@agent-collaboration/agent-portal-sdk/tool-portal-mcp-client/node-transport',
	'@agent-collaboration/tool-host-node/testing/fake-upstream-mcp-server',
] as const satisfies readonly (keyof typeof requiredPortalNamedExports)[];

const deferredPortalPackageExports = [] as const;

const forbiddenPortalPackageExports = [] as const;

const forbiddenPortalNamedExports = {
	'@agent-collaboration/tool-engine/mcp-gateway': ['createOrganizationToolCatalog'],
	'@agent-collaboration/tool-host-node': [
		'startFakeUpstreamMcpServer',
		'createFakeUpstreamTools',
		'fakeUpstreamNamespace',
	],
} as const;

const forbiddenPortalNamedExportSpecifiers = [
	'@agent-collaboration/tool-engine/mcp-gateway',
	'@agent-collaboration/tool-host-node',
] as const satisfies readonly (keyof typeof forbiddenPortalNamedExports)[];

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function packageNameAndSubpathForSpecifier(specifier: string): {
	readonly packageName: string;
	readonly subpath: string;
} {
	const match = /^@(?:agent-vm|agent-collaboration)\/([^/]+)(?:\/(.+))?$/u.exec(specifier);
	if (match?.[1] === undefined) {
		throw new Error(`Portal export ${specifier} is not an @agent-vm package specifier`);
	}
	return {
		packageName: match[1],
		subpath: match[2] ?? '',
	};
}

function packageExportKeyForSubpath(subpath: string): string {
	return subpath.length === 0 ? '.' : `./${subpath}`;
}

function exportImportPathFromValue(value: unknown): string | undefined {
	if (typeof value === 'string') {
		return value;
	}
	if (isRecord(value) && typeof value.import === 'string') {
		return value.import;
	}
	return undefined;
}

function exportTypesPathFromValue(value: unknown): string | undefined {
	if (isRecord(value) && typeof value.types === 'string') {
		return value.types;
	}
	return undefined;
}

async function loadPackageJson(packageName: string): Promise<Readonly<Record<string, unknown>>> {
	const packageJsonPath = path.join(repositoryRoot, 'packages', packageName, 'package.json');
	const parsedPackageJson: unknown = JSON.parse(await readFile(packageJsonPath, 'utf8'));
	if (!isRecord(parsedPackageJson)) {
		throw new Error(`packages/${packageName}/package.json did not parse as an object`);
	}
	return parsedPackageJson;
}

async function requiredPackageExportTargetsForSpecifier(specifier: string): Promise<{
	readonly importUrl: string;
	readonly typesPath: string;
}> {
	const { packageName, subpath } = packageNameAndSubpathForSpecifier(specifier);
	const packageJson = await loadPackageJson(packageName);
	if (!isRecord(packageJson.exports)) {
		throw new Error(`Portal export ${specifier} package has no exports map`);
	}
	const exportKey = packageExportKeyForSubpath(subpath);
	const exportValue = packageJson.exports[exportKey];
	if (exportValue === undefined) {
		throw new Error(`Portal export ${specifier} is missing package export ${exportKey}`);
	}
	const importPath = exportImportPathFromValue(exportValue);
	if (importPath === undefined) {
		throw new Error(`Portal export ${specifier} has no import target in package exports`);
	}
	if (!importPath.startsWith('./dist/') || !importPath.endsWith('.js')) {
		throw new Error(
			`Portal export ${specifier} import target ${importPath} is not a built dist JavaScript export`,
		);
	}
	const typesPath = exportTypesPathFromValue(exportValue);
	if (typesPath === undefined) {
		throw new Error(`Portal export ${specifier} has no types target in package exports`);
	}
	if (!typesPath.startsWith('./dist/') || !typesPath.endsWith('.d.ts')) {
		throw new Error(
			`Portal export ${specifier} types target ${typesPath} is not a built dist declaration export`,
		);
	}
	const packageRootPath = path.resolve(repositoryRoot, 'packages', packageName);
	const resolvedTypesPath = path.resolve(packageRootPath, typesPath);
	const relativeTypesPath = path.relative(packageRootPath, resolvedTypesPath);
	if (relativeTypesPath.startsWith('..') || path.isAbsolute(relativeTypesPath)) {
		throw new Error(`Portal export ${specifier} types target escapes its package root`);
	}
	const typesFileStats = await stat(resolvedTypesPath);
	if (!typesFileStats.isFile()) {
		throw new Error(`Portal export ${specifier} types target is not a regular file: ${typesPath}`);
	}
	return {
		importUrl: pathToFileURL(path.resolve(packageRootPath, importPath)).href,
		typesPath,
	};
}

async function importRequiredPackageExport(
	specifier: string,
): Promise<Readonly<Record<string, unknown>>> {
	const moduleExports: unknown = await import(
		(await requiredPackageExportTargetsForSpecifier(specifier)).importUrl
	);
	if (!isRecord(moduleExports)) {
		throw new Error(`Portal export ${specifier} did not load a module namespace object`);
	}
	return moduleExports;
}

async function assertAgentPortalSdkRootTypesMatchPackageTypes(): Promise<void> {
	const packageJson = await loadPackageJson('agent-portal-sdk');
	if (!isRecord(packageJson.exports)) {
		throw new Error('Agent Portal SDK package has no exports map');
	}
	const rootTypesPath = exportTypesPathFromValue(packageJson.exports['.']);
	if (rootTypesPath === undefined || packageJson.types !== rootTypesPath) {
		throw new Error(
			'Agent Portal SDK package types field must match the root package export types target',
		);
	}
}

function assertBuiltDeclarationConsumerCompiles(): void {
	const configPath = path.join(
		repositoryRoot,
		'packages',
		'agent-portal-sdk',
		'type-tests',
		'built-declaration-consumer',
		'tsconfig.json',
	);
	const configFile = ts.readConfigFile(configPath, (filePath) => ts.sys.readFile(filePath));
	const diagnostics: ts.Diagnostic[] = [];
	if (configFile.error !== undefined) {
		diagnostics.push(configFile.error);
	} else {
		const parsedConfig = ts.parseJsonConfigFileContent(
			configFile.config,
			ts.sys,
			path.dirname(configPath),
			undefined,
			configPath,
		);
		diagnostics.push(...parsedConfig.errors);
		if (parsedConfig.errors.length === 0) {
			const program = ts.createProgram(parsedConfig.fileNames, parsedConfig.options);
			diagnostics.push(...ts.getPreEmitDiagnostics(program));
		}
	}
	if (diagnostics.length === 0) {
		return;
	}
	throw new Error(
		`Built Agent Portal SDK declaration consumer failed to compile:\n${ts.formatDiagnostics(
			diagnostics,
			{
				getCanonicalFileName: (fileName) => fileName,
				getCurrentDirectory: () => repositoryRoot,
				getNewLine: () => '\n',
			},
		)}`,
	);
}

async function assertRequiredExportResolves(specifier: string): Promise<void> {
	await importRequiredPackageExport(specifier);
}

async function assertRequiredNamedExportsResolve(
	specifier: keyof typeof requiredPortalNamedExports,
): Promise<number> {
	const moduleExports = await importRequiredPackageExport(specifier);
	const missingNames = requiredPortalNamedExports[specifier].filter(
		(exportName) => !Object.hasOwn(moduleExports, exportName),
	);
	if (missingNames.length > 0) {
		throw new Error(
			`Portal export ${specifier} is missing named exports: ${missingNames.join(', ')}`,
		);
	}
	return requiredPortalNamedExports[specifier].length;
}

async function assertForbiddenNamedExportsAreAbsent(
	specifier: keyof typeof forbiddenPortalNamedExports,
): Promise<number> {
	const moduleExports = await importRequiredPackageExport(specifier);
	const presentNames = forbiddenPortalNamedExports[specifier].filter((exportName) =>
		Object.hasOwn(moduleExports, exportName),
	);
	if (presentNames.length > 0) {
		throw new Error(
			`Portal export ${specifier} retains forbidden named exports: ${presentNames.join(', ')}`,
		);
	}
	return forbiddenPortalNamedExports[specifier].length;
}

async function assertDeferredExportIsAbsent(specifier: string): Promise<void> {
	const { packageName, subpath } = packageNameAndSubpathForSpecifier(specifier);
	let packageJson: Readonly<Record<string, unknown>>;
	try {
		packageJson = await loadPackageJson(packageName);
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
			return;
		}
		throw error;
	}
	if (!isRecord(packageJson.exports)) {
		return;
	}
	if (packageJson.exports[packageExportKeyForSubpath(subpath)] === undefined) {
		return;
	}
	throw new Error(`Deferred portal export unexpectedly resolved: ${specifier}`);
}

async function main(): Promise<void> {
	const { assertAuthCorePlainNodeExecution, verifyAuthPackageClosure } =
		await import('./verify-auth-package-closure.ts');
	await assertAuthCorePlainNodeExecution(
		(await requiredPackageExportTargetsForSpecifier('@agent-collaboration/sign-in-core')).importUrl,
	);
	if (process.argv.includes('--auth-core-only')) {
		process.stdout.write(
			'auth core plain Node import and policy probe: passed; full portal exports and packed closure remain unverified\n',
		);
		return;
	}
	if (process.argv.includes('--packed-auth')) await verifyAuthPackageClosure();
	const { assertToolHostNodeSourceIsRestricted, verifyToolHostNodeClosure } =
		await import('./verify-tool-host-node-closure.ts');
	await assertToolHostNodeSourceIsRestricted();
	if (process.argv.includes('--packed-host-node')) await verifyToolHostNodeClosure();
	const { assertToolEngineSourceIsPortable, verifyToolEngineClosure } =
		await import('./verify-tool-engine-closure.ts');
	await assertToolEngineSourceIsPortable();
	const { assertToolHostCoreSourceIsPortable, verifyToolHostCoreClosure } =
		await import('./verify-tool-host-core-closure.ts');
	await assertToolHostCoreSourceIsPortable();
	if (process.argv.includes('--packed-host-core') || process.argv.includes('--packed-engine'))
		await verifyToolHostCoreClosure();
	if (process.argv.includes('--packed-engine')) {
		await verifyToolEngineClosure();
	}
	if (process.argv.includes('--packed-access')) {
		const { verifyToolAccessClosure } = await import('./verify-tool-access-closure.ts');
		await verifyToolAccessClosure();
	}
	await Promise.all(
		requiredPortalPackageExports.map((specifier) => assertRequiredExportResolves(specifier)),
	);
	const namedExportCounts = await Promise.all(
		requiredPortalNamedExportSpecifiers.map((specifier) =>
			assertRequiredNamedExportsResolve(specifier),
		),
	);
	const namedExportCount = namedExportCounts.reduce(
		(totalCount, exportCount) => totalCount + exportCount,
		0,
	);
	const forbiddenNamedExportCounts = await Promise.all(
		forbiddenPortalNamedExportSpecifiers.map((specifier) =>
			assertForbiddenNamedExportsAreAbsent(specifier),
		),
	);
	const forbiddenNamedExportCount = forbiddenNamedExportCounts.reduce(
		(totalCount, exportCount) => totalCount + exportCount,
		0,
	);
	await Promise.all(
		deferredPortalPackageExports.map((specifier) => assertDeferredExportIsAbsent(specifier)),
	);
	await Promise.all(
		forbiddenPortalPackageExports.map((specifier) => assertDeferredExportIsAbsent(specifier)),
	);
	await assertAgentPortalSdkRootTypesMatchPackageTypes();
	assertBuiltDeclarationConsumerCompiles();
	process.stdout.write(
		`portal package exports: ${String(requiredPortalPackageExports.length)} required imports and declaration targets resolved, ${String(namedExportCount)} named exports present, ${String(forbiddenNamedExportCount)} forbidden named exports absent, built declaration consumer compiled, ${String(deferredPortalPackageExports.length)} deferred imports absent, ${String(forbiddenPortalPackageExports.length)} forbidden compatibility imports absent\n`,
	);
}

await main();
