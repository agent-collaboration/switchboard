import { StringDecoder } from 'node:string_decoder';

import {
	createCredentialTextRedactor,
	type UpstreamMcpRuntimeOptions,
} from '@agent-collaboration/tool-engine/upstream-mcp-connectors';
import {
	SSEClientTransport,
	StreamableHTTPClientTransport,
	type Transport,
} from '@modelcontextprotocol/client';
import type { JSONRPCMessage } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

import type {
	NormalizedUpstreamMcpServer,
	UpstreamMcpRuntimeOptions as StdioRuntimeOptions,
} from '#node-host/stdio-upstream-servers/models/stdio-upstream-protocol';

const inheritedStdioRuntimeEnvNames = [
	'NODE_EXTRA_CA_CERTS',
	'NODE_OPTIONS',
	'REQUESTS_CA_BUNDLE',
	'SSL_CERT_FILE',
	'UV_CACHE_DIR',
] as const;

export function withNodeStdioEnvironment(
	server: NormalizedUpstreamMcpServer,
): NormalizedUpstreamMcpServer {
	const inheritedEnv: Record<string, string> = {};
	for (const name of inheritedStdioRuntimeEnvNames) {
		const value = process.env[name];
		if (value !== undefined && value.length > 0) inheritedEnv[name] = value;
	}
	return { ...server, env: { ...inheritedEnv, ...server.env } };
}

export const createNodeHttpUpstreamTransport: UpstreamMcpRuntimeOptions['createUpstreamMcpTransport'] =
	(server, transport) => {
		const url = new URL(server.url);
		if (transport === 'sse')
			return withOrderedUpstreamMessages(
				new SSEClientTransport(url, {
					...(server.eventSourceInit === undefined
						? {}
						: { eventSourceInit: server.eventSourceInit }),
					...(server.requestInit === undefined ? {} : { requestInit: server.requestInit }),
				}),
			);
		return new StreamableHTTPClientTransport(
			url,
			server.requestInit === undefined ? {} : { requestInit: server.requestInit },
		);
	};

export function createNodeStdioUpstreamTransport(
	props: {
		readonly stderr?: (text: string) => void;
	} = {},
): StdioRuntimeOptions['createUpstreamMcpTransport'] {
	return (server) => {
		const env = server.env ?? {};
		const decoder = new StringDecoder('utf8');
		const redactor = createCredentialTextRedactor({ exactValues: Object.values(env) });
		let finished = false;
		const deliver = (text: string): void => {
			if (text.length > 0) props.stderr?.(text);
		};
		const finish = (): void => {
			if (finished) return;
			finished = true;
			deliver(redactor.write(decoder.end()));
			deliver(redactor.end());
		};
		const transport = new StdioClientTransport({
			command: server.command,
			...(server.args === undefined ? {} : { args: [...server.args] }),
			...(server.cwd === undefined ? {} : { cwd: server.cwd }),
			env,
			stderr: 'pipe',
		});
		transport.stderr?.on('data', (chunk: Buffer | string): void => {
			if (!finished && props.stderr !== undefined)
				deliver(
					redactor.write(decoder.write(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)),
				);
		});
		transport.stderr?.once('end', finish);
		transport.stderr?.once('close', finish);
		const orderedTransport = withOrderedStdioMessages(transport);
		const closeTransport = orderedTransport.close.bind(orderedTransport);
		orderedTransport.close = async (): Promise<void> => {
			try {
				await closeTransport();
			} finally {
				finish();
			}
		};
		return orderedTransport;
	};
}

function withOrderedUpstreamMessages(transport: Transport): Transport {
	let deliveries = Promise.resolve();
	const orderedTransport: Transport = {
		start: async () => {
			Object.assign(transport, {
				onmessage: (message: JSONRPCMessage): void => {
					// SDK 1.29 defers notification handlers. Preserve wire order across
					// their microtasks before a coalesced result removes the progress token.
					deliveries = deliveries
						.then(() => {
							orderedTransport.onmessage?.(message);
						})
						.catch((error: unknown) => {
							orderedTransport.onerror?.(
								error instanceof Error ? error : new Error('Upstream message delivery failed.'),
							);
						});
				},
				onerror: (error: Error): void => orderedTransport.onerror?.(error),
				onclose: (): void => {
					void deliveries.then(() => orderedTransport.onclose?.());
				},
			});
			await transport.start();
		},
		send: async (message, options) => transport.send(message, options),
		...(transport.setProtocolVersion === undefined
			? {}
			: { setProtocolVersion: (version: string): void => transport.setProtocolVersion?.(version) }),
		close: async () => {
			await transport.close();
			await deliveries;
		},
	};
	return orderedTransport;
}

/** Preserve the SDK base instance: auto negotiation owns the disposable probe child. */
function withOrderedStdioMessages(transport: StdioClientTransport): StdioClientTransport {
	const startTransport = transport.start.bind(transport);
	const closeTransport = transport.close.bind(transport);
	let deliveries = Promise.resolve();
	transport.start = async () => {
		const onmessage = transport.onmessage;
		const onclose = transport.onclose;
		Object.assign(transport, {
			onmessage: (message: JSONRPCMessage): void => {
				deliveries = deliveries
					.then(() => {
						onmessage?.(message);
					})
					.catch((error: unknown) => {
						transport.onerror?.(
							error instanceof Error ? error : new Error('Upstream message delivery failed.'),
						);
					});
			},
			onclose: (): void => {
				void deliveries.then(() => onclose?.());
			},
		});
		await startTransport();
	};
	transport.close = async () => {
		await closeTransport();
		await deliveries;
	};
	return transport;
}
