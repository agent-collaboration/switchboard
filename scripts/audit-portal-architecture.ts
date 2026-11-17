import { readFile, readdir } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { collectToolHostNodeViolations } from './tool-host-node-architecture.js';
export {
	collectToolHostNodeViolations,
	isForbiddenToolHostNodeImport,
} from './tool-host-node-architecture.js';

import ts from 'typescript';

import {
	collectWorkspaceMcpBoundaryViolations,
	collectProductionReadbackViolations,
} from './workspace-mcp-boundary.ts';

export interface PortalArchitectureSourceFile {
	readonly filePath: string;
	readonly sourceText: string;
}

export interface CollectPortalArchitectureViolationsProps {
	readonly files: readonly PortalArchitectureSourceFile[];
}

const portalPackageNames = new Set([
	'sign-in-core',
	'sign-in-platform-web',
	'sign-in-host-cloudflare',
	'sign-in-owner-cli',
	'sign-in-test-support',
	'agent-portal-sdk',
	'control-protocol-contracts',
	'controller-execution-contracts',
	'gateway-runtime',
	'gateway-control-contracts',
	'mcp-portal',
	'tool-portal',
	'tool-access',
	'tool-engine',
	'tool-host-core',
	'tool-host-node',
]);

const controlContractPackageNames = new Set([
	'control-protocol-contracts',
	'gateway-control-contracts',
]);

const forbiddenBucketFolders = ['schemas', 'validation', 'mapping', 'test-support'] as const;

const runtimePortalImportPrefixes = [
	'@agent-vm/mcp-portal',
	'@agent-vm/tool-portal',
	'@agent-vm/control-protocol-contracts',
	'@agent-vm/controller-execution-contracts',
	'@agent-vm/gateway-control-contracts',
	'@agent-vm/agent-vm',
	'@agent-vm/gateway-lifecycle',
	'@agent-vm/gondolin-vm-adapter',
	'@agent-vm/managed-vm',
];

const harnessProcessBoundaryImports = new Set(['node:child_process', 'child_process', 'execa']);
const harnessWallClockImports = new Set(['node:timers/promises', 'timers/promises']);

const gatewayRuntimeForbiddenVmImportPrefixes = [
	'@agent-vm/gondolin-vm-adapter',
	'@agent-vm/managed-vm',
	'@gondolin',
] as const;

const managedToolPortalAuthoredConfigOwnerFiles = new Set([
	'packages/agent-vm/src/cli/init-command.ts',
	'packages/agent-vm/src/gateway/mcp-portal-effective-config.ts',
	'packages/agent-vm/src/operations/config-validation.ts',
	'packages/agent-vm/src/operations/mcp-portal-live-validation.ts',
]);

const gatewayRuntimeToolPortalServiceCustodyOwnerFile =
	'packages/gateway-runtime/src/managed-tool-portal-composition.ts';

const retiredToolPortalInProcessRuntimeNames = [
	'createManagedToolPortalInProcessRuntime',
	'createToolPortalInProcessEntryPoint',
] as const;

const toolPortalSemanticRouterHelperNames = [
	'mergePortalDescribe',
	'mergePortalList',
	'mergePortalSearch',
	'mergeToolPortalDescribe',
	'mergeToolPortalList',
	'mergeToolPortalSearch',
	'routePortalCall',
	'routeToolPortalCall',
] as const;

const managedControlSourcePrefixes = [
	'packages/agent-vm/src/controller/',
	'packages/gateway-runtime/src/',
	'packages/hermes-gateway/src/',
] as const;

const managedControlDocumentationPrefixes = [
	'docs/architecture/',
	'docs/getting-started/',
	'docs/reference/',
	'docs/subsystems/',
] as const;

const managedControlResiduePatterns = [
	{
		label: 'controller.vm.host:18800',
		pattern: 'controller.vm.host:18800',
	},
	{
		label: 'CONTROLLER_BASE_URL',
		pattern: 'CONTROLLER_BASE_URL',
	},
	{
		label: 'gateway-control-link',
		pattern: 'gateway-control-link',
	},
	{
		label: 'controller-lease-client',
		pattern: 'controller-lease-client',
	},
	{
		label: 'websocketBypass',
		pattern: 'websocketBypass',
	},
] as const;

const managedControlDocumentationResiduePatterns = [
	...managedControlResiduePatterns,
	{
		label: 'push-branches',
		message:
			'managed control-plane cutover docs must not teach push-branches API as a current Worker control path',
		pattern: 'push-branches',
	},
	{
		label: 'controller lease request',
		message:
			'managed control-plane cutover docs must not teach controller lease request as a current VM-facing control path',
		pattern: 'controller lease request',
	},
	{
		label: 'controller lease API',
		message:
			'managed control-plane cutover docs must not teach controller lease API as a current VM-facing control path',
		pattern: 'controller lease API',
	},
	{
		label: 'GET lease',
		message:
			'managed control-plane cutover docs must not teach GET lease as a current VM-facing control path',
		pattern: 'GET lease',
	},
	{
		label: 'POST renew',
		message:
			'managed control-plane cutover docs must not teach POST renew as a current VM-facing control path',
		pattern: 'POST renew',
	},
] as const;

function normalizedFilePath(filePath: string): string {
	return filePath.split(path.sep).join('/');
}

function portalPackageName(filePath: string): string | null {
	const match = /^packages\/([^/]+)\//u.exec(filePath);
	if (match?.[1] === undefined || !portalPackageNames.has(match[1])) {
		return null;
	}
	return match[1];
}

function isPortalSourceFile(filePath: string): boolean {
	return (
		portalPackageName(filePath) !== null && filePath.includes('/src/') && filePath.endsWith('.ts')
	);
}

function sourceFileNameWithoutTestSuffix(filePath: string): string {
	const fileName = path.posix.basename(filePath, '.ts');
	return fileName
		.replace(/\.unit\.test$/u, '')
		.replace(/\.unit\.spec$/u, '')
		.replace(/\.integration\.test$/u, '')
		.replace(/\.host\.e2e\.test$/u, '')
		.replace(/\.vm\.e2e\.test$/u, '')
		.replace(/\.hermes\.e2e\.test$/u, '')
		.replace(/\.secrets\.e2e\.test$/u, '')
		.replace(/\.llm\.e2e\.test$/u, '');
}

function isTestSourceFile(filePath: string): boolean {
	if (filePath.includes('/src/test-fixtures/legacy-baselines/')) return true;
	return (
		filePath.endsWith('.unit.test.ts') ||
		filePath.endsWith('.unit.spec.ts') ||
		filePath.endsWith('.integration.test.ts') ||
		filePath.endsWith('.host.e2e.test.ts') ||
		filePath.endsWith('.deployed.e2e.test.ts') ||
		filePath.endsWith('.vm.e2e.test.ts') ||
		filePath.endsWith('.hermes.e2e.test.ts') ||
		filePath.endsWith('.secrets.e2e.test.ts') ||
		filePath.endsWith('.llm.e2e.test.ts') ||
		filePath.endsWith('-test-fixture.ts')
	);
}

function sortedStrings(values: Iterable<string>): readonly string[] {
	const sortedValues = Array.from(values);
	// oxlint-disable-next-line unicorn/no-array-sort -- this helper sorts a fresh local array; type-aware lint treats toSorted as an error type here.
	return sortedValues.sort((leftValue, rightValue) => leftValue.localeCompare(rightValue));
}

function importedModuleSpecifiers(sourceText: string): readonly string[] {
	const specifiers = new Set<string>();
	const importPattern =
		/(?:from\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\s*\(\s*['"]([^'"]+)['"]\s*\))/gu;
	for (const match of sourceText.matchAll(importPattern)) {
		const specifier = match[1] ?? match[2] ?? match[3];
		if (specifier !== undefined) {
			specifiers.add(specifier);
		}
	}
	return sortedStrings(specifiers);
}

function collectStructureViolations(filePath: string): readonly string[] {
	if (!isPortalSourceFile(filePath)) {
		return [];
	}
	const violations: string[] = [];
	for (const folderName of forbiddenBucketFolders) {
		if (filePath.includes(`/src/${folderName}/`)) {
			violations.push(`${filePath}: new portal work must not use src/${folderName}`);
		}
	}
	if (/\/src\/models\//u.test(filePath)) {
		violations.push(`${filePath}: new portal work must not use package-wide src/models`);
	}
	const fileName = sourceFileNameWithoutTestSuffix(filePath);
	if (fileName !== 'index' && !fileName.includes('-')) {
		violations.push(`${filePath}: new portal files must use descriptive multi-word names`);
	}
	return violations;
}

function importStartsWithAny(specifier: string, prefixes: readonly string[]): boolean {
	return prefixes.some((prefix) => specifier === prefix || specifier.startsWith(`${prefix}/`));
}

function collectDependencyViolations(file: PortalArchitectureSourceFile): readonly string[] {
	const filePath = normalizedFilePath(file.filePath);
	if (isTestSourceFile(filePath)) {
		return [];
	}
	const imports = importedModuleSpecifiers(file.sourceText);
	const packageName = portalPackageName(filePath);
	if (packageName === null) {
		return [];
	}
	const violations: string[] = [];
	if (
		packageName === 'agent-portal-sdk' &&
		imports.some((specifier) => importStartsWithAny(specifier, runtimePortalImportPrefixes))
	) {
		violations.push(`${filePath}: agent-portal-sdk must not import runtime portal packages`);
	}
	if (
		packageName === 'controller-execution-contracts' &&
		imports.some((specifier) => importStartsWithAny(specifier, runtimePortalImportPrefixes))
	) {
		violations.push(
			`${filePath}: controller-execution-contracts must not import runtime portal packages`,
		);
	}
	if (
		packageName === 'tool-portal' &&
		imports.some((specifier) => importStartsWithAny(specifier, ['@agent-vm/mcp-portal/core']))
	) {
		violations.push(
			`${filePath}: Tool Portal must consume MCP Portal through @agent-vm/mcp-portal/mcp-provider-backend, not core internals`,
		);
	}
	if (controlContractPackageNames.has(packageName)) {
		const allowedContractImports =
			packageName === 'control-protocol-contracts' ? [] : ['@agent-vm/control-protocol-contracts'];
		const forbiddenImports = imports.filter(
			(specifier) =>
				importStartsWithAny(specifier, runtimePortalImportPrefixes) &&
				!importStartsWithAny(specifier, allowedContractImports),
		);
		for (const forbiddenImport of forbiddenImports) {
			violations.push(
				`${filePath}: ${packageName} must not import runtime portal packages (${forbiddenImport})`,
			);
		}
	}
	if (
		packageName === 'mcp-portal' &&
		imports.some((specifier) =>
			importStartsWithAny(specifier, [
				'@agent-vm/tool-portal',
				'@agent-vm/controller-execution-contracts',
			]),
		)
	) {
		violations.push(
			`${filePath}: MCP Portal must not import Tool Portal or controller execution contracts`,
		);
	}
	return violations;
}

function collectAgentPortalSdkGatewayRuntimeImportViolations(
	file: PortalArchitectureSourceFile,
): readonly string[] {
	const filePath = normalizedFilePath(file.filePath);
	if (
		isTestSourceFile(filePath) ||
		!filePath.startsWith('packages/agent-portal-sdk/src/') ||
		!filePath.endsWith('.ts')
	) {
		return [];
	}
	return importedModuleSpecifiers(file.sourceText)
		.filter((specifier) => importStartsWithAny(specifier, ['@agent-vm/gateway-runtime']))
		.map(
			(specifier) => `${filePath}: Agent Portal SDK must not import Gateway runtime (${specifier})`,
		);
}

function collectAgentPortalSdkPackageDependencyViolations(
	file: PortalArchitectureSourceFile,
): readonly string[] {
	const filePath = normalizedFilePath(file.filePath);
	if (filePath !== 'packages/agent-portal-sdk/package.json') {
		return [];
	}
	let parsedPackageJson: unknown;
	try {
		parsedPackageJson = JSON.parse(file.sourceText);
	} catch {
		return [];
	}
	if (!isRecord(parsedPackageJson)) {
		return [];
	}
	const violations: string[] = [];
	for (const dependencyField of ['dependencies', 'devDependencies'] as const) {
		const dependencies = parsedPackageJson[dependencyField];
		if (isRecord(dependencies) && Object.hasOwn(dependencies, '@agent-vm/gateway-runtime')) {
			violations.push(
				`${filePath}: Agent Portal SDK must not declare @agent-vm/gateway-runtime in ${dependencyField}`,
			);
		}
	}
	return violations;
}

function moduleSpecifierText(moduleSpecifier: ts.Expression | undefined): string | null {
	return moduleSpecifier !== undefined && ts.isStringLiteralLike(moduleSpecifier)
		? moduleSpecifier.text
		: null;
}

function hasExportModifier(node: ts.Node): boolean {
	return (
		ts.canHaveModifiers(node) &&
		(ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ??
			false)
	);
}

function hasToolPortalServiceFactoryCustody(file: PortalArchitectureSourceFile): boolean {
	const sourceFile = ts.createSourceFile(
		file.filePath,
		file.sourceText,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
	const toolPortalNamespaceImports = new Set<string>();
	let hasCustody = false;

	for (const statement of sourceFile.statements) {
		if (ts.isImportDeclaration(statement)) {
			const importClause = statement.importClause;
			if (importClause?.name?.text === 'createToolPortalService') {
				hasCustody = true;
			}
			const namedBindings = importClause?.namedBindings;
			if (namedBindings !== undefined && ts.isNamedImports(namedBindings)) {
				hasCustody ||= namedBindings.elements.some(
					(importSpecifier) =>
						(importSpecifier.propertyName ?? importSpecifier.name).text ===
						'createToolPortalService',
				);
			}
			const importedModuleSpecifier = moduleSpecifierText(statement.moduleSpecifier);
			if (
				namedBindings !== undefined &&
				ts.isNamespaceImport(namedBindings) &&
				importedModuleSpecifier !== null &&
				importStartsWithAny(importedModuleSpecifier, ['@agent-vm/tool-portal'])
			) {
				toolPortalNamespaceImports.add(namedBindings.name.text);
			}
		}
		if (ts.isExportDeclaration(statement)) {
			const exportedModuleSpecifier = moduleSpecifierText(statement.moduleSpecifier);
			if (
				exportedModuleSpecifier !== null &&
				importStartsWithAny(exportedModuleSpecifier, ['@agent-vm/tool-portal']) &&
				(statement.exportClause === undefined || ts.isNamespaceExport(statement.exportClause))
			) {
				hasCustody = true;
			}
			if (statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause)) {
				hasCustody ||= statement.exportClause.elements.some(
					(exportSpecifier) =>
						(exportSpecifier.propertyName ?? exportSpecifier.name).text ===
						'createToolPortalService',
				);
			}
		}
	}

	function visitNode(node: ts.Node): void {
		if (hasCustody) {
			return;
		}
		if (ts.isCallExpression(node)) {
			if (ts.isIdentifier(node.expression) && node.expression.text === 'createToolPortalService') {
				hasCustody = true;
				return;
			}
			if (
				ts.isPropertyAccessExpression(node.expression) &&
				ts.isIdentifier(node.expression.expression) &&
				toolPortalNamespaceImports.has(node.expression.expression.text) &&
				node.expression.name.text === 'createToolPortalService'
			) {
				hasCustody = true;
				return;
			}
		}
		if (
			ts.isExportAssignment(node) &&
			ts.isIdentifier(node.expression) &&
			node.expression.text === 'createToolPortalService'
		) {
			hasCustody = true;
			return;
		}
		if (
			hasExportModifier(node) &&
			(ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
			node.name?.text === 'createToolPortalService'
		) {
			hasCustody = true;
			return;
		}
		if (
			hasExportModifier(node) &&
			ts.isVariableStatement(node) &&
			node.declarationList.declarations.some(
				(declaration) =>
					ts.isIdentifier(declaration.name) && declaration.name.text === 'createToolPortalService',
			)
		) {
			hasCustody = true;
			return;
		}
		ts.forEachChild(node, visitNode);
	}

	visitNode(sourceFile);
	return hasCustody;
}

function collectToolPortalServiceCustodyViolations(
	file: PortalArchitectureSourceFile,
): readonly string[] {
	const filePath = normalizedFilePath(file.filePath);
	if (
		isTestSourceFile(filePath) ||
		!filePath.startsWith('packages/') ||
		!filePath.includes('/src/') ||
		!filePath.endsWith('.ts') ||
		filePath === 'packages/tool-portal/src/tool-portal-service.ts' ||
		!file.sourceText.includes('createToolPortalService')
	) {
		return [];
	}
	if (filePath.startsWith('packages/gateway-runtime/src/')) {
		if (
			filePath === gatewayRuntimeToolPortalServiceCustodyOwnerFile ||
			!hasToolPortalServiceFactoryCustody(file)
		) {
			return [];
		}
		return [
			`${filePath}: only ${gatewayRuntimeToolPortalServiceCustodyOwnerFile} may import, construct, or export createToolPortalService`,
		];
	}
	return [`${filePath}: only Gateway runtime may construct ToolPortalService`];
}

function collectGatewayRuntimeVmImportViolations(
	file: PortalArchitectureSourceFile,
): readonly string[] {
	const filePath = normalizedFilePath(file.filePath);
	if (
		isTestSourceFile(filePath) ||
		!filePath.startsWith('packages/gateway-runtime/src/') ||
		!filePath.endsWith('.ts')
	) {
		return [];
	}
	return importedModuleSpecifiers(file.sourceText)
		.filter((specifier) => importStartsWithAny(specifier, gatewayRuntimeForbiddenVmImportPrefixes))
		.map(
			(specifier) =>
				`${filePath}: Gateway runtime must not import managed VM or Gondolin packages (${specifier})`,
		);
}

function collectManagedToolPortalConfigOwnershipViolations(
	file: PortalArchitectureSourceFile,
): readonly string[] {
	const filePath = normalizedFilePath(file.filePath);
	if (
		!managedToolPortalAuthoredConfigOwnerFiles.has(filePath) ||
		!file.sourceText.includes('mcp-portal.config.jsonc')
	) {
		return [];
	}
	return [
		`${filePath}: managed Tool Portal paths must not consume or scaffold standalone mcp-portal.config.jsonc`,
	];
}

function collectRetiredToolPortalInProcessRuntimeViolations(
	file: PortalArchitectureSourceFile,
): readonly string[] {
	const filePath = normalizedFilePath(file.filePath);
	if (filePath.startsWith('packages/tool-portal/src/in-process-entrypoint/')) {
		return [`${filePath}: retired in-process Tool Portal runtime source and tests must not return`];
	}
	if (filePath === 'packages/tool-portal/package.json') {
		let parsedPackageJson: unknown;
		try {
			parsedPackageJson = JSON.parse(file.sourceText);
		} catch {
			return [];
		}
		return isRecord(parsedPackageJson) &&
			isRecord(parsedPackageJson.exports) &&
			Object.hasOwn(parsedPackageJson.exports, './in-process-entrypoint')
			? [`${filePath}: Tool Portal must not publish the retired ./in-process-entrypoint subpath`]
			: [];
	}
	if (
		filePath === 'packages/tool-portal/src/index.ts' &&
		(file.sourceText.includes('in-process-entrypoint') ||
			retiredToolPortalInProcessRuntimeNames.some((name) => file.sourceText.includes(name)))
	) {
		return [`${filePath}: Tool Portal root must not export the retired in-process runtime`];
	}
	if (
		filePath === 'packages/tool-portal/tsdown.config.ts' &&
		file.sourceText.includes('in-process-entrypoint')
	) {
		return [`${filePath}: Tool Portal must not build the retired in-process runtime entrypoint`];
	}
	if (
		filePath.startsWith('packages/tool-portal/src/') &&
		!isTestSourceFile(filePath) &&
		retiredToolPortalInProcessRuntimeNames.some((name) => file.sourceText.includes(name))
	) {
		return [`${filePath}: Tool Portal must not restore retired in-process runtime declarations`];
	}
	return [];
}

function declaresNamedFunctionOrVariable(sourceText: string, name: string): boolean {
	const escapedName = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
	return new RegExp(`(?:function\\s+|(?:const|let|var)\\s+)${escapedName}\\b`, 'u').test(
		sourceText,
	);
}

function collectToolPortalSemanticRouterViolations(
	file: PortalArchitectureSourceFile,
): readonly string[] {
	const filePath = normalizedFilePath(file.filePath);
	if (
		isTestSourceFile(filePath) ||
		!filePath.startsWith('packages/') ||
		!filePath.includes('/src/') ||
		!filePath.endsWith('.ts')
	) {
		return [];
	}
	return toolPortalSemanticRouterHelperNames.flatMap((helperName) => {
		const owner = helperName.startsWith('merge')
			? 'packages/tool-engine/src/standalone-tool-portal/portal-discovery-merger.ts'
			: 'packages/tool-portal/src/tool-portal-result-router.ts';
		// F-60 keeps the original independent merger until S4 removes the old package.
		const originalPreCutoverMerger =
			helperName.startsWith('merge') &&
			filePath === 'packages/tool-portal/src/tool-portal-result-router.ts';
		return filePath !== owner &&
			!originalPreCutoverMerger &&
			declaresNamedFunctionOrVariable(file.sourceText, helperName)
			? [
					`${filePath}: Tool Portal semantic router helper ${helperName} must be declared only in ${owner}`,
				]
			: [];
	});
}

function collectHarnessViolations(file: PortalArchitectureSourceFile): readonly string[] {
	const filePath = normalizedFilePath(file.filePath);
	if (!filePath.startsWith('tests/harness/agent-portal/') || !filePath.endsWith('.ts')) {
		return [];
	}
	const imports = importedModuleSpecifiers(file.sourceText);
	const violations: string[] = [];
	if (imports.some((specifier) => harnessWallClockImports.has(specifier))) {
		violations.push(
			`${filePath}: shared agent portal harnesses must not import wall-clock timer helpers`,
		);
	}
	if (imports.some((specifier) => harnessProcessBoundaryImports.has(specifier))) {
		violations.push(
			`${filePath}: shared agent portal harnesses must not import process boundary helpers`,
		);
	}
	return violations;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasErrorCode(value: unknown, code: string): boolean {
	return isRecord(value) && value.code === code;
}

function exportImportPathFromValue(value: unknown): string | null {
	if (typeof value === 'string') {
		return value;
	}
	if (isRecord(value) && typeof value.import === 'string') {
		return value.import;
	}
	return null;
}

function sourceEntryForDistImport(importPath: string): string | null {
	if (!importPath.startsWith('./dist/') || !importPath.endsWith('.js')) {
		return null;
	}
	return `src/${importPath.slice('./dist/'.length, -'.js'.length)}.ts`;
}

function collectExportEntryViolations(
	files: readonly PortalArchitectureSourceFile[],
): readonly string[] {
	const filesByPath = new Map(files.map((file) => [normalizedFilePath(file.filePath), file]));
	const violations: string[] = [];
	for (const file of files) {
		const filePath = normalizedFilePath(file.filePath);
		const packageName = portalPackageName(filePath);
		if (packageName === null || !filePath.endsWith('/package.json')) {
			continue;
		}
		let parsedPackageJson: unknown;
		try {
			parsedPackageJson = JSON.parse(file.sourceText);
		} catch {
			continue;
		}
		if (!isRecord(parsedPackageJson) || !isRecord(parsedPackageJson.exports)) {
			continue;
		}
		const packageRoot = `packages/${packageName}`;
		const tsdownConfig = filesByPath.get(`${packageRoot}/tsdown.config.ts`);
		if (tsdownConfig === undefined) {
			continue;
		}
		for (const [exportName, exportValue] of Object.entries(parsedPackageJson.exports)) {
			const importPath = exportImportPathFromValue(exportValue);
			if (importPath === null) {
				continue;
			}
			const expectedSourceEntry = sourceEntryForDistImport(importPath);
			if (expectedSourceEntry === null || tsdownConfig.sourceText.includes(expectedSourceEntry)) {
				continue;
			}
			const importPathLabel = importPath.startsWith('./') ? importPath.slice(2) : importPath;
			violations.push(
				`${filePath}: export ${exportName} points at ${importPathLabel} but ${packageRoot}/tsdown.config.ts does not include ${expectedSourceEntry}`,
			);
		}
	}
	return violations;
}

function collectPortalPackageOutputViolations(
	file: PortalArchitectureSourceFile,
): readonly string[] {
	const filePath = normalizedFilePath(file.filePath);
	if (filePath === 'packages/agent-portal-sdk/tsdown.config.ts') {
		return /\bhash\s*:\s*false\b/u.test(file.sourceText)
			? [
					`${filePath}: Agent Portal SDK must retain content-hashed internal chunks so multi-entry declaration names cannot collide`,
				]
			: [];
	}
	const packageLabelByConfigPath: Readonly<Record<string, string>> = {
		'packages/gateway-runtime/tsdown.config.ts': 'Gateway runtime',
		'packages/tool-portal/tsdown.config.ts': 'Tool Portal',
	};
	const packageLabel = packageLabelByConfigPath[filePath];
	if (packageLabel === undefined) {
		return [];
	}
	if (/\bhash\s*:\s*false\b/u.test(file.sourceText)) {
		return [];
	}
	return [
		`${filePath}: ${packageLabel} builds must disable hashed chunk names so frozen declaration filenames stay stable`,
	];
}

function collectManagedControlResidueViolations(
	file: PortalArchitectureSourceFile,
): readonly string[] {
	const filePath = normalizedFilePath(file.filePath);
	if (isTestSourceFile(filePath)) {
		return [];
	}
	const isManagedSource =
		filePath.endsWith('.ts') &&
		managedControlSourcePrefixes.some((prefix) => filePath.startsWith(prefix));
	const isShippableDocs =
		filePath.endsWith('.md') &&
		managedControlDocumentationPrefixes.some((prefix) => filePath.startsWith(prefix));
	const isManualTemplate = filePath === 'packages/agent-vm/src/cli/manual-templates.ts';
	if (!isManagedSource && !isShippableDocs && !isManualTemplate) {
		return [];
	}
	const residuePatterns =
		isShippableDocs || isManualTemplate
			? managedControlDocumentationResiduePatterns
			: managedControlResiduePatterns;
	const violations: string[] = [];
	for (const residue of residuePatterns) {
		if (file.sourceText.includes(residue.pattern)) {
			violations.push(
				'message' in residue
					? `${filePath}: ${residue.message}`
					: `${filePath}: managed control-plane cutover must not use ${residue.label}`,
			);
		}
	}
	return violations;
}

function collectGatewayLifecyclePublicRawControlViolations(
	file: PortalArchitectureSourceFile,
): readonly string[] {
	const filePath = normalizedFilePath(file.filePath);
	if (filePath !== 'packages/gateway-lifecycle/src/index.ts') {
		return [];
	}
	const violations: string[] = [];
	for (const exportedName of [
		'fetchControllerWithPolicy',
		'gatewayInternalControllerRequestOperations',
		'FetchControllerWithPolicyOptions',
		'GatewayInternalControllerRequestOperation',
	]) {
		if (file.sourceText.includes(exportedName)) {
			violations.push(
				`${filePath}: gateway-lifecycle must not publicly export raw controller helper ${exportedName}`,
			);
		}
	}
	return violations;
}

function collectManagedFrameworkChildTopologyViolations(
	file: PortalArchitectureSourceFile,
): readonly string[] {
	const filePath = normalizedFilePath(file.filePath);
	if (
		filePath === 'packages/gateway-runtime/src/runtime/managed-framework-child-supervisor.ts' ||
		filePath ===
			'packages/gateway-runtime/src/runtime/managed-framework-child-supervisor.unit.test.ts'
	) {
		return [
			`${filePath}: Gateway runtime must not own or test a managed framework child supervisor`,
		];
	}
	if (isTestSourceFile(filePath)) {
		return [];
	}
	if (
		filePath.startsWith('packages/gateway-runtime/src/') &&
		(file.sourceText.includes('ManagedFrameworkChild') ||
			file.sourceText.includes('managed-framework-child-supervisor'))
	) {
		return [
			`${filePath}: Gateway runtime must not expose managed framework child declarations or exports`,
		];
	}
	if (
		filePath.startsWith('packages/gateway-lifecycle/src/') &&
		(file.sourceText.includes('ManagedFrameworkChildRecipe') ||
			file.sourceText.includes("'managed-framework-runtime'") ||
			file.sourceText.includes('childRecipe'))
	) {
		return [
			`${filePath}: Gateway lifecycle must not declare a framework child recipe or runtime-parent variant`,
		];
	}
	if (filePath === 'packages/gateway-runtime/package.json') {
		const violations: string[] = [];
		try {
			const parsedManifest: unknown = JSON.parse(file.sourceText);
			if (
				isRecord(parsedManifest) &&
				isRecord(parsedManifest.dependencies) &&
				Object.hasOwn(parsedManifest.dependencies, '@agent-vm/gateway-lifecycle')
			) {
				violations.push(
					`${filePath}: Gateway runtime must not depend on gateway-lifecycle for framework child ownership`,
				);
			}
		} catch {
			return [];
		}
		if (file.sourceText.includes('managed-framework runtime')) {
			violations.push(
				`${filePath}: Gateway runtime package metadata must not describe framework child ownership`,
			);
		}
		return violations;
	}
	if (
		filePath === 'packages/gateway-lifecycle/package.json' &&
		file.sourceText.includes('runtime-contracts')
	) {
		return [
			`${filePath}: Gateway lifecycle must not publish the rejected child runtime-contracts entry`,
		];
	}
	if (
		filePath === 'packages/gateway-lifecycle/tsdown.config.ts' &&
		file.sourceText.includes('runtime-contracts')
	) {
		return [
			`${filePath}: Gateway lifecycle must not build the rejected child runtime-contracts entry`,
		];
	}
	return [];
}

export function collectManagedPortalCutoverViolations(
	file: PortalArchitectureSourceFile,
): readonly string[] {
	const filePath = normalizedFilePath(file.filePath);
	if (!filePath.startsWith('packages/gateway-runtime/src/') || isTestSourceFile(filePath))
		return [];
	return importedModuleSpecifiers(file.sourceText)
		.filter(
			(specifier) =>
				importStartsWithAny(specifier, ['@agent-vm/tool-portal', '@agent-vm/mcp-portal']) ||
				/\/(?:tool-portal|mcp-portal)\/src\//u.test(specifier),
		)
		.map(
			(specifier) =>
				`${filePath}: managed production must use the shared engine and owned adapters, not ${specifier}`,
		);
}

export function collectPortalArchitectureViolations(
	props: CollectPortalArchitectureViolationsProps,
): readonly string[] {
	const violations = [
		...(props.files.some((file) => file.filePath === 'packages/tool-host-cloudflare/src/index.ts')
			? collectProductionReadbackViolations(props.files)
			: []),
		...(props.files.some(
			(file) =>
				file.filePath === 'packages/tool-host-core/src/hosted-mcp-proxy/hosted-mcp-proxy.ts',
		)
			? collectWorkspaceMcpBoundaryViolations(props.files)
			: []),
		...props.files.flatMap(collectManagedPortalCutoverViolations),
		...props.files.flatMap(collectToolAccessViolations),
		...props.files.flatMap(collectToolEngineViolations),
		...props.files.flatMap(collectToolHostCoreViolations),
		...props.files.flatMap(collectAuthCoreViolations),
		...collectSignInCoreRuntimeGlobalViolations(props.files),
		...props.files.flatMap(collectSignInTestTimeViolations),
		...props.files.flatMap(collectSignInUuidViolations),
		...props.files.flatMap(collectToolHostNodeViolations),
		...props.files.flatMap(collectProductionTestAliasViolations),
		...props.files.flatMap((file) => collectStructureViolations(normalizedFilePath(file.filePath))),
		...props.files.flatMap(collectDependencyViolations),
		...props.files.flatMap(collectAgentPortalSdkGatewayRuntimeImportViolations),
		...props.files.flatMap(collectAgentPortalSdkPackageDependencyViolations),
		...props.files.flatMap(collectToolPortalServiceCustodyViolations),
		...props.files.flatMap(collectGatewayRuntimeVmImportViolations),
		...props.files.flatMap(collectManagedToolPortalConfigOwnershipViolations),
		...props.files.flatMap(collectRetiredToolPortalInProcessRuntimeViolations),
		...props.files.flatMap(collectToolPortalSemanticRouterViolations),
		...props.files.flatMap(collectHarnessViolations),
		...collectExportEntryViolations(props.files),
		...props.files.flatMap(collectPortalPackageOutputViolations),
		...props.files.flatMap(collectManagedControlResidueViolations),
		...props.files.flatMap(collectGatewayLifecyclePublicRawControlViolations),
		...props.files.flatMap(collectManagedFrameworkChildTopologyViolations),
	];
	return sortedStrings(violations);
}

const portableBuiltinNames = new Set(builtinModules.map((name) => name.replace(/^node:/u, '')));

export function isForbiddenToolAccessImport(specifier: string): boolean {
	return (
		/^@agent-collaboration\/sign-in-(?:core|platform-web|host-cloudflare|host-node|owner-cli|test-support)(?:\/|$)/u.test(
			specifier,
		) ||
		specifier.startsWith('node:') ||
		specifier.startsWith('cloudflare:') ||
		portableBuiltinNames.has(specifier) ||
		/(?:^|\/)(?:agent-vm|managed-vm|gondolin(?:-vm-adapter)?|tool-engine|tool-host-[^/]+|tool-portal|mcp-portal|gateway-runtime)(?:\/|$)/u.test(
			specifier,
		) ||
		specifier.startsWith('@gondolin/')
	);
}

export function collectToolAccessViolations(file: PortalArchitectureSourceFile): readonly string[] {
	const filePath = normalizedFilePath(file.filePath);
	if (!filePath.startsWith('packages/tool-access/src/') || isTestSourceFile(filePath)) return [];
	const violations: string[] = [];
	const source = ts.createSourceFile(filePath, file.sourceText, ts.ScriptTarget.Latest, true);
	const executionFields = new Set([
		'target',
		'executionTarget',
		'targetKind',
		'image',
		'imageId',
		'credential',
		'credentials',
		'executor',
		'executablePath',
		'workingDirectory',
		'mandatoryArgvPrefix',
	]);
	function visit(node: ts.Node): void {
		if (
			(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
			node.moduleSpecifier !== undefined &&
			ts.isStringLiteral(node.moduleSpecifier) &&
			isForbiddenToolAccessImport(node.moduleSpecifier.text)
		) {
			violations.push(`${filePath}: tool-access forbidden import ${node.moduleSpecifier.text}`);
		}
		if (
			ts.isImportTypeNode(node) &&
			ts.isLiteralTypeNode(node.argument) &&
			ts.isStringLiteral(node.argument.literal) &&
			isForbiddenToolAccessImport(node.argument.literal.text)
		) {
			violations.push(
				`${filePath}: tool-access forbidden type import ${node.argument.literal.text}`,
			);
		}
		if (
			ts.isCallExpression(node) &&
			(node.expression.kind === ts.SyntaxKind.ImportKeyword ||
				(ts.isIdentifier(node.expression) && node.expression.text === 'require'))
		) {
			const argument = node.arguments[0];
			if (
				argument !== undefined &&
				ts.isStringLiteral(argument) &&
				isForbiddenToolAccessImport(argument.text)
			)
				violations.push(`${filePath}: tool-access forbidden import ${argument.text}`);
		}
		if (
			filePath.includes('/contracts/') &&
			(ts.isPropertyAssignment(node) || ts.isPropertySignature(node)) &&
			(ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
			executionFields.has(node.name.text)
		) {
			violations.push(
				`${filePath}: tool-access execution-bearing contract field ${node.name.text}`,
			);
		}
		ts.forEachChild(node, visit);
	}
	visit(source);
	return violations;
}

function isTestOnlyPortalAlias(specifier: string): boolean {
	return (
		/^(?:legacy-(?:mcp|tool)-portal|#legacy-gateway-runtime)(?:\/|$)/u.test(specifier) ||
		/^(?:@agent-vm\/controller-test-support|@agent-collaboration\/config-contracts-test-support)(?:\/|$)/u.test(
			specifier,
		) ||
		/^@agent-vm\/tool-portal\/policy-comparison(?:\/|$)/u.test(specifier) ||
		/^@agent-vm\/mcp-portal\/testing(?:\/|$)/u.test(specifier) ||
		/^(?:@agent-collaboration\/tool-host-node\/testing|#node-host\/testing)(?:\/|$)/u.test(
			specifier,
		)
	);
}

function collectProductionTestAliasViolations(
	file: PortalArchitectureSourceFile,
): readonly string[] {
	const filePath = normalizedFilePath(file.filePath);
	if (
		!filePath.endsWith('.ts') ||
		isTestSourceFile(filePath) ||
		filePath.startsWith('tests/harness/agent-portal/') ||
		filePath.startsWith('scripts/fixtures/') ||
		filePath.includes('/contract-fixtures/')
	)
		return [];
	const violations: string[] = [];
	const source = ts.createSourceFile(filePath, file.sourceText, ts.ScriptTarget.Latest, true);
	function visit(node: ts.Node): void {
		let specifier: string | undefined;
		if (
			(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
			node.moduleSpecifier !== undefined &&
			ts.isStringLiteral(node.moduleSpecifier)
		)
			specifier = node.moduleSpecifier.text;
		else if (
			ts.isImportEqualsDeclaration(node) &&
			ts.isExternalModuleReference(node.moduleReference) &&
			node.moduleReference.expression !== undefined &&
			ts.isStringLiteral(node.moduleReference.expression)
		)
			specifier = node.moduleReference.expression.text;
		else if (
			ts.isImportTypeNode(node) &&
			ts.isLiteralTypeNode(node.argument) &&
			ts.isStringLiteral(node.argument.literal)
		)
			specifier = node.argument.literal.text;
		else if (
			ts.isCallExpression(node) &&
			(node.expression.kind === ts.SyntaxKind.ImportKeyword ||
				(ts.isIdentifier(node.expression) && node.expression.text === 'require'))
		) {
			const argument = node.arguments[0];
			if (argument !== undefined && ts.isStringLiteral(argument)) specifier = argument.text;
		}
		if (
			specifier !== undefined &&
			(isTestOnlyPortalAlias(specifier) ||
				(filePath.startsWith('packages/tool-host-node/src/') &&
					/^(?:\.\.?\/)+testing(?:\/|$)/u.test(specifier)))
		)
			violations.push(`${filePath}: production must not import test-only alias ${specifier}`);
		ts.forEachChild(node, visit);
	}
	visit(source);
	return violations;
}

export function isForbiddenToolEngineImport(specifier: string): boolean {
	return (
		/^(?:legacy-(?:mcp|tool)-portal|#legacy-gateway-runtime)(?:\/|$)/u.test(specifier) ||
		specifier === 'typescript' ||
		specifier === 'json-schema-to-typescript' ||
		specifier.startsWith('node:') ||
		specifier.startsWith('cloudflare:') ||
		portableBuiltinNames.has(specifier) ||
		/(?:^|\/)(?:agent-vm|managed-vm|gondolin(?:-vm-adapter)?|tool-host-[^/]+|tool-portal|mcp-portal|gateway-runtime|gateway-control-contracts|controller-execution-contracts|controller-test-support|config-contracts-test-support)(?:\/|$)/u.test(
			specifier,
		) ||
		specifier.startsWith('@gondolin/')
	);
}
export function isForbiddenToolHostCoreImport(specifier: string): boolean {
	return (
		/^(?:legacy-(?:mcp|tool)-portal|#legacy-gateway-runtime)(?:\/|$)/u.test(specifier) ||
		specifier === '@cloudflare/workers-types' ||
		specifier.startsWith('@cloudflare/workers-types/') ||
		specifier === 'typescript' ||
		specifier === 'json-schema-to-typescript' ||
		specifier.startsWith('node:') ||
		specifier.startsWith('cloudflare:') ||
		portableBuiltinNames.has(specifier) ||
		/(?:^|\/)(?:agent-vm|managed-vm|gondolin(?:-vm-adapter)?|tool-host-(?!core(?:\/|$))[^/]+|tool-portal|mcp-portal|gateway-runtime|gateway-control-contracts|controller-execution-contracts|controller-test-support|config-contracts-test-support)(?:\/|$)/u.test(
			specifier,
		) ||
		specifier.startsWith('@gondolin/')
	);
}
const workerGlobalNames = new Set([
	'DurableObject',
	'DurableObjectNamespace',
	'DurableObjectState',
	'DurableObjectStorage',
	'DurableObjectTransaction',
	'DurableObjectStub',
	'DurableObjectId',
	'ExecutionContext',
	'ExportedHandler',
	'Fetcher',
	'WorkerGlobalScope',
	'WebSocketPair',
	'HTMLRewriter',
	'KVNamespace',
	'R2Bucket',
	'D1Database',
	'AnalyticsEngineDataset',
	'Queue',
	'MessageBatch',
	'ScheduledEvent',
	'ScheduledController',
	'RequestInitCfProperties',
	'IncomingRequestCfProperties',
	'CacheStorage',
	'caches',
	'Cloudflare',
	'AuthWorkerEnv',
	'__BaseEnv_AuthWorkerEnv',
	'EmailMessage',
	'ForwardableEmailMessage',
]);

function collectPortableEngineViolations(
	file: PortalArchitectureSourceFile,
	packageName: 'tool-engine' | 'tool-host-core' | 'sign-in-core',
	forbiddenImport: (specifier: string) => boolean,
	sourceDirectory: string = `packages/${packageName}/src/`,
): readonly string[] {
	const filePath = normalizedFilePath(file.filePath);
	if (!filePath.startsWith(sourceDirectory) || isTestSourceFile(filePath)) return [];
	const violations: string[] = [];

	const source = ts.createSourceFile(filePath, file.sourceText, ts.ScriptTarget.Latest, true);
	function visit(node: ts.Node): void {
		if (
			packageName === 'tool-host-core' &&
			ts.isImportDeclaration(node) &&
			ts.isStringLiteral(node.moduleSpecifier) &&
			node.moduleSpecifier.text.startsWith('@modelcontextprotocol/sdk/client/')
		)
			violations.push(`${filePath}: tool-host-core must inject SDK client transports`);

		if (packageName !== 'tool-engine' && ts.isIdentifier(node) && workerGlobalNames.has(node.text))
			violations.push(`${filePath}: ${packageName} Workers global ${node.text}`);
		if (
			(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
			node.moduleSpecifier !== undefined &&
			ts.isStringLiteral(node.moduleSpecifier) &&
			forbiddenImport(node.moduleSpecifier.text)
		)
			violations.push(`${filePath}: ${packageName} forbidden import ${node.moduleSpecifier.text}`);
		if (
			ts.isImportEqualsDeclaration(node) &&
			ts.isExternalModuleReference(node.moduleReference) &&
			node.moduleReference.expression !== undefined &&
			ts.isStringLiteral(node.moduleReference.expression) &&
			forbiddenImport(node.moduleReference.expression.text)
		)
			violations.push(
				`${filePath}: ${packageName} forbidden import ${node.moduleReference.expression.text}`,
			);
		if (
			ts.isImportTypeNode(node) &&
			ts.isLiteralTypeNode(node.argument) &&
			ts.isStringLiteral(node.argument.literal) &&
			forbiddenImport(node.argument.literal.text)
		)
			violations.push(
				`${filePath}: ${packageName} forbidden type import ${node.argument.literal.text}`,
			);
		if (ts.isIdentifier(node) && node.text.startsWith('GatewayRuntime'))
			violations.push(`${filePath}: ${packageName} managed type ${node.text}`);
		if (
			ts.isCallExpression(node) &&
			(node.expression.kind === ts.SyntaxKind.ImportKeyword ||
				(ts.isIdentifier(node.expression) && node.expression.text === 'require'))
		) {
			const argument = node.arguments[0];
			if (argument !== undefined && ts.isStringLiteral(argument) && forbiddenImport(argument.text))
				violations.push(`${filePath}: ${packageName} forbidden import ${argument.text}`);
		}
		ts.forEachChild(node, visit);
	}
	if (packageName !== 'tool-engine') {
		for (const reference of source.typeReferenceDirectives) {
			if (reference.fileName === '@cloudflare/workers-types')
				violations.push(`${filePath}: ${packageName} forbidden types ${reference.fileName}`);
		}
	}
	visit(source);
	return violations;
}

export function collectToolEngineViolations(file: PortalArchitectureSourceFile): readonly string[] {
	return collectPortableEngineViolations(file, 'tool-engine', isForbiddenToolEngineImport);
}
export function collectToolHostCoreViolations(
	file: PortalArchitectureSourceFile,
): readonly string[] {
	return collectPortableEngineViolations(file, 'tool-host-core', isForbiddenToolHostCoreImport);
}

/** A runtime, storage driver or host package: never in any sign-in-core source file (U23). */
function isForbiddenSignInCoreRuntimeImport(specifier: string): boolean {
	return (
		isForbiddenToolHostCoreImport(specifier) ||
		/^(?:better-sqlite3|drizzle-orm\/(?:d1|better-sqlite3)|node:sqlite)(?:\/|$)/u.test(specifier) ||
		/(?:^|\/|#)(?:sign-in-platform-web|sign-in-host-[^/]+|sign-in-owner-cli|sign-in-test-support)(?:\/|$)/u.test(
			specifier,
		) ||
		specifier.includes('worker-configuration.gen')
	);
}

export function isForbiddenAuthCoreImport(specifier: string): boolean {
	return (
		isForbiddenSignInCoreRuntimeImport(specifier) ||
		/^(?:better-auth|@better-auth\/)/u.test(specifier) ||
		/(?:#sign-in-core\/|\/sign-in-core\/(?:src|dist)\/|@agent-collaboration\/sign-in-core\/)better-auth(?:\/|$)/u.test(
			specifier,
		)
	);
}

export function collectAuthCoreViolations(file: PortalArchitectureSourceFile): readonly string[] {
	// The core's .tsx pages and browser islands keep their Better Auth and intra-core page
	// imports; a Node, Worker, storage-driver or host import fails there as in .ts (U23).
	if (normalizedFilePath(file.filePath).endsWith('.tsx'))
		return collectPortableEngineViolations(
			file,
			'sign-in-core',
			isForbiddenSignInCoreRuntimeImport,
			'packages/sign-in-core/src/',
		);
	const isBetterAuthBoundary = normalizedFilePath(file.filePath).startsWith(
		'packages/sign-in-core/src/better-auth/',
	);
	return collectPortableEngineViolations(
		file,
		'sign-in-core',
		(specifier) => {
			if (
				isBetterAuthBoundary &&
				(/^(?:better-auth|@better-auth\/)/u.test(specifier) ||
					/(?:#sign-in-core\/|\/sign-in-core\/(?:src|dist)\/|@agent-collaboration\/sign-in-core\/)better-auth(?:\/|$)/u.test(
						specifier,
					))
			)
				return false;
			return isForbiddenAuthCoreImport(specifier);
		},
		'packages/sign-in-core/src/',
	);
}

const signInCoreSourceDirectory = 'packages/sign-in-core/src/';
const signInCoreBrowserIslandDirectory = 'packages/sign-in-core/src/pages/islands/';
const repositoryRootDirectory = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

/**
 * The only runtime globals the sign-in core's server code may use (R30, S6): language and web
 * data types that do no I/O and read no clock or randomness. It is exactly what the core used
 * at f3b2b88b, measured with the type checker. Anything else, including `crypto`, `fetch`,
 * timers, `performance`, `console` and `globalThis`, fails. Widening it is a reviewed change.
 */
const signInCoreAllowedGlobals: Readonly<Record<string, string>> = {
	AbortController: 'a cancellation object; it does no I/O and starts no timer by itself',
	Array: 'language data type',
	Boolean: 'language data type',
	Date: 'only as new Date(value): converts a time the host supplied; never reads the clock',
	Error: 'language error type',
	Headers: 'web data type for HTTP headers; no I/O',
	JSON: 'language serialization',
	Map: 'language data type',
	Math: 'language arithmetic; Math.random is excluded',
	Number: 'language data type',
	Object: 'language data type',
	Promise: 'language control flow',
	RangeError: 'language error type',
	Request: 'web data type for an HTTP request; constructing one does no I/O',
	Response: 'web data type for an HTTP response; constructing one does no I/O',
	Set: 'language data type',
	String: 'language data type',
	SyntaxError: 'language error type',
	TextEncoder: 'web data type for UTF-8 encoding',
	TypeError: 'language error type',
	URL: 'web data type for URL parsing',
	URLSearchParams: 'web data type for query strings',
	Uint8Array: 'language byte array',
	atob: 'base64 decoding of a value already in hand',
	btoa: 'base64 encoding of a value already in hand',
	encodeURIComponent: 'URL encoding of a value already in hand',
};

/** Any file Vitest runs as a test (vitest.config.ts): `*.test.ts`, `*.test.tsx`, `*.unit.spec.ts`. */
function isSignInVitestTestFile(filePath: string): boolean {
	return /\.test\.tsx?$/u.test(filePath) || filePath.endsWith('.unit.spec.ts');
}

function isTypeScriptSourcePath(filePath: string): boolean {
	return (filePath.endsWith('.ts') || filePath.endsWith('.tsx')) && !filePath.endsWith('.d.ts');
}

function lineOf(node: ts.Node): number {
	const source = node.getSourceFile();
	return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function isSignInCoreRuntimeGlobalScope(filePath: string): boolean {
	return (
		filePath.startsWith(signInCoreSourceDirectory) &&
		!filePath.startsWith(signInCoreBrowserIslandDirectory) &&
		isTypeScriptSourcePath(filePath) &&
		!isSignInVitestTestFile(filePath)
	);
}

/** Identifiers that name something rather than read a value: property, label or JSX names. */
function isNonValueIdentifier(node: ts.Identifier): boolean {
	const parent = node.parent;
	return (
		(ts.isPropertyAccessExpression(parent) && parent.name === node) ||
		(ts.isPropertyAssignment(parent) && parent.name === node) ||
		(ts.isBindingElement(parent) && parent.propertyName === node) ||
		(ts.isPropertyDeclaration(parent) && parent.name === node) ||
		(ts.isPropertySignature(parent) && parent.name === node) ||
		(ts.isMethodDeclaration(parent) && parent.name === node) ||
		(ts.isGetAccessorDeclaration(parent) && parent.name === node) ||
		(ts.isSetAccessorDeclaration(parent) && parent.name === node) ||
		(ts.isEnumMember(parent) && parent.name === node) ||
		ts.isJsxAttribute(parent) ||
		ts.isMetaProperty(parent) ||
		ts.isLabeledStatement(parent) ||
		ts.isBreakOrContinueStatement(parent) ||
		ts.isQualifiedName(parent) ||
		((ts.isJsxOpeningElement(parent) ||
			ts.isJsxSelfClosingElement(parent) ||
			ts.isJsxClosingElement(parent)) &&
			parent.tagName === node &&
			/^[a-z]/u.test(node.text))
	);
}

/** Type-only syntax is not runtime use: types, interfaces, aliases, and import or export lists. */
function isTypeOnlySyntax(node: ts.Node): boolean {
	return (
		ts.isTypeNode(node) ||
		ts.isInterfaceDeclaration(node) ||
		ts.isTypeAliasDeclaration(node) ||
		ts.isImportDeclaration(node) ||
		ts.isExportDeclaration(node) ||
		ts.isImportEqualsDeclaration(node)
	);
}

const defaultLibrarySourceFiles = new Map<string, ts.SourceFile>();

function signInCoreCompilerOptions(): ts.CompilerOptions {
	const configPath = path.join(repositoryRootDirectory, 'packages/sign-in-core/tsconfig.json');
	const read = ts.readConfigFile(configPath, (filePath) => ts.sys.readFile(filePath));
	if (read.error !== undefined)
		throw new Error(
			`Cannot read ${configPath}: ${ts.flattenDiagnosticMessageText(read.error.messageText, '\n')}`,
		);
	const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(configPath));
	return { ...parsed.options, noEmit: true };
}

/** A compiler host that reads the audited texts first, so planted cases need no files on disk. */
function auditedTextCompilerHost(
	options: ts.CompilerOptions,
	textByAbsolutePath: ReadonlyMap<string, string>,
): ts.CompilerHost {
	const host = ts.createCompilerHost(options, true);
	const defaultLibraryDirectory = path.dirname(ts.getDefaultLibFilePath(options));
	return {
		...host,
		fileExists: (fileName) => textByAbsolutePath.has(fileName) || host.fileExists(fileName),
		readFile: (fileName) => textByAbsolutePath.get(fileName) ?? host.readFile(fileName),
		getSourceFile: (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
			const text = textByAbsolutePath.get(fileName);
			if (text !== undefined)
				return ts.createSourceFile(
					fileName,
					text,
					languageVersion,
					true,
					fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
				);
			if (path.dirname(fileName) !== defaultLibraryDirectory)
				return host.getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
			const cached = defaultLibrarySourceFiles.get(fileName);
			if (cached !== undefined) return cached;
			const library = host.getSourceFile(
				fileName,
				languageVersion,
				onError,
				shouldCreateNewSourceFile,
			);
			if (library !== undefined) defaultLibrarySourceFiles.set(fileName, library);
			return library;
		},
	};
}

/**
 * S6: every value identifier in the core's server code is classified by its checker symbol.
 * No symbol (a runtime-only name such as `process` under `types: []`) and the compiler's own
 * `globalThis` are reported; `undefined` is allowed; a standard-library global passes only when
 * it is on signInCoreAllowedGlobals (Date only as `new Date(value)`, Math without `random`);
 * anything we declare ourselves, even a parameter named `crypto`, is never reported.
 */
export function collectSignInCoreRuntimeGlobalViolations(
	files: readonly PortalArchitectureSourceFile[],
): readonly string[] {
	const coreFiles = files.filter((file) =>
		isSignInCoreRuntimeGlobalScope(normalizedFilePath(file.filePath)),
	);
	if (coreFiles.length === 0) return [];
	const relativePathByAbsolutePath = new Map<string, string>();
	const textByAbsolutePath = new Map<string, string>();
	for (const file of coreFiles) {
		const relativePath = normalizedFilePath(file.filePath);
		const absolutePath = normalizedFilePath(path.join(repositoryRootDirectory, relativePath));
		relativePathByAbsolutePath.set(absolutePath, relativePath);
		textByAbsolutePath.set(absolutePath, file.sourceText);
	}
	const options = signInCoreCompilerOptions();
	const program = ts.createProgram({
		rootNames: [...textByAbsolutePath.keys()],
		options,
		host: auditedTextCompilerHost(options, textByAbsolutePath),
	});
	const checker = program.getTypeChecker();
	const violations: string[] = [];
	for (const [absolutePath, relativePath] of relativePathByAbsolutePath) {
		const source = program.getSourceFile(absolutePath);
		if (source === undefined) continue;
		const report = (node: ts.Node, finding: string): void => {
			violations.push(`${relativePath}:${lineOf(node)}: sign-in-core ${finding}`);
		};
		const classify = (node: ts.Identifier): void => {
			const symbol = ts.isShorthandPropertyAssignment(node.parent)
				? checker.getShorthandAssignmentValueSymbol(node.parent)
				: checker.getSymbolAtLocation(node);
			if (symbol === undefined) {
				report(node, `runtime name ${node.text} does not resolve under the core's settings`);
				return;
			}
			const declarations = symbol.declarations ?? [];
			if (declarations.length === 0) {
				if (symbol.escapedName === 'globalThis') report(node, 'runtime global globalThis');
				return;
			}
			const isStandardLibraryGlobal = declarations.some((declaration) =>
				program.isSourceFileDefaultLibrary(declaration.getSourceFile()),
			);
			if (!isStandardLibraryGlobal) return;
			const name = symbol.name;
			if (!Object.hasOwn(signInCoreAllowedGlobals, name)) {
				report(node, `runtime global ${name} is not on signInCoreAllowedGlobals`);
				return;
			}
			const parent = node.parent;
			if (
				name === 'Date' &&
				!(
					ts.isNewExpression(parent) &&
					parent.expression === node &&
					(parent.arguments?.length ?? 0) > 0
				)
			)
				report(node, 'runtime global Date is allowed only as new Date(value)');
			if (
				name === 'Math' &&
				(((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
					parent.expression === node &&
					knownMemberName(parent) === 'random') ||
					destructuredMemberNames(node).includes('random'))
			)
				report(node, 'runtime global Math.random');
		};
		const visit = (node: ts.Node): void => {
			if (isTypeOnlySyntax(node)) return;
			if (ts.isIdentifier(node) && !isNonValueIdentifier(node)) classify(node);
			ts.forEachChild(node, visit);
		};
		visit(source);
	}
	return violations;
}

/** S7's scope (U25): sign-in test support, every sign-in test file, and the verify-auth driver. */
function isSignInTestTimeScope(filePath: string): boolean {
	if (!isTypeScriptSourcePath(filePath)) return false;
	return (
		filePath.startsWith('packages/sign-in-test-support/src/') ||
		filePath.startsWith('scripts/verify-auth/') ||
		(/^packages\/sign-in-[^/]+\/src\//u.test(filePath) && isSignInVitestTestFile(filePath))
	);
}

const realTimerNames = new Set(['setTimeout', 'setInterval']);
/** Names that reach the runtime's global object, whose members are its real globals. */
const globalObjectNames = new Set(['globalThis', 'self', 'window']);

/**
 * The member a dotted or literal element access names: `Math.random` and `Math['random']` alike.
 * A computed key is not a known member, so it stays outside this static check.
 */
function knownMemberName(node: ts.Node): string | null {
	if (ts.isPropertyAccessExpression(node)) return node.name.text;
	if (
		ts.isElementAccessExpression(node) &&
		(ts.isStringLiteral(node.argumentExpression) ||
			ts.isNoSubstitutionTemplateLiteral(node.argumentExpression))
	)
		return node.argumentExpression.text;
	return null;
}

/**
 * The global a receiver names: `Date` itself, or `globalThis.Date` / `self['Date']` reached
 * through the global object. Any other receiver is a local value, so it names no global.
 */
function staticGlobalName(expression: ts.Expression): string | null {
	if (ts.isIdentifier(expression)) return expression.text;
	if (
		(ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) &&
		ts.isIdentifier(expression.expression) &&
		globalObjectNames.has(expression.expression.text)
	)
		return knownMemberName(expression);
	return null;
}

/** The member a destructuring element reads: `random` in `{ random }` or `{ random: draw }`. */
function bindingMemberName(element: ts.BindingElement): string | null {
	const key = element.propertyName ?? element.name;
	if (ts.isIdentifier(key) || ts.isStringLiteral(key)) return key.text;
	return null;
}

/**
 * The members statically extracted from `source` by destructuring it: `const { random } = Math`
 * or `({ random } = Math)`. Reading a member this way is the same read as `Math.random`.
 */
function destructuredMemberNames(source: ts.Expression): readonly string[] {
	const parent = source.parent;
	if (
		ts.isVariableDeclaration(parent) &&
		parent.initializer === source &&
		ts.isObjectBindingPattern(parent.name)
	)
		return parent.name.elements.flatMap((element) => bindingMemberName(element) ?? []);
	if (
		ts.isBinaryExpression(parent) &&
		parent.right === source &&
		parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
		ts.isObjectLiteralExpression(parent.left)
	)
		return parent.left.properties.flatMap((property) =>
			(ts.isShorthandPropertyAssignment(property) || ts.isPropertyAssignment(property)) &&
			(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
				? [property.name.text]
				: [],
		);
	return [];
}

function parseAuditedSource(filePath: string, sourceText: string): ts.SourceFile {
	return ts.createSourceFile(
		filePath,
		sourceText,
		ts.ScriptTarget.Latest,
		true,
		filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
	);
}

/**
 * S7: no sign-in test, helper or harness reads the real clock or waits on real time. Reports
 * setTimeout and setInterval (also as `typeof` in a type), Date.now, a zero-argument Date,
 * any read of performance, and process.hrtime and process.uptime. Vitest's `vi` fake-timer
 * calls and timer names written as strings are not calls, so they pass.
 */
export function collectSignInTestTimeViolations(
	file: PortalArchitectureSourceFile,
): readonly string[] {
	const filePath = normalizedFilePath(file.filePath);
	if (!isSignInTestTimeScope(filePath)) return [];
	const violations: string[] = [];
	const report = (node: ts.Node, finding: string): void => {
		violations.push(`${filePath}:${lineOf(node)}: sign-in test ${finding}`);
	};
	const visit = (node: ts.Node): void => {
		if (ts.isIdentifier(node)) {
			const parent = node.parent;
			const declaresMember =
				(ts.isPropertyAssignment(parent) ||
					ts.isPropertyDeclaration(parent) ||
					ts.isPropertySignature(parent) ||
					ts.isMethodDeclaration(parent)) &&
				parent.name === node;
			if (realTimerNames.has(node.text) && !declaresMember) report(node, `real timer ${node.text}`);
			if (
				node.text === 'performance' &&
				!declaresMember &&
				!(ts.isPropertyAccessExpression(parent) && parent.name === node)
			)
				report(node, 'reads performance');
		}
		const member = knownMemberName(node);
		const reportClockMember = (at: ts.Node, owner: string | null, read: string): void => {
			if (owner === 'Date' && read === 'now') report(at, 'reads the real clock with Date.now');
			if (owner === 'process' && (read === 'hrtime' || read === 'uptime'))
				report(at, `reads the real clock with process.${read}`);
		};
		if (
			member !== null &&
			(ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
		)
			reportClockMember(node, staticGlobalName(node.expression), member);
		// `const { now } = Date` reads Date.now as surely as the dotted form.
		if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
			const owner = staticGlobalName(node.initializer);
			for (const read of destructuredMemberNames(node.initializer))
				reportClockMember(node, owner, read);
		}
		// The global object's own `performance` and timers, dotted or by a literal key
		// (`globalThis.performance`, `self['setTimeout']`), are the same real clock and timers. A
		// dotted timer name is already reported as an identifier above.
		if (
			member !== null &&
			(ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
			ts.isIdentifier(node.expression) &&
			globalObjectNames.has(node.expression.text)
		) {
			if (member === 'performance') report(node, 'reads performance');
			if (ts.isElementAccessExpression(node) && realTimerNames.has(member))
				report(node, `real timer ${member}`);
		}
		if (
			(ts.isNewExpression(node) || ts.isCallExpression(node)) &&
			staticGlobalName(node.expression) === 'Date' &&
			(node.arguments?.length ?? 0) === 0
		)
			report(node, 'reads the real clock with a zero-argument Date');
		ts.forEachChild(node, visit);
	};
	visit(parseAuditedSource(filePath, file.sourceText));
	return violations;
}

function isSignInUuidScope(filePath: string): boolean {
	return (
		isTypeScriptSourcePath(filePath) &&
		(/^packages\/sign-in-[^/]+\/src\//u.test(filePath) ||
			filePath.startsWith('scripts/verify-auth/'))
	);
}

const nodeCryptoModules = new Set(['node:crypto', 'crypto']);

/** A package other than `uuid` whose name says UUID; local and `#` paths are our own files. */
function isOtherUuidModule(specifier: string): boolean {
	if (/^[.#/]/u.test(specifier) || specifier === 'uuid') return false;
	const packageName = specifier.startsWith('@')
		? specifier.split('/').slice(0, 2).join('/')
		: (specifier.split('/')[0] ?? '');
	return /uuid/iu.test(packageName);
}

/**
 * S12 (R32, U24): no UUID other than v7 is made in the sign-in packages, tests included. Reports
 * randomUUID (imported, called, or as `.randomUUID`), an import from `uuid` of anything but v7,
 * and any other UUID package. Text inside strings is not code, so it passes.
 */
export function collectSignInUuidViolations(file: PortalArchitectureSourceFile): readonly string[] {
	const filePath = normalizedFilePath(file.filePath);
	if (!isSignInUuidScope(filePath)) return [];
	const violations: string[] = [];
	const report = (node: ts.Node, finding: string): void => {
		violations.push(`${filePath}:${lineOf(node)}: sign-in UUIDv7 only: ${finding}`);
	};
	const reportImport = (node: ts.ImportDeclaration, specifier: string): void => {
		const clause = node.importClause;
		if (clause === undefined || clause.isTypeOnly) return;
		if (specifier === 'uuid' && clause.name !== undefined) report(node, 'default import from uuid');
		const bindings = clause.namedBindings;
		if (specifier === 'uuid' && bindings !== undefined && ts.isNamespaceImport(bindings))
			report(node, 'namespace import from uuid');
		if (bindings === undefined || !ts.isNamedImports(bindings)) return;
		for (const element of bindings.elements) {
			if (element.isTypeOnly) continue;
			const imported = (element.propertyName ?? element.name).text;
			if (specifier === 'uuid' && imported !== 'v7')
				report(element, `import ${imported} from uuid`);
			if (nodeCryptoModules.has(specifier) && imported === 'randomUUID')
				report(element, `import randomUUID from ${specifier}`);
		}
	};
	const visit = (node: ts.Node): void => {
		if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
			const specifier = node.moduleSpecifier.text;
			if (isOtherUuidModule(specifier)) report(node, `import of another UUID package ${specifier}`);
			if (specifier === 'uuid' || nodeCryptoModules.has(specifier)) reportImport(node, specifier);
		}
		if (
			ts.isCallExpression(node) &&
			(node.expression.kind === ts.SyntaxKind.ImportKeyword ||
				(ts.isIdentifier(node.expression) && node.expression.text === 'require'))
		) {
			const argument = node.arguments[0];
			if (
				argument !== undefined &&
				ts.isStringLiteral(argument) &&
				(argument.text === 'uuid' || isOtherUuidModule(argument.text))
			)
				report(node, `dynamic load of ${argument.text}`);
		}
		if (knownMemberName(node) === 'randomUUID') report(node, 'randomUUID');
		if (ts.isBindingElement(node) && bindingMemberName(node) === 'randomUUID')
			report(node, 'randomUUID extracted by destructuring');
		if (
			ts.isCallExpression(node) &&
			ts.isIdentifier(node.expression) &&
			node.expression.text === 'randomUUID'
		)
			report(node, 'randomUUID call');
		ts.forEachChild(node, visit);
	};
	visit(parseAuditedSource(filePath, file.sourceText));
	return violations;
}

function isSignInTsxScope(absolutePath: string): boolean {
	return (
		/\/packages\/sign-in-[^/]+\/src\//u.test(absolutePath) ||
		absolutePath.includes('/scripts/verify-auth/')
	);
}

async function collectFilesUnderDirectory(directoryPath: string): Promise<readonly string[]> {
	const entries = await readdir(directoryPath, { withFileTypes: true });
	const files = await Promise.all(
		entries.map(async (entry): Promise<readonly string[]> => {
			const entryPath = path.join(directoryPath, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === 'node_modules' || entry.name === 'dist') {
					return [];
				}
				return await collectFilesUnderDirectory(entryPath);
			}
			if (
				entry.isFile() &&
				(entry.name.endsWith('.ts') ||
					// S6, S7, S12: every .tsx under a sign-in package's src and the verify-auth driver.
					// No other package's file list widens.
					(entry.name.endsWith('.tsx') && isSignInTsxScope(normalizedFilePath(entryPath))) ||
					entry.name.endsWith('.md') ||
					entry.name === 'package.json' ||
					entry.name === 'tsdown.config.ts')
			) {
				return [entryPath];
			}
			return [];
		}),
	);
	return files.flat();
}

export async function loadRepositorySourceFiles(
	repositoryRoot: string,
): Promise<readonly PortalArchitectureSourceFile[]> {
	const sourceRoots = [
		'docs/architecture',
		'docs/getting-started',
		'docs/reference',
		'docs/subsystems',
		'packages',
		'scripts',
		'tests/harness/agent-portal',
	];
	const filesByRoot = await Promise.all(
		sourceRoots.map(async (sourceRoot): Promise<readonly PortalArchitectureSourceFile[]> => {
			const sourceRootPath = path.join(repositoryRoot, sourceRoot);
			try {
				const filePaths = await collectFilesUnderDirectory(sourceRootPath);
				return await Promise.all(
					filePaths.map(async (filePath): Promise<PortalArchitectureSourceFile> => ({
						filePath: normalizedFilePath(path.relative(repositoryRoot, filePath)),
						sourceText: await readFile(filePath, 'utf8'),
					})),
				);
			} catch (error) {
				if (!hasErrorCode(error, 'ENOENT')) {
					throw error;
				}
				return [];
			}
		}),
	);
	return filesByRoot.flat();
}

async function main(): Promise<void> {
	const repositoryRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
	const files = await loadRepositorySourceFiles(repositoryRoot);
	const managedFrameworkChildTopologyOnly = process.argv.includes(
		'--managed-framework-child-topology',
	);
	const violations = managedFrameworkChildTopologyOnly
		? sortedStrings(files.flatMap(collectManagedFrameworkChildTopologyViolations))
		: collectPortalArchitectureViolations({ files });
	if (violations.length === 0) {
		process.stdout.write(
			managedFrameworkChildTopologyOnly
				? 'managed framework child topology audit: passed\n'
				: 'portal architecture audit: passed\n',
		);
		return;
	}
	for (const violation of violations) {
		process.stderr.write(`${violation}\n`);
	}
	process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	await main();
}
