import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const repositoryRoot = path.dirname(fileURLToPath(import.meta.url));

function repoPath(relativePath: string): string {
	return path.resolve(repositoryRoot, relativePath);
}

function loadDotEnvLocal(): void {
	const envLocalPath = repoPath('.env.local');
	if (!fs.existsSync(envLocalPath)) {
		return;
	}

	for (const line of fs.readFileSync(envLocalPath, 'utf8').split('\n')) {
		const trimmedLine = line.trim();
		if (trimmedLine.length === 0 || trimmedLine.startsWith('#') || !trimmedLine.includes('=')) {
			continue;
		}

		const delimiterIndex = trimmedLine.indexOf('=');
		const key = trimmedLine.slice(0, delimiterIndex).trim();
		const value = trimmedLine.slice(delimiterIndex + 1).trim();
		if (key.length > 0 && process.env[key] === undefined) {
			process.env[key] = value;
		}
	}
}

loadDotEnvLocal();

export default defineConfig({
	resolve: {
		alias: {
			'@auth-ui': repoPath('packages/auth-ui/src'),
			'@tool-access-ui': repoPath('packages/tool-access-ui/src'),
			'@agent-collaboration/tool-engine/standalone-tool-portal': repoPath(
				'packages/tool-engine/src/standalone-tool-portal/index.ts',
			),
			'@agent-collaboration/tool-engine/mcp-gateway': repoPath(
				'packages/tool-engine/src/mcp-gateway/index.ts',
			),
			'@agent-collaboration/tool-engine/upstream-mcp-connectors': repoPath(
				'packages/tool-engine/src/upstream-mcp-connectors/index.ts',
			),
			'@agent-collaboration/config-contracts-test-support': repoPath(
				'packages/config-contracts/src',
			),
			'@agent-collaboration/tool-engine/capability-dispatch': repoPath(
				'packages/tool-engine/src/capability-dispatch/index.ts',
			),
			'@agent-collaboration/tool-access/contracts': repoPath(
				'packages/tool-access/src/contracts/index.ts',
			),
			'@agent-collaboration/tool-access/authorization': repoPath(
				'packages/tool-access/src/authorization/index.ts',
			),
			'@agent-collaboration/agent-portal-sdk/generated-tools': repoPath(
				'packages/agent-portal-sdk/src/generated-tools/index.ts',
			),
			'@agent-collaboration/agent-portal-sdk/contracts': repoPath(
				'packages/agent-portal-sdk/src/contracts/index.ts',
			),
			'@agent-collaboration/agent-portal-sdk/gateway-runtime-client': repoPath(
				'packages/agent-portal-sdk/src/gateway-runtime-client/index.ts',
			),
			'@agent-collaboration/agent-portal-sdk/gateway-runtime-local-exec': repoPath(
				'packages/agent-portal-sdk/src/gateway-runtime-local-exec/index.ts',
			),
			'@agent-collaboration/agent-portal-sdk/tool-portal-mcp-client/node-transport': repoPath(
				'packages/agent-portal-sdk/src/tool-portal-mcp-client/node-tool-portal-mcp-transport.ts',
			),
			'@agent-collaboration/agent-portal-sdk/tool-portal-mcp-client': repoPath(
				'packages/agent-portal-sdk/src/tool-portal-mcp-client/index.ts',
			),
			'@agent-collaboration/agent-portal-sdk': repoPath('packages/agent-portal-sdk/src/index.ts'),
			'@agent-collaboration/agent-portal-sdk/adapter-boundary': repoPath(
				'packages/agent-portal-sdk/src/adapter-boundary/index.ts',
			),
			'@agent-collaboration/agent-portal-sdk/approval-surface': repoPath(
				'packages/agent-portal-sdk/src/approval-surface/index.ts',
			),
			'@agent-collaboration/agent-portal-sdk/artifact-surface': repoPath(
				'packages/agent-portal-sdk/src/artifact-surface/index.ts',
			),
			'@agent-collaboration/agent-portal-sdk/capability-description-surface': repoPath(
				'packages/agent-portal-sdk/src/capability-description-surface/index.ts',
			),
			'@agent-collaboration/agent-portal-sdk/portal-call-surface': repoPath(
				'packages/agent-portal-sdk/src/portal-call-surface/index.ts',
			),
			'@agent-collaboration/agent-portal-sdk/portal-event-surface': repoPath(
				'packages/agent-portal-sdk/src/portal-event-surface/index.ts',
			),
			'@agent-collaboration/agent-portal-sdk/testing': repoPath(
				'packages/agent-portal-sdk/src/testing/index.ts',
			),
			'@agent-collaboration/config-contracts': repoPath('packages/config-contracts/src/index.ts'),
			'@agent-collaboration/tool-host-node/testing/fake-upstream-mcp-server': repoPath(
				'packages/tool-host-node/src/testing/fake-upstream-mcp-server.ts',
			),
		},
	},
	test: {
		globals: true,
		environment: 'node',
		testTimeout: 300_000,
		hookTimeout: 120_000,
		pool: 'forks',
		fileParallelism: true,
		maxWorkers: '75%',
		exclude: ['**/node_modules/**'],
		tags: [
			{
				name: 'managed-gateway-startup',
				description: 'Managed Gateway image boot and stock-image boundary proofs.',
			},
			{
				name: 'managed-gateway-degraded-input',
				description: 'Managed Gateway behavior when one or more boot inputs are unusable.',
			},
			{
				name: 'managed-gateway-lifecycle',
				description: 'Managed Gateway sibling process termination and containment proofs.',
			},
		],
		globalSetup: [repoPath('scripts/test-workspace-global-setup.ts')],
		projects: [
			{
				extends: true,
				test: {
					name: 'e2e-deployed',
					include: ['packages/**/*.deployed.e2e.test.ts'],
					globalSetup: [],
					fileParallelism: false,
					maxWorkers: 1,
					testTimeout: 300_000,
				},
			},
			{
				extends: true,
				test: {
					name: 'unit',
					pool: 'threads',
					include: [
						'packages/**/*.unit.test.ts',
						'packages/**/*.unit.spec.ts',
						'scripts/**/*.unit.test.ts',
					],
					exclude: [
						'**/node_modules/**',
						'**/*.integration.test.ts',
						'**/*.e2e.test.ts',
						'**/tests/integration/**',
						'**/tests/e2e/**',
					],
					maxWorkers: '75%',
				},
			},
			{
				extends: true,
				test: {
					name: 'integration',
					pool: 'threads',
					include: ['packages/**/*.integration.test.ts'],
					exclude: ['**/node_modules/**', '**/*.e2e.test.ts'],
					maxWorkers: '50%',
				},
			},
			{
				extends: true,
				test: {
					name: 'e2e-host',
					include: ['packages/**/*.host.e2e.test.ts'],
					testTimeout: 900_000,
					hookTimeout: 300_000,
					maxWorkers: '50%',
				},
			},
		],
	},
});
