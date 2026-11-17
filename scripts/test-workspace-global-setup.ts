import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const requiredWorkspaceArtifacts = [
	'packages/agent-portal-sdk/dist/index.js',
	'packages/agent-portal-sdk/dist/generated-tools/index.js',
	'packages/sign-in-core/dist/index.js',
	'packages/sign-in-host-cloudflare/dist/index.js',
	'packages/config-contracts/dist/index.js',
	'packages/oauth-approval-ui/dist/index.js',
	'packages/oauth-broker-contracts/dist/index.js',
	'packages/oauth-broker/dist/index.js',
	'packages/tool-access/dist/contracts/index.js',
	'packages/tool-engine/dist/capability-dispatch/index.js',
	'packages/tool-host-core/dist/index.js',
	'packages/tool-host-node/dist/index.js',
	'packages/tool-host-node/dist/bin/tool-host-node.js',
	'packages/tool-host-cloudflare/dist/index.js',
] as const;

/** Keep tests that consume built packages from silently running against missing artifacts. */
export function setup(): void {
	const missingArtifacts = requiredWorkspaceArtifacts.filter(
		(artifact) => !existsSync(path.resolve(repositoryRoot, artifact)),
	);
	if (missingArtifacts.length > 0) {
		throw new Error(
			`Run pnpm build before tests. Missing artifacts: ${missingArtifacts.join(', ')}`,
		);
	}
}
