import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
	agentRemovalSchema,
	type AgentManagementAuthority,
} from '@agent-collaboration/tool-host-core';
import * as hegel from '@hegeldev/hegel';
import { afterAll, beforeAll, it, expect } from 'vitest';
import { unstable_dev, type Unstable_DevWorker } from 'wrangler';
import { z } from 'zod';

import { startWorkerdSocketGuard } from '#worker-host/test-fixtures/workerd-socket-guard';

import { runAgentRemovalModel } from '../../../tool-host-core/src/workspace-authority/test-fixtures/agent-removal-hegel-model';

let worker: Unstable_DevWorker | undefined;
let guard: ReturnType<typeof startWorkerdSocketGuard> | undefined;
let stateDirectory: string | undefined;
const previousEnvironment = {
	registry: process.env.WRANGLER_REGISTRY_PATH,
	log: process.env.WRANGLER_LOG_PATH,
	metrics: process.env.WRANGLER_SEND_METRICS,
};

beforeAll(async () => {
	guard = startWorkerdSocketGuard();
	stateDirectory = await realpath(await mkdtemp(path.join(tmpdir(), '2026-11-m4-hegel-')));
	process.env.WRANGLER_REGISTRY_PATH = path.join(stateDirectory, 'registry');
	process.env.WRANGLER_LOG_PATH = path.join(stateDirectory, 'wrangler.log');
	process.env.WRANGLER_SEND_METRICS = 'false';
	worker = await unstable_dev(
		'packages/tool-host-cloudflare/src/test-fixtures/agent-removal-proof-entrypoint.ts',
		{
			config: 'packages/tool-host-cloudflare/wrangler.example.jsonc',
			local: true,
			persist: true,
			persistTo: stateDirectory,
			logLevel: 'error',
			experimental: { disableExperimentalWarning: true },
		},
	);
});

afterAll(async () => {
	try {
		await guard?.stop();
	} finally {
		try {
			await worker?.stop();
		} finally {
			for (const [key, value] of [
				['WRANGLER_REGISTRY_PATH', previousEnvironment.registry],
				['WRANGLER_LOG_PATH', previousEnvironment.log],
				['WRANGLER_SEND_METRICS', previousEnvironment.metrics],
			] as const) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			if (stateDirectory !== undefined) await rm(stateDirectory, { recursive: true, force: true });
		}
	}
});

function durableAuthority(workspaceId: string): AgentManagementAuthority {
	async function control(input: Readonly<Record<string, unknown>>): Promise<unknown> {
		if (worker === undefined) throw new Error('Removal proof worker was not started');
		guard?.check();
		const response = await worker.fetch('/', {
			method: 'POST',
			body: JSON.stringify({ workspaceId, ...input }),
		});
		if (response.status === 409) {
			const refused = z.strictObject({ message: z.string() }).parse(await response.json());
			throw new Error(refused.message);
		}
		expect(response.status).toBe(200);
		return response.json();
	}
	return {
		readMembership: async (clientId) =>
			z
				.strictObject({ persona: z.string().min(1) })
				.nullable()
				.parse(await control({ kind: 'read-membership', clientId })),
		readAgentRemoval: async (clientId) =>
			agentRemovalSchema.nullable().parse(await control({ kind: 'read-removal', clientId })),
		setMembership: async (clientId, persona) => {
			await control({ kind: 'admit', clientId, persona });
		},
		beginAgentRemoval: async (clientId, requestId, intent) =>
			agentRemovalSchema.parse(await control({ kind: 'begin', clientId, requestId, intent })),
		completeAgentRemoval: async (clientId, requestId, operation) => {
			await control({ kind: 'complete', clientId, requestId, operation });
		},
	};
}

it('M4 keeps admission, unlink/disable, idempotency and conflicts through real Durable Object transactions', async () => {
	let scenarioNumber = 0;
	await hegel.testAsync(
		async (tc) => {
			// Unique synthetic UUIDv7 namespace for every execution, including shrink replays.
			// Allocation is isolation only and never an input to the independent oracle.
			scenarioNumber += 1;
			const workspaceId = `019a9310-0000-7000-9000-${scenarioNumber.toString(16).padStart(12, '0')}`;
			tc.note(`isolated workspace ${workspaceId}`);
			await runAgentRemovalModel(tc, durableAuthority(workspaceId));
		},
		{ testCases: 100, seed: 20261117, derandomize: true, database: hegel.Database.disabled },
	);
});
