import * as hegel from '@hegeldev/hegel';
import { it } from 'vitest';

import { runAgentRemovalModel } from '#tool-host-core/workspace-authority/test-fixtures/agent-removal-hegel-model';
import { createVolatileAuthorityStore } from '#tool-host-core/workspace-authority/volatile-authority-store';
import { createWorkspaceAuthority } from '#tool-host-core/workspace-authority/workspace-authority';

it('M4 models admission, pending and completed unlink/disable, idempotency and intent conflicts', async () => {
	await hegel.testAsync(
		async (tc) => {
			const authority = createWorkspaceAuthority({
				store: createVolatileAuthorityStore(),
				clock: { nowMs: () => 1_700_000_000_000 },
				cap: 1024,
			});
			await runAgentRemovalModel(tc, authority);
		},
		{ testCases: 100, seed: 20261117, derandomize: true, database: hegel.Database.disabled },
	);
});
