import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
	collectPortalArchitectureViolations,
	loadRepositorySourceFiles,
} from './audit-portal-architecture.ts';

describe('portal architecture audit', () => {
	it('rejects forbidden bucket folders and single-word portal files', () => {
		const violations = collectPortalArchitectureViolations({
			files: [
				{
					filePath: 'packages/tool-portal/src/schemas/tool-schema.ts',
					sourceText: '',
				},
				{
					filePath: 'packages/agent-portal-sdk/src/models/json-value-schema.ts',
					sourceText: '',
				},
				{
					filePath: 'packages/tool-portal/src/tool-portal-policy/policy.ts',
					sourceText: '',
				},
				{
					filePath: 'packages/tool-portal/src/index.ts',
					sourceText: '',
				},
				{
					filePath: 'packages/tool-portal/src/tool-portal-policy/tool-portal-policy-evaluator.ts',
					sourceText: '',
				},
			],
		});

		expect(violations).toEqual([
			'packages/agent-portal-sdk/src/models/json-value-schema.ts: new portal work must not use package-wide src/models',
			'packages/tool-portal/src/schemas/tool-schema.ts: new portal work must not use src/schemas',
			'packages/tool-portal/src/tool-portal-policy/policy.ts: new portal files must use descriptive multi-word names',
		]);
	});

	it('enforces package dependency direction for portal contract packages', () => {
		const violations = collectPortalArchitectureViolations({
			files: [
				{
					filePath:
						'packages/agent-portal-sdk/src/portal-call-surface/portal-call-request-parser.ts',
					sourceText: "import { createPortalCore } from '@agent-vm/mcp-portal/core';\n",
				},
				{
					filePath:
						'packages/controller-execution-contracts/src/controller-dispatch-boundary/controller-dispatch-intent-schema.ts',
					sourceText: "import { createToolPortal } from '@agent-vm/tool-portal';\n",
				},
				{
					filePath:
						'packages/tool-portal/src/mcp-backed-capabilities/mcp-backed-capability-dispatcher.ts',
					sourceText:
						"import { createMcpProviderCapabilityBackend } from '@agent-vm/mcp-portal/mcp-provider-backend';\n",
				},
				{
					filePath: 'packages/tool-portal/src/mcp-backed-capabilities/mcp-core-dispatcher.ts',
					sourceText: "import { createPortalCore } from '@agent-vm/mcp-portal/core';\n",
				},
				{
					filePath:
						'packages/tool-portal/src/mcp-backed-capabilities/mcp-backed-capability-dispatcher.integration.test.ts',
					sourceText: "import { createPortalCore } from '@agent-vm/mcp-portal/core';\n",
				},
				{
					filePath:
						'packages/tool-portal/src/mcp-backed-capabilities/hermes-managed-capability.hermes.e2e.test.ts',
					sourceText: "import { createPortalCore } from '@agent-vm/mcp-portal/core';\n",
				},
			],
		});

		expect(violations).toEqual([
			'packages/agent-portal-sdk/src/portal-call-surface/portal-call-request-parser.ts: agent-portal-sdk must not import runtime portal packages',
			'packages/controller-execution-contracts/src/controller-dispatch-boundary/controller-dispatch-intent-schema.ts: controller-execution-contracts must not import runtime portal packages',
			'packages/tool-portal/src/mcp-backed-capabilities/mcp-core-dispatcher.ts: Tool Portal must consume MCP Portal through @agent-vm/mcp-portal/mcp-provider-backend, not core internals',
		]);
	});

	it('rejects Gateway runtime imports from Agent Portal SDK production source', () => {
		// Arrange / Act
		const violations = collectPortalArchitectureViolations({
			files: [
				{
					filePath:
						'packages/agent-portal-sdk/src/gateway-runtime-client/bare-gateway-runtime-import.ts',
					sourceText: "import { createGatewayRuntime } from '@agent-vm/gateway-runtime';\n",
				},
				{
					filePath:
						'packages/agent-portal-sdk/src/gateway-runtime-client/gateway-runtime-protocol-import.ts',
					sourceText:
						"import { gatewayRuntimeProtocolVersion } from '@agent-vm/gateway-runtime/protocol';\n",
				},
				{
					filePath:
						'packages/agent-portal-sdk/src/gateway-runtime-client/gateway-runtime-flow-control-import.ts',
					sourceText:
						"import { createFlowController } from '@agent-vm/gateway-runtime/flow-control';\n",
				},
				{
					filePath:
						'packages/agent-portal-sdk/src/gateway-runtime-client/gateway-runtime-import.unit.test.ts',
					sourceText: "import { createGatewayRuntime } from '@agent-vm/gateway-runtime';\n",
				},
			],
		});

		// Assert
		expect(violations).toEqual([
			'packages/agent-portal-sdk/src/gateway-runtime-client/bare-gateway-runtime-import.ts: Agent Portal SDK must not import Gateway runtime (@agent-vm/gateway-runtime)',
			'packages/agent-portal-sdk/src/gateway-runtime-client/gateway-runtime-flow-control-import.ts: Agent Portal SDK must not import Gateway runtime (@agent-vm/gateway-runtime/flow-control)',
			'packages/agent-portal-sdk/src/gateway-runtime-client/gateway-runtime-protocol-import.ts: Agent Portal SDK must not import Gateway runtime (@agent-vm/gateway-runtime/protocol)',
		]);
	});

	it('rejects Agent Portal SDK package dependencies on Gateway runtime', () => {
		// Arrange
		const packageJsonWithDependency = JSON.stringify({
			dependencies: {
				'@agent-vm/gateway-runtime': 'workspace:*',
			},
		});
		const packageJsonWithDevelopmentDependency = JSON.stringify({
			devDependencies: {
				'@agent-vm/gateway-runtime': 'workspace:*',
			},
		});

		// Act
		const dependencyViolations = collectPortalArchitectureViolations({
			files: [
				{
					filePath: 'packages/agent-portal-sdk/package.json',
					sourceText: packageJsonWithDependency,
				},
			],
		});
		const developmentDependencyViolations = collectPortalArchitectureViolations({
			files: [
				{
					filePath: 'packages/agent-portal-sdk/package.json',
					sourceText: packageJsonWithDevelopmentDependency,
				},
			],
		});

		// Assert
		expect({
			dependencies: dependencyViolations,
			devDependencies: developmentDependencyViolations,
		}).toEqual({
			dependencies: [
				'packages/agent-portal-sdk/package.json: Agent Portal SDK must not declare @agent-vm/gateway-runtime in dependencies',
			],
			devDependencies: [
				'packages/agent-portal-sdk/package.json: Agent Portal SDK must not declare @agent-vm/gateway-runtime in devDependencies',
			],
		});
	});

	it('allows only managed Gateway runtime production to construct ToolPortalService', () => {
		// Arrange / Act
		const violations = collectPortalArchitectureViolations({
			files: [
				{
					filePath: 'packages/agent-portal-sdk/src/cli/tool-portal-cli.ts',
					sourceText:
						'export function createCli(): unknown { return createToolPortalService({}); }\n',
				},
				{
					filePath: 'packages/tool-portal/src/duplicate-tool-portal-service.ts',
					sourceText:
						"import { createToolPortalService } from '../tool-portal-service.js';\ncreateToolPortalService({});\n",
				},
				{
					filePath: 'packages/gateway-runtime/src/managed-tool-portal-composition.ts',
					sourceText:
						"import { createToolPortalService } from '@agent-vm/tool-portal';\ncreateToolPortalService({});\n",
				},
				{
					filePath: 'packages/tool-portal/src/tool-portal-service.ts',
					sourceText:
						'export function createToolPortalService(): ToolPortalService { return service; }\n',
				},
				{
					filePath: 'packages/tool-portal/src/tool-portal-service-test-fixture.ts',
					sourceText:
						"import { createToolPortalService } from './tool-portal-service.js';\ncreateToolPortalService({});\n",
				},
			],
		});

		// Assert
		expect(violations).toEqual([
			'packages/agent-portal-sdk/src/cli/tool-portal-cli.ts: only Gateway runtime may construct ToolPortalService',
			'packages/gateway-runtime/src/managed-tool-portal-composition.ts: managed production must use the shared engine and owned adapters, not @agent-vm/tool-portal',
			'packages/tool-portal/src/duplicate-tool-portal-service.ts: only Gateway runtime may construct ToolPortalService',
		]);
	});

	it('rejects the retired public in-process Tool Portal runtime and subpath', () => {
		// Arrange / Act
		const violations = collectPortalArchitectureViolations({
			files: [
				{
					filePath: 'packages/tool-portal/package.json',
					sourceText: JSON.stringify({
						exports: {
							'./in-process-entrypoint': {
								import: './dist/in-process-entrypoint/index.js',
							},
						},
					}),
				},
				{
					filePath: 'packages/tool-portal/src/in-process-entrypoint/index.ts',
					sourceText: "export * from './managed-tool-portal-runtime.js';\n",
				},
				{
					filePath: 'packages/tool-portal/src/index.ts',
					sourceText: "export * from './in-process-entrypoint/index.js';\n",
				},
				{
					filePath: 'packages/tool-portal/src/restored-runtime.ts',
					sourceText: 'export function createManagedToolPortalInProcessRuntime(): void {}\n',
				},
				{
					filePath: 'packages/tool-portal/tsdown.config.ts',
					sourceText:
						"export default defineConfig({ entry: ['src/index.ts', 'src/in-process-entrypoint/index.ts'], hash: false });\n",
				},
			],
		});

		// Assert
		expect(violations).toEqual([
			'packages/tool-portal/package.json: Tool Portal must not publish the retired ./in-process-entrypoint subpath',
			'packages/tool-portal/src/in-process-entrypoint/index.ts: retired in-process Tool Portal runtime source and tests must not return',
			'packages/tool-portal/src/index.ts: Tool Portal root must not export the retired in-process runtime',
			'packages/tool-portal/src/restored-runtime.ts: Tool Portal must not restore retired in-process runtime declarations',
			'packages/tool-portal/tsdown.config.ts: Tool Portal must not build the retired in-process runtime entrypoint',
		]);
	});

	it('allows only the managed Gateway runtime composition to import, construct, or export ToolPortalService', () => {
		// Arrange / Act
		const violations = collectPortalArchitectureViolations({
			files: [
				{
					filePath: 'packages/gateway-runtime/src/managed-tool-portal-composition.ts',
					sourceText:
						"import { createToolPortalService } from '@agent-vm/tool-portal';\ncreateToolPortalService({});\n",
				},
				{
					filePath: 'packages/gateway-runtime/src/duplicate-tool-portal-import.ts',
					sourceText:
						"import { createToolPortalService as buildToolPortalService } from '@agent-vm/tool-portal';\n",
				},
				{
					filePath: 'packages/gateway-runtime/src/duplicate-tool-portal-constructor.ts',
					sourceText: 'const duplicateService = createToolPortalService({});\n',
				},
				{
					filePath: 'packages/gateway-runtime/src/duplicate-tool-portal-export.ts',
					sourceText: "export { createToolPortalService } from '@agent-vm/tool-portal';\n",
				},
				{
					filePath: 'packages/gateway-runtime/src/tool-portal-projections.ts',
					sourceText:
						'const service = props.createToolPortalService({ approvalPort, semanticSnapshot });\n',
				},
				{
					filePath: 'packages/gateway-runtime/src/duplicate-tool-portal-constructor.unit.test.ts',
					sourceText:
						"import { createToolPortalService } from '@agent-vm/tool-portal';\ncreateToolPortalService({});\n",
				},
			],
		});

		// Assert
		expect(violations).toEqual([
			'packages/gateway-runtime/src/duplicate-tool-portal-constructor.ts: only packages/gateway-runtime/src/managed-tool-portal-composition.ts may import, construct, or export createToolPortalService',
			'packages/gateway-runtime/src/duplicate-tool-portal-export.ts: managed production must use the shared engine and owned adapters, not @agent-vm/tool-portal',
			'packages/gateway-runtime/src/duplicate-tool-portal-export.ts: only packages/gateway-runtime/src/managed-tool-portal-composition.ts may import, construct, or export createToolPortalService',
			'packages/gateway-runtime/src/duplicate-tool-portal-import.ts: managed production must use the shared engine and owned adapters, not @agent-vm/tool-portal',
			'packages/gateway-runtime/src/duplicate-tool-portal-import.ts: only packages/gateway-runtime/src/managed-tool-portal-composition.ts may import, construct, or export createToolPortalService',
			'packages/gateway-runtime/src/managed-tool-portal-composition.ts: managed production must use the shared engine and owned adapters, not @agent-vm/tool-portal',
		]);
	});

	it('rejects managed VM and Gondolin imports from Gateway runtime production', () => {
		// Arrange / Act
		const violations = collectPortalArchitectureViolations({
			files: [
				{
					filePath: 'packages/gateway-runtime/src/gondolin-adapter-leak.ts',
					sourceText:
						"import { createGondolinManagedVmProvider } from '@agent-vm/gondolin-vm-adapter';\n",
				},
				{
					filePath: 'packages/gateway-runtime/src/gondolin-sdk-leak.ts',
					sourceText: "import { VM } from '@gondolin/gondolin';\n",
				},
				{
					filePath: 'packages/gateway-runtime/src/managed-vm-leak.ts',
					sourceText: "import type { ManagedVm } from '@agent-vm/managed-vm';\n",
				},
				{
					filePath: 'packages/gateway-runtime/src/runtime-composition.unit.test.ts',
					sourceText:
						"import type { ManagedVm } from '@agent-vm/managed-vm';\nimport { VM } from '@gondolin/gondolin';\n",
				},
			],
		});

		// Assert
		expect(violations).toEqual([
			'packages/gateway-runtime/src/gondolin-adapter-leak.ts: Gateway runtime must not import managed VM or Gondolin packages (@agent-vm/gondolin-vm-adapter)',
			'packages/gateway-runtime/src/gondolin-sdk-leak.ts: Gateway runtime must not import managed VM or Gondolin packages (@gondolin/gondolin)',
			'packages/gateway-runtime/src/managed-vm-leak.ts: Gateway runtime must not import managed VM or Gondolin packages (@agent-vm/managed-vm)',
		]);
	});

	it('rejects standalone MCP Portal config ownership from managed Tool Portal paths', () => {
		// Arrange / Act
		const violations = collectPortalArchitectureViolations({
			files: [
				{
					filePath: 'packages/agent-vm/src/gateway/mcp-portal-effective-config.ts',
					sourceText: "loadConfig('mcp-portal.config.jsonc');\n",
				},
				{
					filePath: 'packages/agent-vm/src/operations/config-validation.ts',
					sourceText: "validateConfig('mcp-portal.config.jsonc');\n",
				},
				{
					filePath: 'packages/agent-vm/src/cli/init-command.ts',
					sourceText: "scaffoldConfig('mcp-portal.config.jsonc');\n",
				},
				{
					filePath: 'packages/mcp-portal/src/bin/mcp-portal.ts',
					sourceText: "loadConfig('mcp-portal.config.jsonc');\n",
				},
			],
		});

		// Assert
		expect(violations).toEqual([
			'packages/agent-vm/src/cli/init-command.ts: managed Tool Portal paths must not consume or scaffold standalone mcp-portal.config.jsonc',
			'packages/agent-vm/src/gateway/mcp-portal-effective-config.ts: managed Tool Portal paths must not consume or scaffold standalone mcp-portal.config.jsonc',
			'packages/agent-vm/src/operations/config-validation.ts: managed Tool Portal paths must not consume or scaffold standalone mcp-portal.config.jsonc',
		]);
	});

	it('keeps the new engine merger and the F-60 original independent until S4', () => {
		// Arrange / Act
		const violations = collectPortalArchitectureViolations({
			files: [
				{
					filePath: 'packages/gateway-runtime/src/copied-tool-portal-router.ts',
					sourceText: 'async function routePortalCall(): Promise<unknown> { return {}; }\n',
				},
				{
					filePath: 'packages/tool-portal/src/copied-tool-portal-router.ts',
					sourceText:
						'async function routePortalCall(): Promise<unknown> { return {}; }\nasync function mergePortalList(): Promise<unknown> { return {}; }\n',
				},
				{
					filePath: 'packages/tool-portal/src/tool-portal-result-router.ts',
					sourceText:
						'export async function routePortalCall(): Promise<unknown> { return {}; }\nexport async function mergeToolPortalList(): Promise<unknown> { return {}; }\n',
				},
				{
					filePath: 'packages/tool-engine/src/standalone-tool-portal/portal-discovery-merger.ts',
					sourceText:
						'export async function mergePortalList(): Promise<unknown> { return {}; }\nexport async function mergeToolPortalList(): Promise<unknown> { return {}; }\n',
				},
				{
					filePath: 'packages/tool-portal/src/tool-portal-result-router.unit.test.ts',
					sourceText:
						'function routePortalCall(): unknown { return {}; }\nconst mergePortalList = (): unknown => ({});\n',
				},
			],
		});

		// Assert
		expect(violations).toEqual([
			'packages/gateway-runtime/src/copied-tool-portal-router.ts: Tool Portal semantic router helper routePortalCall must be declared only in packages/tool-portal/src/tool-portal-result-router.ts',
			'packages/tool-portal/src/copied-tool-portal-router.ts: Tool Portal semantic router helper mergePortalList must be declared only in packages/tool-engine/src/standalone-tool-portal/portal-discovery-merger.ts',
			'packages/tool-portal/src/copied-tool-portal-router.ts: Tool Portal semantic router helper routePortalCall must be declared only in packages/tool-portal/src/tool-portal-result-router.ts',
		]);
	});

	it('rejects unsafe shared harness helpers', () => {
		const violations = collectPortalArchitectureViolations({
			files: [
				{
					filePath: 'tests/harness/agent-portal/fake-tool-portal-controller.ts',
					sourceText: "import { spawn } from 'node:child_process';\n",
				},
				{
					filePath: 'tests/harness/agent-portal/fake-managed-vm-runner.ts',
					sourceText: "import { setTimeout } from 'node:timers/promises';\n",
				},
			],
		});

		expect(violations).toEqual([
			'tests/harness/agent-portal/fake-managed-vm-runner.ts: shared agent portal harnesses must not import wall-clock timer helpers',
			'tests/harness/agent-portal/fake-tool-portal-controller.ts: shared agent portal harnesses must not import process boundary helpers',
		]);
	});

	it('requires public exports to have matching tsdown entries', () => {
		const violations = collectPortalArchitectureViolations({
			files: [
				{
					filePath: 'packages/mcp-portal/package.json',
					sourceText: JSON.stringify({
						exports: {
							'./mcp-provider-backend': {
								import: './dist/mcp-provider-backend/index.js',
								types: './dist/mcp-provider-backend/index.d.ts',
							},
						},
					}),
				},
				{
					filePath: 'packages/mcp-portal/tsdown.config.ts',
					sourceText: "export default defineConfig({ entry: ['src/index.ts'] });\n",
				},
			],
		});

		expect(violations).toEqual([
			'packages/mcp-portal/package.json: export ./mcp-provider-backend points at dist/mcp-provider-backend/index.js but packages/mcp-portal/tsdown.config.ts does not include src/mcp-provider-backend/index.ts',
		]);
	});

	it('requires collision-safe SDK chunks and deterministic single-entry declaration names', () => {
		// Arrange / Act
		const violations = collectPortalArchitectureViolations({
			files: [
				{
					filePath: 'packages/agent-portal-sdk/tsdown.config.ts',
					sourceText: 'export default defineConfig({ dts: true, hash: false });\n',
				},
				{
					filePath: 'packages/tool-portal/tsdown.config.ts',
					sourceText: 'export default defineConfig({ dts: true });\n',
				},
				{
					filePath: 'packages/gateway-runtime/tsdown.config.ts',
					sourceText: 'export default defineConfig({ dts: true });\n',
				},
			],
		});

		// Assert
		expect(violations).toEqual([
			'packages/agent-portal-sdk/tsdown.config.ts: Agent Portal SDK must retain content-hashed internal chunks so multi-entry declaration names cannot collide',
			'packages/gateway-runtime/tsdown.config.ts: Gateway runtime builds must disable hashed chunk names so frozen declaration filenames stay stable',
			'packages/tool-portal/tsdown.config.ts: Tool Portal builds must disable hashed chunk names so frozen declaration filenames stay stable',
		]);
	});

	it('rejects public gateway-lifecycle exports for raw controller helpers', () => {
		const violations = collectPortalArchitectureViolations({
			files: [
				{
					filePath: 'packages/gateway-lifecycle/src/index.ts',
					sourceText:
						"export { fetchControllerWithPolicy, gatewayInternalControllerRequestOperations } from './health/controller-request-policy.js';\nexport type { FetchControllerWithPolicyOptions, GatewayInternalControllerRequestOperation } from './health/controller-request-policy.js';\n",
				},
			],
		});

		expect(violations).toEqual([
			'packages/gateway-lifecycle/src/index.ts: gateway-lifecycle must not publicly export raw controller helper fetchControllerWithPolicy',
			'packages/gateway-lifecycle/src/index.ts: gateway-lifecycle must not publicly export raw controller helper FetchControllerWithPolicyOptions',
			'packages/gateway-lifecycle/src/index.ts: gateway-lifecycle must not publicly export raw controller helper GatewayInternalControllerRequestOperation',
			'packages/gateway-lifecycle/src/index.ts: gateway-lifecycle must not publicly export raw controller helper gatewayInternalControllerRequestOperations',
		]);
	});

	it('allows negative contract tests to name rejected child-topology fields', () => {
		// Arrange / Act
		const violations = collectPortalArchitectureViolations({
			files: [
				{
					filePath: 'packages/gateway-lifecycle/src/managed-gateway-boot-contract.unit.test.ts',
					sourceText:
						"expect(() => parseBootContract({ childRecipe: { kind: 'managed-framework-runtime' } })).toThrow();\n",
				},
			],
		});

		// Assert
		expect(violations).toEqual([]);
	});
});

const plantedCorePath = 'packages/sign-in-core/src/organizations/planted-runtime-slip.ts';

function auditOne(filePath: string, sourceText: string): readonly string[] {
	return collectPortalArchitectureViolations({ files: [{ filePath, sourceText }] });
}

describe('sign-in core runtime globals (S6, R30)', () => {
	it.each([
		{
			name: 'crypto.randomUUID() in a .tsx page',
			filePath: 'packages/sign-in-core/src/pages/planted-page-slip.tsx',
			sourceText: 'export const nonce = crypto.randomUUID();\n',
			expected: [
				'packages/sign-in-core/src/pages/planted-page-slip.tsx:1: sign-in UUIDv7 only: randomUUID',
				'packages/sign-in-core/src/pages/planted-page-slip.tsx:1: sign-in-core runtime global crypto is not on signInCoreAllowedGlobals',
			],
		},
		{
			name: 'globalThis.crypto.subtle.digest in a .ts file',
			filePath: plantedCorePath,
			sourceText:
				"export const digest = (bytes: Uint8Array<ArrayBuffer>) =>\n\tglobalThis.crypto.subtle.digest('SHA-256', bytes);\n",
			expected: [`${plantedCorePath}:2: sign-in-core runtime global globalThis`],
		},
		{
			name: 'crypto.randomUUID() hidden in a template expression',
			filePath: plantedCorePath,
			sourceText:
				'export const script = `<script>const id = "${crypto.randomUUID()}";</script>`;\n',
			expected: [
				`${plantedCorePath}:1: sign-in UUIDv7 only: randomUUID`,
				`${plantedCorePath}:1: sign-in-core runtime global crypto is not on signInCoreAllowedGlobals`,
			],
		},
		{
			name: 'Date.now()',
			filePath: plantedCorePath,
			sourceText: 'export const now = Date.now();\n',
			expected: [
				`${plantedCorePath}:1: sign-in-core runtime global Date is allowed only as new Date(value)`,
			],
		},
		{
			name: 'a zero-argument new Date()',
			filePath: plantedCorePath,
			sourceText: 'export const now = new Date();\n',
			expected: [
				`${plantedCorePath}:1: sign-in-core runtime global Date is allowed only as new Date(value)`,
			],
		},
		{
			name: 'performance.now()',
			filePath: plantedCorePath,
			sourceText: 'export const now = performance.now();\n',
			expected: [
				`${plantedCorePath}:1: sign-in-core runtime global performance is not on signInCoreAllowedGlobals`,
			],
		},
		{
			name: 'setTimeout',
			filePath: plantedCorePath,
			sourceText: 'export const wait = (run: () => void) => setTimeout(run, 1);\n',
			expected: [
				`${plantedCorePath}:1: sign-in-core runtime global setTimeout is not on signInCoreAllowedGlobals`,
			],
		},
		{
			name: 'setInterval',
			filePath: plantedCorePath,
			sourceText: 'export const poll = (run: () => void) => setInterval(run, 1);\n',
			expected: [
				`${plantedCorePath}:1: sign-in-core runtime global setInterval is not on signInCoreAllowedGlobals`,
			],
		},
		{
			name: 'Math.random()',
			filePath: plantedCorePath,
			sourceText: 'export const pick = Math.random();\n',
			expected: [`${plantedCorePath}:1: sign-in-core runtime global Math.random`],
		},
		{
			name: "Math['random']() by a literal key",
			filePath: plantedCorePath,
			sourceText: "export const draw = () => Math['random']();\n",
			expected: [`${plantedCorePath}:1: sign-in-core runtime global Math.random`],
		},
		{
			name: 'random destructured from Math',
			filePath: plantedCorePath,
			sourceText: 'const { random } = Math;\nexport const draw = () => random();\n',
			expected: [`${plantedCorePath}:1: sign-in-core runtime global Math.random`],
		},
		{
			name: 'random destructured from Math under another name',
			filePath: plantedCorePath,
			sourceText: 'const { random: pick } = Math;\nexport const draw = () => pick();\n',
			expected: [`${plantedCorePath}:1: sign-in-core runtime global Math.random`],
		},
		{
			name: "globalThis['crypto']",
			filePath: plantedCorePath,
			sourceText: "export const host = globalThis['crypto'];\n",
			expected: [`${plantedCorePath}:1: sign-in-core runtime global globalThis`],
		},
		{
			name: "globalThis['fetch']",
			filePath: plantedCorePath,
			sourceText: "export const send = globalThis['fetch'];\n",
			expected: [`${plantedCorePath}:1: sign-in-core runtime global globalThis`],
		},
		{
			name: 'an alias of globalThis',
			filePath: plantedCorePath,
			sourceText: 'const g = globalThis;\nexport const host = g;\n',
			expected: [`${plantedCorePath}:1: sign-in-core runtime global globalThis`],
		},
		{
			name: 'fetch(url)',
			filePath: plantedCorePath,
			sourceText: 'export const send = (url: string) => fetch(url);\n',
			expected: [
				`${plantedCorePath}:1: sign-in-core runtime global fetch is not on signInCoreAllowedGlobals`,
			],
		},
		{
			name: 'fetch passed on in shorthand',
			filePath: plantedCorePath,
			sourceText: 'export const transport = { fetch };\n',
			expected: [
				`${plantedCorePath}:1: sign-in-core runtime global fetch is not on signInCoreAllowedGlobals`,
			],
		},
		{
			name: 'subtle destructured from crypto',
			filePath: plantedCorePath,
			sourceText: 'const { subtle } = crypto;\nexport const host = subtle;\n',
			expected: [
				`${plantedCorePath}:1: sign-in-core runtime global crypto is not on signInCoreAllowedGlobals`,
			],
		},
		{
			name: 'console.log(x)',
			filePath: plantedCorePath,
			sourceText: 'export const show = (value: string) => console.log(value);\n',
			expected: [
				`${plantedCorePath}:1: sign-in-core runtime global console is not on signInCoreAllowedGlobals`,
			],
		},
		{
			name: 'navigator.userAgent',
			filePath: plantedCorePath,
			sourceText: 'export const agent = navigator.userAgent;\n',
			expected: [
				`${plantedCorePath}:1: sign-in-core runtime global navigator is not on signInCoreAllowedGlobals`,
			],
		},
		{
			name: 'queueMicrotask(f)',
			filePath: plantedCorePath,
			sourceText: 'export const later = (run: () => void) => queueMicrotask(run);\n',
			expected: [
				`${plantedCorePath}:1: sign-in-core runtime global queueMicrotask is not on signInCoreAllowedGlobals`,
			],
		},
		{
			name: 'new WebSocket(u)',
			filePath: plantedCorePath,
			sourceText: 'export const open = (url: string) => new WebSocket(url);\n',
			expected: [
				`${plantedCorePath}:1: sign-in-core runtime global WebSocket is not on signInCoreAllowedGlobals`,
			],
		},
		{
			name: "a runtime-only name the core's types don't declare",
			filePath: plantedCorePath,
			sourceText: "export const secret = process.env['X'];\n",
			expected: [
				`${plantedCorePath}:1: sign-in-core runtime name process does not resolve under the core's settings`,
			],
		},
		{
			name: 'a Node import (U23)',
			filePath: plantedCorePath,
			sourceText: "import 'node:fs';\n",
			expected: [`${plantedCorePath}: sign-in-core forbidden import node:fs`],
		},
		{
			name: 'a Node import in a .tsx page (U23)',
			filePath: 'packages/sign-in-core/src/pages/planted-page-slip.tsx',
			sourceText: "import { readFile } from 'node:fs/promises';\nexport const read = readFile;\n",
			expected: [
				'packages/sign-in-core/src/pages/planted-page-slip.tsx: sign-in-core forbidden import node:fs/promises',
			],
		},
		{
			name: 'a Worker import in a browser island (U23)',
			filePath: 'packages/sign-in-core/src/pages/islands/planted-island-slip.tsx',
			sourceText: "import { env } from 'cloudflare:workers';\nexport const bound = env;\n",
			expected: [
				'packages/sign-in-core/src/pages/islands/planted-island-slip.tsx: sign-in-core forbidden import cloudflare:workers',
			],
		},
	])('rejects $name', ({ filePath, sourceText, expected }) => {
		// Arrange / Act
		const violations = auditOne(filePath, sourceText);
		// Assert
		expect(violations).toEqual(expected);
	});

	it.each([
		{
			name: "the host's capability, platform.crypto.getRandomValues",
			filePath: plantedCorePath,
			sourceText:
				'export const draw = (platform: { readonly crypto: { readonly getRandomValues: (bytes: Uint8Array) => Uint8Array } }) =>\n\tplatform.crypto.getRandomValues(new Uint8Array(16));\n',
		},
		{
			name: 'parameters and locals named crypto, fetch, globalThis and process',
			filePath: plantedCorePath,
			sourceText:
				'export function local(crypto: string, fetch: string): string {\n\tconst globalThis = crypto;\n\tconst process = fetch;\n\treturn globalThis + process;\n}\n',
		},
		{
			name: 'an imported name',
			filePath: plantedCorePath,
			sourceText:
				"import { createFleetAdminProofKey as fetch } from '#sign-in-core/central-link/fleet-admin-proof';\nexport const imported = fetch;\n",
		},
		{
			name: 'the language value undefined',
			filePath: plantedCorePath,
			sourceText: 'export const missing = (value: unknown) => value === undefined;\n',
		},
		{
			name: 'the same calls as literal text in a browser-script template',
			filePath: plantedCorePath,
			sourceText:
				'export const script = `<script>fetch(location.href); setTimeout(() => crypto.randomUUID(), Date.now());</script>`;\n',
		},
		{
			name: "a local object's ['random'] and Math['floor'] by a literal key",
			filePath: plantedCorePath,
			sourceText:
				"export const picks = (record: { readonly random: number }) => [record['random'], Math['floor'](1.5)];\n",
		},
		{
			name: "Math's arithmetic destructured, and random from a supplied object",
			filePath: plantedCorePath,
			sourceText:
				'const { floor, max } = Math;\nexport const draw = (supplied: { readonly random: () => number }) => {\n\tconst { random } = supplied;\n\treturn floor(max(random(), 0));\n};\n',
		},
		{
			name: 'new Date(now)',
			filePath: plantedCorePath,
			sourceText: 'export const at = (now: number) => new Date(now);\n',
		},
		{
			name: 'each allowed global in use',
			filePath: plantedCorePath,
			sourceText:
				'export const uses = (value: string) => [new URL(value), new Response(value), JSON.stringify(value), Math.floor(1), btoa(value), new Headers(), new AbortController(), encodeURIComponent(value)];\n',
		},
		{
			name: 'typeof fetch in a type position',
			filePath: plantedCorePath,
			sourceText: 'export type Send = typeof fetch;\n',
		},
		{
			name: 'a browser island using location',
			filePath: 'packages/sign-in-core/src/pages/islands/planted-island-reader.tsx',
			sourceText: 'export const here = location.href;\n',
		},
		{
			name: "a page's intra-core and Better Auth client imports",
			filePath: 'packages/sign-in-core/src/pages/islands/planted-island-reader.tsx',
			sourceText:
				"import { createAuthClient } from 'better-auth/react';\nimport { factorFormScript } from '#sign-in-core/better-auth/factor-form-script';\nexport const client = [createAuthClient, factorFormScript];\n",
		},
		{
			name: 'a core unit test',
			filePath: 'packages/sign-in-core/src/organizations/planted-runtime-slip.unit.test.ts',
			sourceText: 'export const send = (url: string) => fetch(url);\n',
		},
	])('accepts $name', ({ filePath, sourceText }) => {
		expect(auditOne(filePath, sourceText)).toEqual([]);
	});
});

describe('no wall clock in sign-in tests (S7, R33)', () => {
	it.each([
		{
			name: 'setTimeout in a test-support helper',
			filePath: 'packages/sign-in-test-support/src/test-fixtures/planted-wait-helper.ts',
			sourceText: 'export const wait = (run: () => void) => setTimeout(run, 1);\n',
			finding: 'real timer setTimeout',
		},
		{
			name: 'Date.now() in a host e2e test',
			filePath: 'packages/sign-in-test-support/src/planted-clock-read.host.e2e.test.ts',
			sourceText: 'export const now = Date.now();\n',
			finding: 'reads the real clock with Date.now',
		},
		{
			name: 'new Date() in the verify-auth driver',
			filePath: 'scripts/verify-auth/planted-clock-read.ts',
			sourceText: 'export const now = new Date();\n',
			finding: 'reads the real clock with a zero-argument Date',
		},
		{
			name: "setTimeout in a Node host's unit spec",
			filePath: 'packages/sign-in-host-node/src/planted-wait.unit.spec.ts',
			sourceText: 'export const wait = (run: () => void) => setTimeout(run, 1);\n',
			finding: 'real timer setTimeout',
		},
		{
			name: 'performance.now()',
			filePath: 'packages/sign-in-test-support/src/test-fixtures/planted-wait-helper.ts',
			sourceText: 'export const now = performance.now();\n',
			finding: 'reads performance',
		},
		{
			name: 'new Date(performance.timeOrigin) in a fixture',
			filePath: 'packages/sign-in-test-support/src/test-fixtures/planted-wait-helper.ts',
			sourceText:
				'export const month = new Date(performance.timeOrigin).toISOString().slice(0, 7);\n',
			finding: 'reads performance',
		},
		{
			name: 'process.hrtime()',
			filePath: 'packages/sign-in-test-support/src/test-fixtures/planted-wait-helper.ts',
			sourceText: 'export const tick = process.hrtime();\n',
			finding: 'reads the real clock with process.hrtime',
		},
		{
			name: 'setInterval',
			filePath: 'packages/sign-in-test-support/src/test-fixtures/planted-wait-helper.ts',
			sourceText: 'export const poll = (run: () => void) => setInterval(run, 1);\n',
			finding: 'real timer setInterval',
		},
		{
			name: 'typeof setTimeout in a type',
			filePath: 'packages/sign-in-test-support/src/test-fixtures/planted-wait-helper.ts',
			sourceText: 'export type PendingBound = ReturnType<typeof setTimeout>;\n',
			finding: 'real timer setTimeout',
		},
		{
			name: "Date['now']() by a literal key",
			filePath: 'packages/sign-in-test-support/src/test-fixtures/planted-wait-helper.ts',
			sourceText: "export const now = Date['now']();\n",
			finding: 'reads the real clock with Date.now',
		},
		{
			name: "process['hrtime']() by a literal key",
			filePath: 'packages/sign-in-test-support/src/test-fixtures/planted-wait-helper.ts',
			sourceText: "export const tick = process['hrtime']();\n",
			finding: 'reads the real clock with process.hrtime',
		},
		{
			name: "globalThis['setTimeout'] by a literal key",
			filePath: 'packages/sign-in-test-support/src/test-fixtures/planted-wait-helper.ts',
			sourceText: "export const wait = (run: () => void) => globalThis['setTimeout'](run, 1);\n",
			finding: 'real timer setTimeout',
		},
		{
			name: 'globalThis.performance.now() through the global object',
			filePath: 'packages/sign-in-test-support/src/test-fixtures/planted-clock-helper.ts',
			sourceText: 'export const now = globalThis.performance.now();\n',
			finding: 'reads performance',
		},
		{
			name: "self['performance'].timeOrigin by a literal key",
			filePath: 'packages/sign-in-test-support/src/test-fixtures/planted-clock-helper.ts',
			sourceText: "export const origin = self['performance'].timeOrigin;\n",
			finding: 'reads performance',
		},
		{
			name: "window['setInterval'] by a literal key",
			filePath: 'packages/sign-in-test-support/src/test-fixtures/planted-clock-helper.ts',
			sourceText: "export const poll = (run: () => void) => window['setInterval'](run, 1);\n",
			finding: 'real timer setInterval',
		},
		{
			name: 'globalThis.Date.now() through the global object',
			filePath: 'packages/sign-in-test-support/src/test-fixtures/planted-clock-helper.ts',
			sourceText: 'export const read = () => globalThis.Date.now();\n',
			finding: 'reads the real clock with Date.now',
		},
		{
			name: "globalThis.Date['now']() by a literal key",
			filePath: 'packages/sign-in-test-support/src/test-fixtures/planted-clock-helper.ts',
			sourceText: "export const read = () => globalThis.Date['now']();\n",
			finding: 'reads the real clock with Date.now',
		},
		{
			name: 'new globalThis.Date() with no argument',
			filePath: 'packages/sign-in-test-support/src/test-fixtures/planted-clock-helper.ts',
			sourceText: 'export const read = () => new globalThis.Date();\n',
			finding: 'reads the real clock with a zero-argument Date',
		},
		{
			name: 'self.process.hrtime() through the global object',
			filePath: 'packages/sign-in-test-support/src/test-fixtures/planted-clock-helper.ts',
			sourceText: 'export const tick = () => self.process.hrtime();\n',
			finding: 'reads the real clock with process.hrtime',
		},
		{
			name: 'now destructured from Date',
			filePath: 'packages/sign-in-test-support/src/test-fixtures/planted-clock-helper.ts',
			sourceText: 'const { now } = Date;\nexport const read = () => now();\n',
			finding: 'reads the real clock with Date.now',
		},
	])('rejects $name', ({ filePath, sourceText, finding }) => {
		// Arrange / Act
		const violations = auditOne(filePath, sourceText);
		// Assert
		expect(violations).toEqual([`${filePath}:1: sign-in test ${finding}`]);
	});

	it("accepts a local object's performance and setTimeout members", () => {
		// Arrange
		const sourceText = [
			'const metrics = { performance: 1 };',
			'const scheduler: Readonly<Record<string, number>> = { setTimeout: 2 };',
			"export const values = [metrics.performance, metrics['performance'], scheduler['setTimeout']];",
			'',
		].join('\n');
		// Act
		const violations = auditOne(
			'packages/sign-in-test-support/src/test-fixtures/planted-clock-helper.ts',
			sourceText,
		);
		// Assert
		expect(violations).toEqual([]);
	});

	it('accepts a controlled-clock date through the global object and a local Date-like value', () => {
		// Arrange
		const sourceText = [
			"import { controlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-sign-in-clock';",
			'const fixtures = { Date: { now: (): number => 1 } };',
			'export const values = [new globalThis.Date(controlledSignInClock.now()), fixtures.Date.now()];',
			'',
		].join('\n');
		// Act
		const violations = auditOne(
			'packages/sign-in-test-support/src/test-fixtures/planted-clock-helper.ts',
			sourceText,
		);
		// Assert
		expect(violations).toEqual([]);
	});

	it('accepts Vitest fake timers, timer names as strings and a controlled-clock date', () => {
		// Arrange
		const sourceText = [
			"import { vi } from 'vitest';",
			"import { controlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-sign-in-clock';",
			"vi.useFakeTimers({ toFake: ['setTimeout'] });",
			'vi.setSystemTime(controlledSignInClock.now());',
			"vi.spyOn(globalThis, 'setInterval');",
			'vi.advanceTimersByTime(1);',
			'export const at = new Date(controlledSignInClock.now());',
			'',
		].join('\n');
		// Act
		const violations = auditOne(
			'packages/sign-in-test-support/src/planted-controlled-time.host.e2e.test.ts',
			sourceText,
		);
		// Assert
		expect(violations).toEqual([]);
	});
});

describe('UUIDv7 only in the sign-in packages (S12, R32)', () => {
	it.each([
		{
			name: 'crypto.randomUUID() in a host e2e test',
			filePath: 'packages/sign-in-test-support/src/planted-identifier.host.e2e.test.ts',
			sourceText: 'export const id = crypto.randomUUID();\n',
			findings: ['randomUUID'],
		},
		{
			name: 'randomUUID from node:crypto in an owner CLI test',
			filePath: 'packages/sign-in-owner-cli/src/fleet/planted-identifier.unit.test.ts',
			sourceText: "import { randomUUID } from 'node:crypto';\nexport const id = randomUUID();\n",
			findings: ['import randomUUID from node:crypto', 'randomUUID call'],
		},
		{
			name: 'v4 from uuid in test support',
			filePath: 'packages/sign-in-test-support/src/test-fixtures/planted-identifier-source.ts',
			sourceText: "import { v4 } from 'uuid';\nexport const id = v4();\n",
			findings: ['import v4 from uuid'],
		},
		{
			name: 'v1 renamed as uuid in the verify-auth driver',
			filePath: 'scripts/verify-auth/planted-identifier-source.ts',
			sourceText: "import { v1 as uuid } from 'uuid';\nexport const id = uuid();\n",
			findings: ['import v1 from uuid'],
		},
		{
			name: "globalThis.crypto['randomUUID']() in an owner CLI host test",
			filePath: 'packages/sign-in-owner-cli/src/fleet/planted-identifier.host.e2e.test.ts',
			sourceText: "export const draw = () => globalThis.crypto['randomUUID']();\n",
			findings: ['randomUUID'],
		},
		{
			name: 'randomUUID destructured from crypto',
			filePath: 'packages/sign-in-test-support/src/test-fixtures/planted-identifier-source.ts',
			sourceText: 'const { randomUUID } = crypto;\nexport const id = randomUUID;\n',
			findings: ['randomUUID extracted by destructuring'],
		},
		{
			name: 'another UUID package',
			filePath: 'packages/sign-in-test-support/src/test-fixtures/planted-identifier-source.ts',
			sourceText: "import ShortUniqueId from 'short-uuid';\nexport const id = ShortUniqueId;\n",
			findings: ['import of another UUID package short-uuid'],
		},
	])('rejects $name', ({ filePath, sourceText, findings }) => {
		// Arrange / Act
		const violations = auditOne(filePath, sourceText);
		// Assert
		expect(violations).toEqual(
			findings.map(
				(finding, index) => `${filePath}:${index === 0 ? 1 : 2}: sign-in UUIDv7 only: ${finding}`,
			),
		);
	});

	it.each([
		{
			name: 'v7 from uuid in the shared web builder',
			filePath: 'packages/sign-in-platform-web/src/planted-identifier-source.ts',
			sourceText: "import { v7 as uuid7 } from 'uuid';\nexport const id = uuid7();\n",
		},
		{
			name: "the host's ID source",
			filePath: 'packages/sign-in-test-support/src/test-fixtures/planted-identifier-source.ts',
			sourceText:
				'export const id = (platform: { readonly ids: { readonly nextId: () => string } }) => platform.ids.nextId();\n',
		},
		{
			name: 'a computed key, outside this static check',
			filePath: 'packages/sign-in-test-support/src/test-fixtures/planted-identifier-source.ts',
			sourceText:
				'export const pick = (record: Readonly<Record<string, string>>, key: string) => record[key];\n',
		},
		{
			name: 'a literal element access as text in a string',
			filePath: 'packages/sign-in-test-support/src/test-fixtures/planted-identifier-source.ts',
			sourceText: "export const words = `<script>crypto['randomUUID']()</script>`;\n",
		},
		{
			name: "nextId destructured from the host's ID source",
			filePath: 'packages/sign-in-test-support/src/test-fixtures/planted-identifier-source.ts',
			sourceText:
				'export const id = (platform: { readonly ids: { readonly nextId: () => string } }) => {\n\tconst { nextId } = platform.ids;\n\treturn nextId();\n};\n',
		},
		{
			name: 'randomUUID as text in a string',
			filePath: 'packages/sign-in-test-support/src/test-fixtures/planted-identifier-source.ts',
			sourceText: "export const words = 'never call crypto.randomUUID() here';\n",
		},
	])('accepts $name', ({ filePath, sourceText }) => {
		expect(auditOne(filePath, sourceText)).toEqual([]);
	});
});

describe('sign-in source discovery (S7, S12)', () => {
	it('collects a .tsx helper in sign-in test support, and still no .tsx outside the sign-in packages', async () => {
		// Arrange: a repository tree on disk with one in-scope .tsx helper and one out-of-scope page.
		const root = await mkdtemp(path.join(tmpdir(), '2026-11-sign-in-discovery-'));
		const helper = 'packages/sign-in-test-support/src/test-fixtures/clock-helper.tsx';
		const outside = 'packages/tool-portal/src/tool-page/tool-page-view.tsx';
		for (const [relativePath, text] of [
			[
				helper,
				'export const wait = (run: () => void) => setTimeout(run, 1);\nexport const id = crypto.randomUUID();\n',
			],
			[outside, 'export const view = 1;\n'],
		] as const) {
			await mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
			await writeFile(path.join(root, relativePath), text);
		}
		// Act
		const files = await loadRepositorySourceFiles(root);
		const violations = collectPortalArchitectureViolations({ files });
		// Assert
		expect(files.map((file) => file.filePath)).toContain(helper);
		expect(files.map((file) => file.filePath)).not.toContain(outside);
		expect(violations).toEqual([
			`${helper}:1: sign-in test real timer setTimeout`,
			`${helper}:2: sign-in UUIDv7 only: randomUUID`,
		]);
	});
});
