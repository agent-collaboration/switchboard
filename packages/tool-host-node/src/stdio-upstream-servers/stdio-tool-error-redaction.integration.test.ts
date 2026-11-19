import { expect, it, vi } from 'vitest';

import type { UpstreamMcpClientLike } from '#node-host/stdio-upstream-servers/models/stdio-upstream-protocol';
import { createNodeStdioUpstreamRuntime } from '#node-host/stdio-upstream-servers/stdio-upstream-runtime';

it.each([
	{ label: 'isError', secret: 'Error' },
	{ label: 'content', secret: 'on' },
	{ label: 'long exact value before truncation', secret: `opaque-${'s'.repeat(2100)}` },
	{ label: 'exact value before whitespace trimming', secret: ' opaque ' },
])('classifies stdio tool errors and preserves redaction for $label', async ({ secret }) => {
	const client: UpstreamMcpClientLike = {
		callTool: vi.fn(async () => ({
			isError: true,
			content: [{ type: 'text', text: `provider ${secret}` }],
		})),
		close: vi.fn(),
		connect: vi.fn(),
		listTools: vi.fn(async () => ({ tools: [] })),
	};
	const runtime = createNodeStdioUpstreamRuntime({
		createClient: () => client,
		createUpstreamMcpTransport: () => ({
			start: async (): Promise<void> => {},
			send: async (): Promise<void> => {},
			close: async (): Promise<void> => {},
		}),
		servers: [
			{
				namespace: 'fixture',
				transport: 'stdio',
				command: 'synthetic-not-started',
				env: { SYNTHETIC_SECRET: secret },
			},
		],
	});
	try {
		await expect(
			runtime.callTool({
				arguments: {},
				agentScopeId: 'synthetic-scope',
				namespace: 'fixture',
				toolName: 'read',
			}),
		).rejects.toMatchObject({
			details: {
				failureClass: 'tool_error',
				phase: 'call_tool',
				providerErrorMessage: 'provider [REDACTED]',
			},
		});
	} finally {
		await runtime.closeAgentScope('synthetic-scope');
	}
});
